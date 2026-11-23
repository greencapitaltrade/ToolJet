import {
  ApplicantFury,
  ApplicantScope,
  applicantScope,
  exactHttpsOrigin,
  normalizeApplicantPhone,
  rejectApplicant,
} from '../applicant-session/fury';
import { ApplicantRedis, ApplicantSessions, newApplicantHandle } from '../applicant-session/store';
import { dealerDossierInput, requestDealerDossier } from './dossier';
import { dealerProviderRedirect, parseDealerParticipantConfig } from './participant';
import { dealerSelfieData } from './selfie';

export const DEALER_ONBOARDING_ENV = 'TOOLJET_DEALER_ONBOARDING';
export const DEALER_OWNER_KYC_ORIGIN = 'TOOLJET_DEALER_OWNER_KYC_ORIGIN';
const tokenPattern = /^v2[.][A-Za-z0-9_-]{39,1021}$/;
const panPattern = /^[A-Z]{3}[CFP][A-Z][0-9]{4}[A-Z]$/;
const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fieldLimits = { businessName: 255, applicantName: 255, applicantRole: 30, email: 254, gstin: 15, firmType: 20 };
const entityFieldNames = ['premises', 'cin', 'llpin'];
const guestTtl = 600;
type Payload = Record<string, unknown>;
type Fields = Record<string, string>;
type DealerScope = ApplicantScope & { signingOrigin?: string };
type State = {
  referral: string;
  device: string;
  phone?: string;
  auth?: { token: string };
  pan?: string;
  draftId?: string;
};
type VerifiedOwner = State & { phone: string };
type SetCookie = (id: string, ttl: number) => void;
export type OwnerKycScope = ApplicantScope & { kycOrigin?: string };
const ownerKycActions = ['START', 'SYNC', 'SELFIE'];
const ownerKycStatuses = ['not_started', 'pending', 'verified', 'failed', 'cancelled', 'unknown', 'requesting'];
const ownerKycQuery = {
  field: 'dealerOwnerKyc',
  timeoutMs: 52_000,
  query: `mutation DealerOwnerKyc($referralToken: String!, $draftId: ID!, $action: DealerOwnerKycAction!, $version: Int, $selfie: String) {
    dealerOwnerKyc(referralToken: $referralToken, draftId: $draftId, action: $action, version: $version, selfie: $selfie) {
      status version actions redirectUrl
    }
  }`,
};

const draftSelection = 'id status nextStep canWrite entityFields version documentActions { code label mode count }';
export const maxDealerDocumentBytes = 10 * 1024 * 1024;
type DocumentMode = 'pdf' | 'photo' | 'camera' | 'file';
type DocumentAction = { code: string; label: string; mode: DocumentMode; count: number };
type DealerAction =
  | { name: 'saveEntityDetails'; fields: string[] }
  | { name: 'attachDocument'; documents: DocumentAction[] };
const documentModes: readonly string[] = ['pdf', 'photo', 'camera', 'file'];
const completionOperations = {
  agreementStatus: 'STATUS',
  prepareAgreement: 'PREPARE',
  verifyBank: 'VERIFY_BANK',
  freezeAgreement: 'FREEZE',
  refreshSignatures: 'REFRESH',
  signOwnerAgreement: 'SIGN',
  submitForReview: 'SUBMIT',
} as const;
const completionStages = {
  evidence_required: null,
  evidence_ready: 'prepareAgreement',
  review_pending: null,
  bank_details_required: null,
  bank_verification_required: 'verifyBank',
  agreement_ready: 'freezeAgreement',
  agreement_unavailable: null,
  signing_pending: 'refreshSignatures',
  ready_to_submit: 'submitForReview',
  submitted: null,
  closed: null,
} as const;
type CompletionOperation = keyof typeof completionOperations;
const docs = {
  eligibility: {
    field: 'dealerReferralEligibility',
    query: `mutation DealerCheck($referral_token: String!) {
    dealerReferralEligibility(referral_token: $referral_token) { organizationId eligible }
  }`,
  },
  lookup: {
    field: 'dealerPanLookup',
    query: `mutation DealerLookup($referral_token: String!, $pan: String!) {
    dealerPanLookup(referral_token: $referral_token, pan: $pan) { status category draft { ${draftSelection} } }
  }`,
  },
  start: {
    field: 'dealerIntakeStart',
    query: `mutation DealerStart($referral_token: String!, $input: DealerIntakeStartInput!) {
    dealerIntakeStart(referral_token: $referral_token, input: $input) { ${draftSelection} }
  }`,
  },
  participant: {
    field: 'dealerOwnerParticipant',
    query: `mutation DealerOwnerParticipant($referralToken: String!, $draftId: ID!, $action: DealerOwnerParticipantAction!, $fields: JSON) {
      dealerOwnerParticipant(referralToken: $referralToken, draftId: $draftId, action: $action, fields: $fields) {
        status id version consents { id status name role }
      }
    }`,
  },
  completion: {
    field: 'dealerOwnerCompletion',
    query: `mutation DealerOwnerCompletion($referralToken: String!, $draftId: ID!, $action: DealerOwnerCompletionAction!, $version: Int) {
      dealerOwnerCompletion(referralToken: $referralToken, draftId: $draftId, action: $action, version: $version) {
        stage version actions signingUrl
      }
    }`,
  },
  entity: {
    field: 'dealerEntityDetailsSave',
    query: `mutation DealerEntity($referral_token: String!, $pan: String!, $fields: DealerEntityDetailsInput!) {
      dealerEntityDetailsSave(referral_token: $referral_token, pan: $pan, fields: $fields) { ${draftSelection} }
    }`,
  },
};

function object(value: unknown): value is Payload {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseDealerOnboardingConfig(
  value: string | undefined,
  participant?: ReturnType<typeof parseDealerParticipantConfig>
): DealerScope | null {
  try {
    const raw = JSON.parse(value ?? 'null');
    const scope = object(raw) && Object.keys(raw).length === 4 ? applicantScope(raw) : null;
    if (
      scope &&
      participant?.origin === scope.origin &&
      participant.organizationId === scope.organizationId &&
      participant.furyUrl === scope.furyUrl
    )
      return { ...scope, signingOrigin: participant.signingOrigin };
    return scope;
  } catch {
    return null;
  }
}

type Operation =
  | { kind: 'entry'; referral?: string }
  | { kind: 'status' }
  | { kind: 'requestOtp'; phone: string }
  | { kind: 'verifyOtp'; otp: string }
  | { kind: 'lookup'; pan: string }
  | { kind: 'saveEntityDetails'; fields: Fields }
  | { kind: 'start'; fields: Fields }
  | { kind: 'completion'; operation: CompletionOperation }
  | { kind: 'ownerParticipant'; action: 'INVITE' | 'LIST' | 'ACCEPT'; fields: Payload };

function operation(value: unknown): Operation {
  if (
    !object(value) ||
    !object(value.fields) ||
    Object.keys(value).some((key) => !['operation', 'fields', 'referralToken'].includes(key))
  )
    return rejectApplicant(400);
  const fields = value.fields;
  const keys = Object.keys(fields);
  if (value.operation === 'entry' && !keys.length) {
    if (value.referralToken === undefined) return { kind: 'entry' };
    if (typeof value.referralToken === 'string' && tokenPattern.test(value.referralToken))
      return { kind: 'entry', referral: value.referralToken };
  }
  if ('referralToken' in value) return rejectApplicant(400);
  if (value.operation === 'status' && !keys.length) return { kind: 'status' };
  if (
    !keys.length &&
    typeof value.operation === 'string' &&
    Object.prototype.hasOwnProperty.call(completionOperations, value.operation)
  )
    return { kind: 'completion', operation: value.operation as CompletionOperation };
  if (value.operation === 'requestOtp' && keys.length === 1) {
    const phone = normalizeApplicantPhone(fields.phone);
    if (phone) return { kind: 'requestOtp', phone };
  }
  if (
    value.operation === 'verifyOtp' &&
    keys.length === 1 &&
    typeof fields.otp === 'string' &&
    /^[0-9]{4,8}$/.test(fields.otp)
  )
    return { kind: 'verifyOtp', otp: fields.otp };
  if (value.operation === 'inviteParticipant' && keys.length === 1) {
    const mobile = normalizeApplicantPhone(fields.mobile);
    if (mobile) return { kind: 'ownerParticipant', action: 'INVITE', fields: { mobile } };
  }
  if (value.operation === 'participantRequests' && !keys.length)
    return { kind: 'ownerParticipant', action: 'LIST', fields: {} };
  if (
    value.operation === 'acceptParticipant' &&
    keys.length === 2 &&
    typeof fields.consentId === 'string' &&
    uuidPattern.test(fields.consentId) &&
    Number.isSafeInteger(fields.version) &&
    Number(fields.version) > 0
  )
    return { kind: 'ownerParticipant', action: 'ACCEPT', fields };
  if (value.operation === 'lookup' && keys.length === 1 && typeof fields.pan === 'string') {
    const pan = fields.pan.trim().toUpperCase();
    if (panPattern.test(pan)) return { kind: 'lookup', pan };
  }
  if (
    value.operation === 'saveEntityDetails' &&
    ['owned', 'leased'].includes(String(fields.premises)) &&
    keys.every((key) => entityFieldNames.includes(key) && typeof fields[key] === 'string' && fields[key].length <= 21)
  )
    return { kind: 'saveEntityDetails', fields: fields as Fields };
  if (
    value.operation === 'start' &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(fieldLimits, key) &&
        typeof fields[key] === 'string' &&
        fields[key].length <= fieldLimits[key]
    ) &&
    ['businessName', 'applicantName', 'applicantRole', 'email', 'gstin'].every(
      (key) => typeof fields[key] === 'string' && fields[key].trim()
    )
  )
    return { kind: 'start', fields: fields as Fields };
  return rejectApplicant(400);
}

function validCameraLocation(value: unknown) {
  if (!object(value) || Object.keys(value).length !== 4) return false;
  const { latitude, longitude, accuracy, captured_at } = value;
  const age = typeof captured_at === 'string' ? Date.now() - Date.parse(captured_at) : NaN;
  return (
    typeof latitude === 'number' &&
    Math.abs(latitude) <= 90 &&
    typeof longitude === 'number' &&
    Math.abs(longitude) <= 180 &&
    typeof accuracy === 'number' &&
    Number.isFinite(accuracy) &&
    accuracy > 0 &&
    Number.isFinite(age) &&
    age >= -5000 &&
    age <= 60_000
  );
}

function validDocument(mode: DocumentMode, bytes: Buffer, location: unknown) {
  const pdf = bytes.subarray(0, 5).toString() === '%PDF-';
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mode === 'camera') return jpeg && bytes.length <= 96 * 1024 && validCameraLocation(location);
  if (location !== undefined) return false;
  if (mode === 'pdf') return pdf;
  return jpeg || png || (mode === 'file' && pdf);
}

function draftView(value: unknown, expectedId?: string) {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !uuidPattern.test(value.id) ||
    (expectedId && value.id !== expectedId) ||
    typeof value.status !== 'string' ||
    !/^[a-z_]{1,32}$/.test(value.status) ||
    !['details', 'documents', 'agreement', 'review'].includes(String(value.nextStep)) ||
    typeof value.canWrite !== 'boolean'
  )
    return rejectApplicant(503);
  const { id, status, nextStep, canWrite } = value;
  const fields = value.entityFields;
  const canEditEntity =
    canWrite &&
    nextStep === 'details' &&
    Array.isArray(fields) &&
    fields[0] === 'premises' &&
    fields.length <= 2 &&
    new Set(fields).size === fields.length &&
    fields.every((key) => entityFieldNames.includes(key));
  const actions: DealerAction[] = canEditEntity ? [{ name: 'saveEntityDetails', fields: fields as string[] }] : [];
  const version = value.version;
  const docs: DocumentAction[] =
    canWrite &&
    ['details', 'documents'].includes(nextStep as string) &&
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version > 0 &&
    Array.isArray(value.documentActions)
      ? value.documentActions.slice(0, 40).flatMap((item) => {
          if (!object(item)) return [];
          const { code, label, mode, count } = item;
          return typeof code === 'string' &&
            /^[a-z_]{1,64}$/.test(code) &&
            typeof label === 'string' &&
            label.length <= 160 &&
            typeof mode === 'string' &&
            documentModes.includes(mode) &&
            typeof count === 'number' &&
            Number.isInteger(count) &&
            count >= 0 &&
            count <= 24
            ? [{ code, label, mode: mode as DocumentMode, count }]
            : [];
        })
      : [];
  if (docs.length) actions.push({ name: 'attachDocument', documents: docs });
  return {
    state: 'draft' as const,
    draft: { id, status, nextStep, canWrite, ...(docs.length ? { version: version as number } : {}) },
    actions,
    continuationAvailable: actions.length > 0,
  };
}

function completionView(value: unknown, signingOrigin?: string) {
  if (
    !object(value) ||
    typeof value.stage !== 'string' ||
    !Object.prototype.hasOwnProperty.call(completionStages, value.stage) ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Array.isArray(value.actions)
  )
    return rejectApplicant(503);
  const stage = value.stage as keyof typeof completionStages;
  const allowed = completionStages[stage];
  const ownSign = stage === 'signing_pending' && value.actions[1] === 'SIGN';
  if (
    allowed
      ? value.actions.length !== (ownSign ? 2 : 1) || value.actions[0] !== completionOperations[allowed]
      : value.actions.length !== 0
  )
    return rejectApplicant(503);
  return {
    version: value.version,
    view: {
      state: 'dealerCompletion' as const,
      stage,
      actions: [...(allowed ? [allowed] : []), ...(ownSign && signingOrigin ? ['signOwnerAgreement'] : [])],
    },
  };
}

export class DealerOnboarding {
  private readonly fury: ApplicantFury;
  private readonly sessions: ApplicantSessions<State>;

  constructor(
    redis: ApplicantRedis,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.fury = new ApplicantFury(fetcher);
    this.sessions = new ApplicantSessions(redis, 'dealer');
  }

  private async eligible(scope: ApplicantScope, referral: string) {
    try {
      const result = await this.fury.request(scope, docs.eligibility, { referral_token: referral });
      return result.eligible === true && result.organizationId === scope.organizationId;
    } catch {
      return false;
    }
  }

  private async lookup(scope: ApplicantScope, state: State, key: string, pan: string) {
    const result = await this.fury.request(scope, docs.lookup, { referral_token: state.referral, pan }, state);
    if (result.status === 'resume') {
      const view = draftView(result.draft, state.draftId);
      if (!state.draftId) await this.sessions.save(key, { ...state, pan, draftId: view.draft.id });
      return view;
    }
    if (
      state.draftId ||
      result.status !== 'new' ||
      result.category !== { C: 'company', F: 'firm', P: 'proprietorship' }[pan[3]]
    )
      return rejectApplicant(503);
    if (pan !== state.pan) await this.sessions.save(key, { ...state, pan });
    return { state: 'details' as const, category: result.category };
  }

  private async status(scope: ApplicantScope, state: State, key: string) {
    if (!state.auth) return { state: state.phone ? 'otp' : 'phone' };
    if (!state.pan) return { state: 'pan' };
    return this.lookup(scope, state, key, state.pan);
  }

  private async completion(scope: DealerScope, state: State, operation: CompletionOperation) {
    if (!state.draftId || !state.phone) return rejectApplicant(409);
    await this.sessions.rate(scope, 'owner-completion', state.phone, 20, 60);
    const subject = { referralToken: state.referral, draftId: state.draftId };
    const current = completionView(
      await this.fury.request(scope, docs.completion, { ...subject, action: 'STATUS' }, state),
      scope.signingOrigin
    );
    const action = completionOperations[operation];
    if (action === 'STATUS') return current.view;
    if (!current.view.actions.some((allowed) => allowed === operation)) return rejectApplicant(409);
    const result = await this.fury.request(
      scope,
      docs.completion,
      { ...subject, action, version: current.version },
      state
    );
    const { view } = completionView(result, scope.signingOrigin);
    if (action !== 'SIGN') return view;
    if (view.stage !== 'signing_pending' || !view.actions.includes(operation)) return rejectApplicant(503);
    return { ...view, signingUrl: dealerProviderRedirect(result.signingUrl, scope.signingOrigin) };
  }

  async dossier(scope: ApplicantScope, body: unknown, id: string | undefined) {
    const input = dealerDossierInput(body);
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(409);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state?.auth || !state.phone || !state.draftId) return rejectApplicant(409);
      await this.sessions.rate(scope, 'owner-dossier', state.phone, 20, 60);
      return requestDealerDossier(
        scope,
        { referralToken: state.referral, draftId: state.draftId, device: state.device, token: state.auth.token },
        input,
        this.fetcher
      );
    });
  }

  private async withOwnerKyc(
    scope: OwnerKycScope,
    id: string | undefined,
    run: (state: VerifiedOwner, binding: { draftId: string; referralToken: string }, origin: string) => Promise<unknown>
  ) {
    const origin = scope.kycOrigin;
    if (!exactHttpsOrigin(origin)) return rejectApplicant(404);
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(409);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state?.auth || !state.phone || !state.draftId) return rejectApplicant(409);
      await this.sessions.rate(scope, 'owner-kyc', state.phone, 30, 60);
      return run({ ...state, phone: state.phone }, { draftId: state.draftId, referralToken: state.referral }, origin);
    });
  }

  private async ownerKycStatus(scope: OwnerKycScope, state: State, binding: Payload) {
    const current = await this.fury.request(
      scope,
      { ...ownerKycQuery, timeoutMs: 7500 },
      { ...binding, action: 'STATUS' },
      state
    );
    const { status, actions, version } = current;
    if (
      typeof status !== 'string' ||
      !ownerKycStatuses.includes(status) ||
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !Array.isArray(actions) ||
      actions.length > ownerKycActions.length ||
      new Set(actions).size !== actions.length ||
      !actions.every((action) => ownerKycActions.includes(action))
    )
      return rejectApplicant(503);
    return { status, actions, version };
  }

  async ownerKyc(scope: OwnerKycScope, input: unknown, id: string | undefined) {
    if (
      !object(input) ||
      Object.keys(input).length !== 1 ||
      !['STATUS', 'START', 'SYNC'].includes(String(input.action))
    )
      return rejectApplicant(400);
    const { action } = input;
    return this.withOwnerKyc(scope, id, async (state, binding, origin) => {
      const { status, actions, version } = await this.ownerKycStatus(scope, state, binding);
      if (action === 'STATUS') return { status, actions };
      if (!actions.includes(action)) return rejectApplicant(409);
      const result = await this.fury.request(scope, ownerKycQuery, { ...binding, action, version }, state);
      if (typeof result.status !== 'string' || !ownerKycStatuses.includes(result.status)) return rejectApplicant(503);
      const view = { status: result.status };
      if (action !== 'START' || result.redirectUrl == null) return view;
      if (typeof result.redirectUrl !== 'string' || result.redirectUrl.length > 4096) return rejectApplicant(503);
      const url = new URL(result.redirectUrl);
      if (url.origin !== origin || url.username || url.password) return rejectApplicant(503);
      return { ...view, redirectUrl: url.href };
    });
  }

  async uploadOwnerSelfie(scope: OwnerKycScope, read: () => Promise<Buffer>, id: string | undefined) {
    return this.withOwnerKyc(scope, id, async (state, binding) => {
      await this.sessions.rate(scope, 'owner-selfie', state.phone, 5, 60);
      const { status, actions, version } = await this.ownerKycStatus(scope, state, binding);
      if (status !== 'verified' || !actions.includes('SELFIE')) return rejectApplicant(409);
      const selfie = dealerSelfieData(await read());
      const result = await this.fury.request(
        scope,
        ownerKycQuery,
        { ...binding, action: 'SELFIE', version, selfie },
        state
      );
      if (result.status !== 'verified') return rejectApplicant(503);
      return { status: 'verified' };
    });
  }

  async upload(scope: ApplicantScope, read: () => Promise<unknown>, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!id || !key) return rejectApplicant(409);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state?.auth || !state.pan || !state.draftId) return rejectApplicant(409);
      await this.sessions.rate(scope, 'upload', id, 20, 120);
      const input = await read();
      if (
        !object(input) ||
        Object.keys(input).some((key) => !['code', 'file', 'location'].includes(key)) ||
        typeof input.code !== 'string' ||
        !/^[a-z_]{1,64}$/.test(input.code) ||
        !Buffer.isBuffer(input.file) ||
        input.file.length === 0 ||
        input.file.length > maxDealerDocumentBytes
      )
        return rejectApplicant(400);
      const { code, file, location } = input;
      const current = await this.lookup(scope, state, key, state.pan);
      if (current.state !== 'draft' || !current.draft.version) return rejectApplicant(409);
      const action = current.actions.find((item) => item.name === 'attachDocument');
      const target = action?.documents.find((item) => item.code === code);
      if (!target) return rejectApplicant(409);
      if (!validDocument(target.mode, file, location)) return rejectApplicant(400);
      const body = new FormData();
      body.append(
        'metadata',
        JSON.stringify({
          referral_token: state.referral,
          pan: state.pan,
          version: current.draft.version,
          code,
          ...(location !== undefined ? { location } : {}),
        })
      );
      body.append('file', new Blob([new Uint8Array(file)]), 'evidence');
      const response = await this.fetcher(new URL('/v2/dealer/document', scope.furyUrl), {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(35_000),
        headers: { device: state.device, cookie: `authorization=${state.auth.token}; device=${state.device}` },
        body,
      });
      if (!response.ok || (await response.json())?.attached !== true) return rejectApplicant(503);
      return this.lookup(scope, state, key, state.pan);
    });
  }

  async run(scope: DealerScope | null, input: unknown, id: string | undefined, setCookie: SetCookie) {
    if (!scope) return rejectApplicant(404);
    const command = operation(input);
    const key = this.sessions.key(scope, id);
    if (!key || !(await this.sessions.get(key))) {
      if (command.kind === 'entry' && command.referral) {
        await this.sessions.rate(scope, 'entry', scope.origin, 300, 60);
        await this.sessions.rate(scope, 'invite', command.referral, 100, 60);
        if (!(await this.eligible(scope, command.referral))) return { state: 'invite' };
        const session = await this.sessions.start(
          scope,
          { referral: command.referral, device: newApplicantHandle() },
          guestTtl
        );
        setCookie(session.id, guestTtl);
        return { state: 'phone' };
      }
      if (command.kind === 'entry' || command.kind === 'status') return { state: 'invite' };
      return rejectApplicant(409);
    }

    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(409);
      if (command.kind === 'entry' && command.referral && command.referral !== state.referral)
        return rejectApplicant(409);
      if (command.kind === 'entry' || command.kind === 'status') return this.status(scope, state, key);
      if (command.kind === 'requestOtp') {
        if (state.auth || (state.phone && state.phone !== command.phone)) return rejectApplicant(409);
        await this.sessions.rate(scope, 'send', command.phone, 3, guestTtl);
        await this.sessions.rate(scope, 'send-tenant', scope.origin, 100, 60);
        if (!(await this.eligible(scope, state.referral))) return rejectApplicant(409);
        await this.fury.requestOtp(scope, state, command.phone);
        await this.sessions.save(key, { ...state, phone: command.phone });
        return { state: 'otp' };
      }
      if (command.kind === 'verifyOtp') {
        if (state.auth || !state.phone) return rejectApplicant(409);
        await this.sessions.rate(scope, 'verify', state.phone, 5, guestTtl);
        if (!(await this.eligible(scope, state.referral))) return rejectApplicant(409);
        const { token, seconds } = await this.fury.verifyOtp(scope, state, command.otp);
        const session = await this.sessions.rotate(scope, key, { ...state, auth: { token } }, seconds);
        setCookie(session.id, seconds);
        return { state: 'pan' };
      }
      if (!state.auth) return rejectApplicant(409);
      if (command.kind === 'completion') return this.completion(scope, state, command.operation);
      if (command.kind === 'ownerParticipant') {
        if (!state.draftId || !state.phone) return rejectApplicant(409);
        await this.sessions.rate(scope, 'owner-participant', state.phone, 20, 60);
        const result = await this.fury.request(
          scope,
          docs.participant,
          {
            referralToken: state.referral,
            draftId: state.draftId,
            action: command.action,
            fields: command.fields,
          },
          state
        );
        if (
          command.action === 'INVITE' &&
          result.status === 'invited' &&
          typeof result.id === 'string' &&
          uuidPattern.test(result.id)
        )
          return { state: 'participantInvite', invitationId: result.id, referralToken: state.referral };
        if (command.action === 'ACCEPT' && result.status === 'accepted') return this.status(scope, state, key);
        if (
          command.action === 'LIST' &&
          result.status === 'listed' &&
          Number.isSafeInteger(result.version) &&
          Array.isArray(result.consents)
        ) {
          const consents = result.consents
            .filter(
              (item: unknown) =>
                object(item) &&
                typeof item.id === 'string' &&
                uuidPattern.test(item.id) &&
                typeof item.status === 'string' &&
                ['pending', 'accepted', 'expired', 'withdrawn'].includes(item.status) &&
                typeof item.name === 'string' &&
                typeof item.role === 'string'
            )
            .map(({ id, status, name, role }) => ({ id, status, name, role }));
          return { state: 'participantRequests', version: result.version, consents };
        }
        return rejectApplicant(503);
      }
      if (command.kind === 'lookup') {
        if (state.draftId && command.pan !== state.pan) return rejectApplicant(409);
        return this.lookup(scope, state, key, command.pan);
      }
      if (!state.pan) return rejectApplicant(409);
      if (command.kind === 'saveEntityDetails') {
        if (!state.draftId) return rejectApplicant(409);
        const current = await this.lookup(scope, state, key, state.pan);
        const fields =
          current.state === 'draft' && current.actions.find((item) => item.name === 'saveEntityDetails')?.fields;
        if (!fields) return rejectApplicant(409);
        if (
          fields.length !== Object.keys(command.fields).length ||
          !fields.every((field) => Object.prototype.hasOwnProperty.call(command.fields, field))
        )
          return rejectApplicant(400);
        return draftView(
          await this.fury.request(
            scope,
            docs.entity,
            {
              referral_token: state.referral,
              pan: state.pan,
              fields: command.fields,
            },
            state
          ),
          state.draftId
        );
      }
      if (state.draftId) return this.status(scope, state, key);
      const gstin = command.fields.gstin.trim().toUpperCase();
      if (!gstPattern.test(gstin) || gstin.slice(2, 12) !== state.pan) return rejectApplicant(400);
      const result = await this.fury.request(
        scope,
        docs.start,
        {
          referral_token: state.referral,
          input: { ...command.fields, gstin, pan: state.pan },
        },
        state
      );
      const view = draftView(result);
      await this.sessions.save(key, { ...state, draftId: view.draft.id });
      return view;
    });
  }
}

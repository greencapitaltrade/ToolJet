import {
  ApplicantFury,
  ApplicantScope,
  applicantScope,
  normalizeApplicantPhone,
  rejectApplicant,
} from '../applicant-session/fury';
import { ApplicantRedis, ApplicantSessions, newApplicantHandle } from '../applicant-session/store';

export const DEALER_ONBOARDING_ENV = 'TOOLJET_DEALER_ONBOARDING';
const tokenPattern = /^v3[.][A-Za-z0-9_-]{39,1021}$/;
const panPattern = /^[A-Z]{3}[CFP][A-Z][0-9]{4}[A-Z]$/;
const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fieldLimits = { businessName: 255, applicantName: 255, applicantRole: 30, email: 254, gstin: 15, firmType: 20 };
const entityFieldNames = ['premises', 'cin', 'llpin'];
const guestTtl = 600;
type Payload = Record<string, unknown>;
type Fields = Record<string, string>;
type State = {
  referral: string;
  device: string;
  phone?: string;
  auth?: { token: string };
  pan?: string;
  draftId?: string;
};
type SetCookie = (id: string, ttl: number) => void;

const draftSelection = 'id status nextStep canWrite entityFields version documentActions { code label mode count }';
export const maxDealerDocumentBytes = 10 * 1024 * 1024;
type DocumentMode = 'pdf' | 'photo' | 'camera' | 'file';
type DocumentAction = { code: string; label: string; mode: DocumentMode; count: number };
type DealerAction =
  | { name: 'saveEntityDetails'; fields: string[] }
  | { name: 'attachDocument'; documents: DocumentAction[] };
const documentModes: readonly string[] = ['pdf', 'photo', 'camera', 'file'];
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
  status: {
    field: 'dealerIntakeStatus',
    query: `mutation DealerStatus($draftId: ID!) {
    dealerIntakeStatus(draftId: $draftId) { ${draftSelection} }
  }`,
  },
  entity: {
    field: 'dealerEntityDetailsSave',
    query: `mutation DealerEntity($draftId: ID!, $fields: DealerEntityDetailsInput!) {
      dealerEntityDetailsSave(draftId: $draftId, fields: $fields) { ${draftSelection} }
    }`,
  },
};

function object(value: unknown): value is Payload {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseDealerOnboardingConfig(value: string | undefined): ApplicantScope | null {
  try {
    const raw = JSON.parse(value ?? 'null');
    return object(raw) && Object.keys(raw).length === 4 ? applicantScope(raw) : null;
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
  | { kind: 'start'; fields: Fields };

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
    if (state.draftId) {
      const result = await this.fury.request(scope, docs.status, { draftId: state.draftId }, state);
      return draftView(result, state.draftId);
    }
    const result = await this.fury.request(scope, docs.lookup, { referral_token: state.referral, pan }, state);
    if (result.status === 'resume') {
      const view = draftView(result.draft);
      await this.sessions.save(key, { ...state, pan, draftId: view.draft.id });
      return view;
    }
    if (result.status !== 'new' || result.category !== { C: 'company', F: 'firm', P: 'proprietorship' }[pan[3]])
      return rejectApplicant(503);
    if (pan !== state.pan) await this.sessions.save(key, { ...state, pan });
    return { state: 'details' as const, category: result.category };
  }

  private async status(scope: ApplicantScope, state: State, key: string) {
    if (!state.auth) return { state: state.phone ? 'otp' : 'phone' };
    if (!state.pan) return { state: 'pan' };
    return this.lookup(scope, state, key, state.pan);
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
          draft_id: state.draftId,
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

  async run(scope: ApplicantScope | null, input: unknown, id: string | undefined, setCookie: SetCookie) {
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
              draftId: state.draftId,
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

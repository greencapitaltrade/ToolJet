import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ParticipantIntentStore,
  participantEligibilityHeaders,
  participantRecipientKey,
  participantRecheckSignature,
  PARTICIPANT_ELIGIBILITY_PATH,
} from './vn-participant';
import {
  SignerIntentStore,
  signerEligibilityHeaders,
  signerRecipientKey,
  signerRecheckSignature,
  SIGNER_ELIGIBILITY_PATH,
} from './vn-signer';
import {
  ApplicantFury,
  ApplicantScope,
  applicantScope,
  exactHttpsOrigin,
  isApplicantReferral,
  normalizeApplicantPhone,
  rejectApplicant,
} from '../applicant-session/fury';
import {
  ApplicantRedis,
  ApplicantSessions,
  newApplicantHandle,
  SignedAdmissionScope,
} from '../applicant-session/store';
import { dealerDossierInput, requestDealerDossier } from './dossier';
import { dealerProviderRedirect, parseDealerParticipantConfig } from './participant';
import { dealerSelfieData } from './selfie';
import { DealerContinuation } from './continuation';
import {
  VN_ADMISSION_PATH,
  VN_ADMISSION_DOCUMENT_PATH,
  VN_ADMISSION_SELFIE_PATH,
  vnAdmissionHeaders,
} from './admission';
import type { DealerOidcBroker } from './oidc-broker';
import {
  dealerVoltcredAuthorizeUrl,
  dealerVoltcredHandle,
  type DealerVoltcredBridgeConfig,
  type DealerVoltcredReceipt,
} from './voltcred-bridge';

export const DEALER_ONBOARDING_ENV = 'TOOLJET_DEALER_ONBOARDING';
export const DEALER_OWNER_KYC_ORIGIN = 'TOOLJET_DEALER_OWNER_KYC_ORIGIN';
const panPattern = /^[A-Z]{3}[CFP][A-Z][0-9]{4}[A-Z]$/;
const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const gstChoicePattern = /^[a-f0-9]{64}$/;
const fieldLimits = { businessName: 255, applicantName: 255, applicantRole: 30, email: 254, gstin: 15, firmType: 20 };
const entityFieldNames = ['premises', 'cin', 'llpin'];
const guestTtl = 600;
const dealerStages = [
  'bank',
  'gst',
  'people',
  'premises_photo',
  'electricity_bill',
  'additional_documents',
  'review',
  'agreement',
  'completed',
  'closed',
] as const;
type FinancialPurpose = 'bank' | 'gst';
type FinancialAttempt = {
  mobile: string;
  requestId?: string;
  choices?: Record<string, string>;
};
type Payload = Record<string, unknown>;
type Fields = Record<string, string>;
type DealerScope = ApplicantScope & { signingOrigin?: string };
type VoltcredDealerScope = DealerScope & {
  voltcred: DealerVoltcredBridgeConfig;
};
type PublicActorScope = {
  actorOrganizationId: string;
  destinyOrigin: string;
  viewerUrl?: string;
};
export type VnDealerScope = (
  | (DealerScope & { admission?: never })
  | (SignedAdmissionScope & { admission: { issuerOrgId: string; hmacSecret: string }; signingOrigin?: string })
) & { vn: PublicActorScope };
type PublicDealerScope = VoltcredDealerScope | VnDealerScope;
type PublicOwnerScope = PublicDealerScope & {
  ownerHmacKey: string;
  kycOrigin: string;
};
type VoltcredBankScope = PublicDealerScope & { bankConsentOrigin: string };
type VnBroker = Pick<DealerOidcBroker, 'start' | 'callback'>;
type VnParticipantBroker = VnBroker & Pick<DealerOidcBroker, 'startParticipant'>;
type VnSignerBroker = VnBroker & Pick<DealerOidcBroker, 'startSigner'>;
type ApplicantActor = { userId: string; actorOrgId: string; email: string };
type State = {
  referral: string;
  device: string;
  phone?: string;
  auth?: { token: string };
  pan?: string;
  draftId?: string;
  gstRequestId?: string;
  publicVoltcred?: true;
  voltcredActor?: ApplicantActor;
  publicVn?: true;
  vnParticipant?: true;
  vnSigner?: true;
  vnSignerJti?: string;
  vnSignerCommitment?: string;
  vnParticipantKycId?: string;
  vnActor?: ApplicantActor;
  vnAdmissionInput?: Payload;
  vnAdmissionDraftId?: string;
  bankAa?: FinancialAttempt;
  gstAa?: FinancialAttempt;
};
type VerifiedOwner = State & { phone: string };
type SetCookie = (id: string, ttl: number) => void;
const publicActorScope = (scope: PublicDealerScope) => ('vn' in scope ? scope.vn : scope.voltcred);
function verifiedPublicActor(scope: PublicDealerScope, state: State | null | undefined) {
  const actor =
    'vn' in scope
      ? state?.publicVn && !state.vnParticipant && !state.vnSigner && state.vnActor
      : state?.publicVoltcred && state.voltcredActor;
  return actor && actor.actorOrgId === publicActorScope(scope).actorOrganizationId ? actor : undefined;
}
export type OwnerKycScope = DealerScope & { kycOrigin?: string };
const ownerKycActions = ['START', 'SYNC', 'SELFIE', 'SIGN'];
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
type DocumentAction = {
  code: string;
  label: string;
  mode: DocumentMode;
  count: number;
};
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
  status: {
    field: 'dealerIntakeStatus',
    query: `mutation DealerStatus($draftId: ID!) {
    dealerIntakeStatus(draftId: $draftId) { ${draftSelection} }
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
    query: `mutation DealerEntity($draftId: ID!, $fields: DealerEntityDetailsInput!) {
      dealerEntityDetailsSave(draftId: $draftId, fields: $fields) { ${draftSelection} }
    }`,
  },
  gst: {
    field: 'dealerGstAa',
    timeoutMs: 55_000,
    query: `mutation DealerGstAa($draftId: ID!, $action: DealerGstAaAction!, $requestId: ID, $account: String) {
      dealerGstAa(draftId: $draftId, action: $action, requestId: $requestId, account: $account) {
        status requestId consentUrl accounts { key maskedGstin }
      }
    }`,
  },
};

function object(value: unknown): value is Payload {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function voltcredDraft(intake: unknown, organizationId: string) {
  if (!object(intake)) return rejectApplicant(503);
  const org =
    typeof intake.organization_id === 'number' && Number.isSafeInteger(intake.organization_id)
      ? String(intake.organization_id)
      : intake.organization_id;
  if (
    typeof intake.draft_id !== 'string' ||
    !uuidPattern.test(intake.draft_id) ||
    org !== organizationId ||
    typeof intake.version !== 'number' ||
    !Number.isSafeInteger(intake.version) ||
    intake.version < 1
  )
    return rejectApplicant(503);
  const stage = dealerStages.find((value) => value === intake.intake_stage);
  return { id: intake.draft_id, version: intake.version, ...(stage && { stage }) };
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
  | { kind: 'gst'; action: 'STATUS' | 'START' | 'ATTACH'; account?: string }
  | { kind: 'start'; fields: Fields }
  | { kind: 'completion'; operation: CompletionOperation }
  | {
      kind: 'ownerParticipant';
      action: 'INVITE' | 'LIST' | 'ACCEPT';
      fields: Payload;
    };

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
    if (isApplicantReferral(value.referralToken)) return { kind: 'entry', referral: value.referralToken };
  }
  if ('referralToken' in value) return rejectApplicant(400);
  if (value.operation === 'status' && !keys.length) return { kind: 'status' };
  if (value.operation === 'gstStatus' && !keys.length) return { kind: 'gst', action: 'STATUS' };
  if (value.operation === 'gstStart' && !keys.length) return { kind: 'gst', action: 'START' };
  if (
    value.operation === 'gstAttach' &&
    keys.length === 1 &&
    typeof fields.account === 'string' &&
    gstChoicePattern.test(fields.account)
  )
    return { kind: 'gst', action: 'ATTACH', account: fields.account };
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
        fields[key].length <= fieldLimits[key as keyof typeof fieldLimits]
    ) &&
    ['businessName', 'applicantName', 'applicantRole', 'email'].every(
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

const evidenceDefinitions: Record<string, { label: string; mode: string }> = {
  business_premises_photo: { label: 'Geotagged business premises photo', mode: 'camera' },
  utility_bill: { label: 'Latest electricity bill', mode: 'upload' },
  additional_documents: { label: 'Additional documents', mode: 'upload' },
};

function isVoltcredEvidenceStage(
  stage: string | undefined
): stage is 'premises_photo' | 'electricity_bill' | 'additional_documents' {
  return stage === 'premises_photo' || stage === 'electricity_bill' || stage === 'additional_documents';
}

export function projectVoltcredEvidence(stage: string, data: unknown) {
  if (!object(data) || !isVoltcredEvidenceStage(stage)) return rejectApplicant(503);
  const requested = data.requested_document_codes ?? [];
  if (
    !Array.isArray(requested) ||
    requested.length > 3 ||
    requested.some(
      (code) => typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(evidenceDefinitions, code)
    ) ||
    new Set(requested).size !== requested.length ||
    (stage !== 'additional_documents' && requested.length)
  )
    return rejectApplicant(503);
  const allowed =
    stage === 'premises_photo'
      ? ['business_premises_photo']
      : stage === 'electricity_bill'
        ? ['utility_bill']
        : requested.length
          ? requested
          : ['additional_documents'];
  const actions = data.document_actions ?? [];
  if (!Array.isArray(actions) || actions.length > allowed.length) return rejectApplicant(503);
  const seen = new Set<string>();
  const document_actions = actions.map((action: unknown) => {
    if (!object(action) || typeof action.code !== 'string' || !allowed.includes(action.code) || seen.has(action.code))
      return rejectApplicant(503);
    const definition = evidenceDefinitions[action.code];
    if (
      action.label !== definition.label ||
      action.mode !== definition.mode ||
      typeof action.count !== 'number' ||
      !Number.isSafeInteger(action.count) ||
      action.count < 0
    )
      return rejectApplicant(503);
    seen.add(action.code);
    return { code: action.code, label: definition.label, mode: definition.mode, count: action.count };
  });
  return { stage, requested_document_codes: requested, document_actions };
}

export class DealerOnboarding {
  private readonly fury: ApplicantFury;
  private readonly sessions: ApplicantSessions<State>;
  private readonly continuations: DealerContinuation;
  private readonly redis: ApplicantRedis;

  constructor(
    redis: ApplicantRedis,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.redis = redis;
    this.fury = new ApplicantFury(fetcher);
    this.sessions = new ApplicantSessions(redis, 'dealer');
    this.continuations = new DealerContinuation(redis);
  }

  private async eligible(scope: ApplicantScope, referral: string) {
    try {
      const result = await this.fury.request(scope, docs.eligibility, { referral_token: referral });
      return result.eligible === true && result.organizationId === scope.organizationId;
    } catch {
      return false;
    }
  }

  private async eligibleVn(scope: VnDealerScope, referral: string) {
    if (!('namespace' in scope)) return this.eligible(scope, referral);
    if (scope.admission.issuerOrgId !== scope.organizationId) return false;
    try {
      const response = await this.fetcher(`${scope.vn.destinyOrigin}/v1/channel-partners/referrals/eligibility`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'x-gct-org-id': scope.admission.issuerOrgId },
        body: JSON.stringify({ referral_token: referral }),
      });
      if (!response.ok) return false;
      const result = await response.json();
      return (
        object(result) &&
        Object.keys(result).length === 2 &&
        result.organization_id === scope.admission.issuerOrgId &&
        result.eligible === true
      );
    } catch {
      return false;
    }
  }

  private async participantEligibility(
    scope: VnDealerScope,
    clientId: string,
    secret: string,
    jti: string,
    token: string
  ) {
    if (!scope.admission) return rejectApplicant(404);
    const recipient_commitment_key = participantRecipientKey(secret, scope.organizationId, clientId, jti);
    const body = JSON.stringify({ participant_token: token, recipient_commitment_key });
    const response = await this.fetcher(`${scope.vn.destinyOrigin}${PARTICIPANT_ELIGIBILITY_PATH}`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
      headers: {
        'content-type': 'application/json',
        ...participantEligibilityHeaders(scope.organizationId, body, scope.admission.hmacSecret),
      },
      body,
    });
    if (!response.ok) return rejectApplicant(409);
    const result = await response.json();
    if (
      !object(result) ||
      Object.keys(result).length !== 1 ||
      typeof result.recipient_commitment !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.recipient_commitment)
    )
      return rejectApplicant(409);
    return result.recipient_commitment;
  }

  async startVnParticipant(
    scope: VnDealerScope,
    broker: VnParticipantBroker,
    clientId: string,
    secret: string,
    input: unknown,
    setCookie: SetCookie
  ) {
    if (
      !scope.admission ||
      !object(input) ||
      Object.keys(input).length !== 1 ||
      typeof input.participant_token !== 'string' ||
      !/^v3\.[A-Za-z0-9_-]{39,1021}$/.test(input.participant_token)
    )
      return rejectApplicant(400);
    const token = input.participant_token;
    await this.sessions.rate(scope, 'entry', scope.origin, 300, 60);
    await this.sessions.rate(scope, 'invite', token, 100, 60);
    const guest = await this.sessions.start(
      scope,
      { referral: token, device: newApplicantHandle(), publicVn: true, vnParticipant: true },
      guestTtl
    );
    const store = new ParticipantIntentStore(this.redis, scope.organizationId, secret);
    const authorizeUrl = await broker.startParticipant(guest.id, guest.id, token, async (jti, value) => {
      const commitment = await this.participantEligibility(scope, clientId, secret, jti, value);
      await store.put(jti, guest.id, value, commitment);
      return commitment;
    });
    setCookie(guest.id, guestTtl);
    return { authorizeUrl };
  }

  async recheckVnParticipant(
    scope: VnDealerScope,
    clientId: string,
    secret: string,
    input: unknown,
    issued: string,
    signature: string,
    rawBody: unknown
  ) {
    if (
      typeof rawBody !== 'string' ||
      Buffer.byteLength(rawBody) > 16384 ||
      !scope.admission ||
      !object(input) ||
      Object.keys(input).sort().join(',') !== 'client_id,jti,organization_id,recipient_commitment' ||
      input.client_id !== clientId ||
      input.organization_id !== scope.organizationId ||
      typeof input.jti !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.jti) ||
      typeof input.recipient_commitment !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.recipient_commitment) ||
      !/^[1-9]\d{0,11}$/.test(issued) ||
      Math.abs(Date.now() / 1000 - Number(issued)) > 60 ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return rejectApplicant(403);
    const expected = participantRecheckSignature(secret, scope.organizationId, issued, rawBody);
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return rejectApplicant(403);
    const record = await new ParticipantIntentStore(this.redis, scope.organizationId, secret).get(input.jti);
    if (!record || record.commitment !== input.recipient_commitment) return rejectApplicant(403);
    const key = this.sessions.key(scope, record.guest);
    const state = key && (await this.sessions.get(key));
    if (!state?.vnParticipant || state.vnActor || state.referral !== record.token) return rejectApplicant(403);
    const commitment = await this.participantEligibility(scope, clientId, secret, input.jti, record.token);
    if (commitment !== record.commitment) return rejectApplicant(403);
    return { eligible: true };
  }

  private async signerEligibility(scope: VnDealerScope, clientId: string, secret: string, jti: string, token: string) {
    if (!scope.admission) return rejectApplicant(404);
    const recipient_commitment_key = signerRecipientKey(secret, scope.organizationId, clientId, jti);
    const body = JSON.stringify({
      signer_token: token,
      recipient_commitment_key,
    });
    const response = await this.fetcher(`${scope.vn.destinyOrigin}${SIGNER_ELIGIBILITY_PATH}`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
      headers: {
        'content-type': 'application/json',
        ...signerEligibilityHeaders(scope.organizationId, body, scope.admission.hmacSecret),
      },
      body,
    });
    if (!response.ok) return rejectApplicant(409);
    const result = await response.json();
    if (
      !object(result) ||
      Object.keys(result).length !== 1 ||
      typeof result.recipient_commitment !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.recipient_commitment)
    )
      return rejectApplicant(409);
    return result.recipient_commitment;
  }

  async startVnSigner(
    scope: VnDealerScope,
    broker: VnSignerBroker,
    clientId: string,
    secret: string,
    input: unknown,
    setCookie: SetCookie
  ) {
    if (
      !scope.admission ||
      !object(input) ||
      Object.keys(input).length !== 1 ||
      typeof input.signer_token !== 'string' ||
      !/^v3\.[A-Za-z0-9_-]{39,1021}$/.test(input.signer_token)
    )
      return rejectApplicant(400);
    const token = input.signer_token;
    await this.sessions.rate(scope, 'entry', scope.origin, 300, 60);
    await this.sessions.rate(scope, 'invite', token, 100, 60);
    const guest = await this.sessions.start(
      scope,
      {
        referral: token,
        device: newApplicantHandle(),
        publicVn: true,
        vnSigner: true,
      },
      guestTtl
    );
    const store = new SignerIntentStore(this.redis, scope.organizationId, secret);
    const authorizeUrl = await broker.startSigner(guest.id, guest.id, token, async (jti, value) => {
      const commitment = await this.signerEligibility(scope, clientId, secret, jti, value);
      await store.put(jti, guest.id, value, commitment);
      return commitment;
    });
    setCookie(guest.id, guestTtl);
    return { authorizeUrl };
  }

  async recheckVnSigner(
    scope: VnDealerScope,
    clientId: string,
    secret: string,
    input: unknown,
    issued: string,
    signature: string,
    rawBody: unknown
  ) {
    if (
      typeof rawBody !== 'string' ||
      Buffer.byteLength(rawBody) > 16384 ||
      !scope.admission ||
      !object(input) ||
      Object.keys(input).sort().join(',') !== 'client_id,jti,organization_id,recipient_commitment' ||
      input.client_id !== clientId ||
      input.organization_id !== scope.organizationId ||
      typeof input.jti !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.jti) ||
      typeof input.recipient_commitment !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.recipient_commitment) ||
      !/^[1-9]\d{0,11}$/.test(issued) ||
      Math.abs(Date.now() / 1000 - Number(issued)) > 60 ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return rejectApplicant(403);
    const expected = signerRecheckSignature(secret, scope.organizationId, issued, rawBody);
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return rejectApplicant(403);
    const record = await new SignerIntentStore(this.redis, scope.organizationId, secret).get(input.jti);
    if (!record || record.commitment !== input.recipient_commitment) return rejectApplicant(403);
    const key = this.sessions.key(scope, record.guest);
    const state = key && (await this.sessions.get(key));
    if (!state?.vnSigner || state.vnActor || state.referral !== record.token) return rejectApplicant(403);
    const commitment = await this.signerEligibility(scope, clientId, secret, input.jti, record.token);
    if (commitment !== record.commitment) return rejectApplicant(403);
    return { eligible: true };
  }

  async signVnSigner(scope: VnDealerScope, clientId: string, secret: string, input: unknown, id: string | undefined) {
    if (!scope.admission || !exactHttpsOrigin(scope.signingOrigin) || !object(input) || Object.keys(input).length)
      return rejectApplicant(400);
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      const actor = state?.vnSigner && state.vnActor;
      if (
        !state ||
        !actor ||
        actor.actorOrgId !== scope.organizationId ||
        !state.vnSignerJti ||
        !state.vnSignerCommitment
      )
        return rejectApplicant(401);
      if (
        (await this.signerEligibility(scope, clientId, secret, state.vnSignerJti, state.referral)) !==
        state.vnSignerCommitment
      )
        return rejectApplicant(409);
      const body = JSON.stringify({
        input: { action: 'signer-own-sign', signer_token: state.referral },
      });
      const headers = vnAdmissionHeaders(
        {
          organizationId: scope.organizationId,
          issuerOrgId: actor.actorOrgId,
          userId: actor.userId,
          email: actor.email,
          referral: '',
          body,
        },
        scope.admission!.hmacSecret
      );
      const response = await this.fetcher(`${scope.vn.destinyOrigin}${VN_ADMISSION_PATH}`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
        headers: {
          'Content-Type': 'application/json',
          'x-gct-org-id': scope.organizationId,
          ...headers,
        },
        body,
      });
      if (!response.ok) return rejectApplicant(response.status === 403 ? 403 : response.status === 409 ? 409 : 503);
      const result = await response.json();
      if (!object(result) || Object.keys(result).sort().join(',') !== 'status,url' || result.status !== 'requested')
        return rejectApplicant(503);
      return {
        status: 'requested',
        url: dealerProviderRedirect(result.url, scope.signingOrigin),
      };
    });
  }

  async inviteVnSigner(scope: VnDealerScope, input: unknown, id: string | undefined) {
    if (
      !scope.admission ||
      !object(input) ||
      !['list', 'issue'].includes(String(input.operation)) ||
      !Number.isSafeInteger(input.version) ||
      (input.version as number) < 1
    )
      return rejectApplicant(400);
    const issue = input.operation === 'issue';
    if (
      Object.keys(input).sort().join(',') !== (issue ? 'operation,slot_id,version' : 'operation,version') ||
      (issue && (typeof input.slot_id !== 'string' || !/^person[a-f0-9]{32}$/.test(input.slot_id)))
    )
      return rejectApplicant(400);
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state || !verifiedPublicActor(scope, state)) return rejectApplicant(401);
      if (!state.vnAdmissionDraftId || !uuidPattern.test(state.vnAdmissionDraftId)) return rejectApplicant(409);
      const result = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
        action: 'signer-invite',
        draft_id: state.vnAdmissionDraftId,
        operation: input.operation,
        input: {
          version: input.version,
          ...(issue && { slot_id: input.slot_id }),
        },
      });
      if (!object(result)) return rejectApplicant(503);
      if (!issue) {
        if (
          Object.keys(result).join(',') !== 'signers' ||
          !Array.isArray(result.signers) ||
          result.signers.length > 30 ||
          !result.signers.every(
            (p) =>
              object(p) &&
              Object.keys(p).sort().join(',') === 'name,slot_id' &&
              typeof p.name === 'string' &&
              p.name.length <= 255 &&
              typeof p.slot_id === 'string' &&
              /^person[a-f0-9]{32}$/.test(p.slot_id)
          )
        )
          return rejectApplicant(503);
        return { signers: result.signers };
      }
      if (Object.keys(result).join(',') !== 'url' || typeof result.url !== 'string' || !scope.vn.viewerUrl)
        return rejectApplicant(503);
      try {
        const url = new URL(result.url),
          base = new URL(scope.vn.viewerUrl),
          tokens = url.searchParams.getAll('signing');
        if (
          tokens.length !== 1 ||
          [...url.searchParams.keys()].length !== 1 ||
          !/^v3\.[A-Za-z0-9_-]{39,1021}$/.test(tokens[0])
        )
          return rejectApplicant(503);
        url.searchParams.delete('signing');
        if (url.href !== base.href) return rejectApplicant(503);
      } catch {
        return rejectApplicant(503);
      }
      return { url: result.url };
    });
  }

  async startVn(scope: VnDealerScope, broker: VnBroker, input: unknown, setCookie: SetCookie) {
    if (!object(input) || Object.keys(input).length !== 1 || !isApplicantReferral(input.referral_token))
      return rejectApplicant(400);
    if (scope.vn.actorOrganizationId !== scope.organizationId) return rejectApplicant(503);
    const referral = input.referral_token;
    await this.sessions.rate(scope, 'entry', scope.origin, 300, 60);
    await this.sessions.rate(scope, 'invite', referral, 100, 60);
    if (!(await this.eligibleVn(scope, referral))) return rejectApplicant(409);
    const guest = await this.sessions.start(
      scope,
      { referral, device: newApplicantHandle(), publicVn: true },
      guestTtl
    );
    const authorizeUrl = await broker.start(guest.id, guest.id);
    setCookie(guest.id, guestTtl);
    return { authorizeUrl };
  }

  async finishVn(
    scope: VnDealerScope,
    broker: VnBroker,
    input: { state: string; code: string },
    id: string | undefined,
    setCookie: SetCookie,
    participantConfig?: { clientId: string; secret: string }
  ) {
    const key = this.sessions.key(scope, id);
    if (!key || !id || scope.vn.actorOrganizationId !== scope.organizationId) return rejectApplicant(401);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (
        !state?.publicVn ||
        state.vnActor ||
        (!state.vnParticipant && !state.vnSigner && !(await this.eligibleVn(scope, state.referral)))
      )
        return rejectApplicant(409);
      const identity = await broker.callback(input, id);
      if (identity.continuation !== id || identity.organizationId !== scope.organizationId) return rejectApplicant(409);
      if (state.vnSigner) {
        if (!participantConfig || !identity.signerJti || identity.participantJti || !scope.admission)
          return rejectApplicant(409);
        const record = await new SignerIntentStore(this.redis, scope.organizationId, participantConfig.secret).get(
          identity.signerJti
        );
        if (
          !record ||
          record.guest !== id ||
          record.token !== state.referral ||
          (await this.signerEligibility(
            scope,
            participantConfig.clientId,
            participantConfig.secret,
            identity.signerJti,
            record.token
          )) !== record.commitment ||
          createHmac(
            'sha256',
            Buffer.from(
              signerRecipientKey(
                participantConfig.secret,
                scope.organizationId,
                participantConfig.clientId,
                identity.signerJti
              ),
              'hex'
            )
          )
            .update(identity.email.trim().toLowerCase())
            .digest('hex') !== record.commitment
        )
          return rejectApplicant(409);
        state.vnSignerJti = identity.signerJti;
        state.vnSignerCommitment = record.commitment;
      } else if (state.vnParticipant) {
        if (!participantConfig || !identity.participantJti || identity.signerJti || !scope.admission)
          return rejectApplicant(409);
        const record = await new ParticipantIntentStore(this.redis, scope.organizationId, participantConfig.secret).get(
          identity.participantJti
        );
        if (
          !record ||
          record.guest !== id ||
          record.token !== state.referral ||
          (await this.participantEligibility(
            scope,
            participantConfig.clientId,
            participantConfig.secret,
            identity.participantJti,
            record.token
          )) !== record.commitment
        )
          return rejectApplicant(409);
        const verified = {
          ...state,
          vnActor: {
            userId: identity.userId,
            actorOrgId: identity.organizationId,
            email: identity.email,
          },
        };
        const claim = await this.admitVn(scope, verified, scope.admission.hmacSecret, { action: 'person-claim' });
        if (!object(claim) || Object.keys(claim).length !== 1 || claim.status !== 'claimed')
          return rejectApplicant(409);
      } else if (identity.participantJti || identity.signerJti) return rejectApplicant(409);
      const ttl = 1800;
      const session = await this.sessions.rotate(
        scope,
        key,
        {
          ...state,
          vnActor: { userId: identity.userId, actorOrgId: identity.organizationId, email: identity.email },
        },
        ttl
      );
      setCookie(session.id, ttl);
    });
  }

  async startVoltcred(scope: VoltcredDealerScope, input: unknown, _id: string | undefined, setCookie: SetCookie) {
    if (!object(input) || Object.keys(input).length !== 1 || !isApplicantReferral(input.referral_token))
      return rejectApplicant(400);
    const referral = input.referral_token;
    await this.sessions.rate(scope, 'entry', scope.origin, 300, 60);
    await this.sessions.rate(scope, 'invite', referral, 100, 60);
    if (!(await this.eligible(scope, referral))) return rejectApplicant(409);
    const guest = await this.sessions.start(
      scope,
      { referral, device: newApplicantHandle(), publicVoltcred: true },
      guestTtl
    );
    const state = await this.continuations.start(scope, guest.id, referral);
    setCookie(guest.id, guestTtl);
    return { authorizeUrl: dealerVoltcredAuthorizeUrl(state) };
  }

  async receiveVoltcred(scope: VoltcredDealerScope, receipt: DealerVoltcredReceipt) {
    const code = await this.continuations.receive(scope, receipt.state, receipt, scope.voltcred.actorOrganizationId);
    return { code };
  }

  async finishVoltcred(scope: VoltcredDealerScope, input: unknown, id: string | undefined, setCookie: SetCookie) {
    const key = this.sessions.key(scope, id);
    if (!key || !id || !object(input) || Object.keys(input).length !== 1 || !dealerVoltcredHandle(input.code))
      return rejectApplicant(400);
    const code = input.code;
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state?.publicVoltcred || state.voltcredActor || !(await this.eligible(scope, state.referral)))
        return rejectApplicant(409);
      const receipt = await this.continuations.consume(scope, id, code);
      if (receipt.referral !== state.referral || receipt.actorOrgId !== scope.voltcred.actorOrganizationId)
        return rejectApplicant(409);
      const session = await this.sessions.rotate(
        scope,
        key,
        {
          ...state,
          voltcredActor: { userId: receipt.userId, actorOrgId: receipt.actorOrgId, email: receipt.email },
        },
        receipt.seconds
      );
      setCookie(session.id, receipt.seconds);
      return { state: 'pan' as const };
    });
  }

  private async admitVn(scope: VnDealerScope, state: State, key: string, context: Payload) {
    const actor =
      state.vnParticipant && ['person-claim', 'person-kyc-start', 'person-kyc-sync'].includes(String(context.action))
        ? state.vnActor
        : verifiedPublicActor(scope, state);
    if (!state.publicVn || !actor || actor.actorOrgId !== scope.organizationId || !isApplicantReferral(state.referral))
      return rejectApplicant(401);
    const body = JSON.stringify({ input: { referral_token: state.referral, ...context } });
    const headers = vnAdmissionHeaders(
      {
        organizationId: scope.organizationId,
        issuerOrgId: actor.actorOrgId,
        userId: actor.userId,
        email: actor.email,
        referral: state.referral,
        body,
      },
      key
    );
    const response = await this.fetcher(`${scope.vn.destinyOrigin}${VN_ADMISSION_PATH}`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(
        (context.action === 'financial' && ['start', 'sync', 'attach'].includes(context.operation as string)) ||
          ['person-kyc-start', 'person-kyc-sync'].includes(String(context.action))
          ? 45000
          : context.action === 'completion'
            ? 30000
            : 5000
      ),
      headers: { 'Content-Type': 'application/json', 'x-gct-org-id': scope.organizationId, ...headers },
      body,
    });
    if (!response.ok) return rejectApplicant(response.status === 403 ? 403 : response.status === 409 ? 409 : 503);
    return response.json();
  }

  async participantKycVn(scope: VnDealerScope & { kycOrigin: string }, input: unknown, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (
      !scope.admission ||
      scope.admission.issuerOrgId !== scope.organizationId ||
      scope.vn.actorOrganizationId !== scope.organizationId ||
      Buffer.byteLength(scope.admission.hmacSecret) < 32 ||
      !exactHttpsOrigin(scope.kycOrigin)
    )
      return rejectApplicant(503);
    if (
      !object(input) ||
      !(
        (input.action === 'START' &&
          Object.keys(input).sort().join(',') === 'action,consent' &&
          input.consent === true) ||
        (input.action === 'SYNC' && Object.keys(input).join(',') === 'action')
      )
    )
      return rejectApplicant(400);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (
        !state?.publicVn ||
        !state.vnParticipant ||
        !state.vnActor ||
        state.vnActor.actorOrgId !== scope.organizationId
      )
        return rejectApplicant(401);
      if (input.action === 'SYNC' && (!state.vnParticipantKycId || !uuidPattern.test(state.vnParticipantKycId)))
        return rejectApplicant(409);
      const result = await this.admitVn(
        scope,
        state,
        scope.admission!.hmacSecret,
        input.action === 'START'
          ? { action: 'person-kyc-start', consent: true }
          : { action: 'person-kyc-sync', request_id: state.vnParticipantKycId }
      );
      if (
        !object(result) ||
        typeof result.id !== 'string' ||
        !uuidPattern.test(result.id) ||
        !['pending', 'evidence_received', 'failed', 'cancelled', 'unknown', 'requesting'].includes(
          result.status as string
        ) ||
        (input.action === 'SYNC' && result.id !== state.vnParticipantKycId)
      )
        return rejectApplicant(503);
      let gatewayUrl: string | undefined;
      if (result.gateway_url !== undefined) {
        if (input.action !== 'START' || result.status !== 'pending') return rejectApplicant(503);
        gatewayUrl = dealerProviderRedirect(result.gateway_url, scope.kycOrigin);
        if (!gatewayUrl) return rejectApplicant(503);
      }
      state.vnParticipantKycId = result.id;
      await this.sessions.save(key, state);
      return { status: result.status, ...(gatewayUrl && { gatewayUrl }) };
    });
  }

  async participantSelfieVn(
    scope: VnDealerScope & { kycOrigin: string },
    read: () => Promise<Buffer>,
    id: string | undefined
  ) {
    const key = this.sessions.key(scope, id);
    if (!key || !id) return rejectApplicant(401);
    if (
      !scope.admission ||
      scope.admission.issuerOrgId !== scope.organizationId ||
      scope.vn.actorOrganizationId !== scope.organizationId ||
      Buffer.byteLength(scope.admission.hmacSecret) < 32 ||
      !exactHttpsOrigin(scope.kycOrigin)
    )
      return rejectApplicant(503);
    const initial = await this.sessions.get(key);
    if (
      !initial?.publicVn ||
      !initial.vnParticipant ||
      !initial.vnActor ||
      initial.vnActor.actorOrgId !== scope.organizationId ||
      !initial.vnParticipantKycId ||
      !uuidPattern.test(initial.vnParticipantKycId) ||
      !isApplicantReferral(initial.referral)
    )
      return rejectApplicant(401);
    await this.sessions.rate(scope, 'participant-selfie', id, 5, 60);
    const file = await read();
    if (!Buffer.isBuffer(file)) return rejectApplicant(400);
    dealerSelfieData(file);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      const actor = state?.vnActor;
      if (
        !state?.publicVn ||
        !state.vnParticipant ||
        !actor ||
        actor.actorOrgId !== scope.organizationId ||
        !state.vnParticipantKycId ||
        !uuidPattern.test(state.vnParticipantKycId) ||
        !isApplicantReferral(state.referral)
      )
        return rejectApplicant(401);
      const current = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
        action: 'person-kyc-sync',
        request_id: state.vnParticipantKycId,
      });
      if (!object(current) || current.id !== state.vnParticipantKycId || current.status !== 'evidence_received')
        return rejectApplicant(409);
      const metadata = JSON.stringify({
        action: 'person-selfie',
        referral_token: state.referral,
        request_id: state.vnParticipantKycId,
        sha256: createHash('sha256').update(file).digest('hex'),
      });
      const headers = vnAdmissionHeaders(
        {
          organizationId: scope.organizationId,
          issuerOrgId: actor.actorOrgId,
          userId: actor.userId,
          email: actor.email,
          referral: state.referral,
          body: metadata,
        },
        scope.admission!.hmacSecret,
        undefined,
        VN_ADMISSION_SELFIE_PATH
      );
      const response = await this.fetcher(`${scope.vn.destinyOrigin}${VN_ADMISSION_SELFIE_PATH}`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(45000),
        headers: {
          'content-type': 'image/jpeg',
          'x-gct-org-id': scope.organizationId,
          'x-admission-metadata': Buffer.from(metadata, 'utf8').toString('base64url'),
          ...headers,
        },
        body: Uint8Array.from(file),
      });
      if (!response.ok) return rejectApplicant([409, 422].includes(response.status) ? 409 : 503);
      const result = await response.json();
      if (!object(result) || Object.keys(result).join(',') !== 'selfie_verified' || result.selfie_verified !== true)
        return rejectApplicant(503);
      return { selfie_verified: true };
    });
  }

  async sessionVn(scope: VnDealerScope, input: unknown, id: string | undefined) {
    if (!scope.admission)
      return {
        ...(await this.statusVoltcred(scope, input, id)),
        admission: false,
      };
    if (!object(input) || Object.keys(input).length) return rejectApplicant(400);
    const key = this.sessions.key(scope, id);
    const state = key ? await this.sessions.get(key) : null;
    if (state?.publicVn && state.vnSigner && state.vnActor?.actorOrgId === scope.organizationId)
      return { state: 'signer', admission: true };
    if (state?.publicVn && state.vnParticipant && state.vnActor?.actorOrgId === scope.organizationId)
      return {
        state: 'claimed',
        admission: true,
        kycStarted: Boolean(state.vnParticipantKycId && uuidPattern.test(state.vnParticipantKycId)),
      };
    if (!state || !state.publicVn || !verifiedPublicActor(scope, state)) return { state: 'invite', admission: true };
    if (state.vnAdmissionDraftId) return { state: 'bound', admission: true };
    if (state.pan && panPattern.test(state.pan))
      return {
        state: 'details',
        category: { C: 'company', F: 'firm', P: 'proprietorship' }[state.pan[3]],
        admission: true,
      };
    return { state: 'pan', admission: true };
  }

  async lookupVnAdmission(scope: VnDealerScope, input: unknown, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (
      !object(input) ||
      Object.keys(input).length !== 1 ||
      typeof input.pan !== 'string' ||
      !panPattern.test(input.pan)
    )
      return rejectApplicant(400);
    const pan = input.pan;
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state || !state.publicVn || !verifiedPublicActor(scope, state)) return rejectApplicant(401);
      if (state.vnAdmissionDraftId || state.vnAdmissionInput) return rejectApplicant(409);
      await this.sessions.save(key, { ...state, pan });
      return { state: 'details', category: { C: 'company', F: 'firm', P: 'proprietorship' }[pan[3]], admission: true };
    });
  }

  async openVnAdmission(scope: VnDealerScope, input: unknown, id: string | undefined) {
    if (
      !object(input) ||
      Object.keys(input).some((k) => !['businessName', 'applicantName', 'firmType'].includes(k)) ||
      typeof input.businessName !== 'string' ||
      typeof input.applicantName !== 'string' ||
      !input.applicantName.trim() ||
      input.applicantName.length > 255 ||
      (input.firmType !== undefined && !['partnership', 'llp'].includes(input.firmType as string))
    )
      return rejectApplicant(400);
    const key = this.sessions.key(scope, id);
    const state = key ? await this.sessions.get(key) : null;
    if (!state || !state.publicVn || !verifiedPublicActor(scope, state) || !state.pan) return rejectApplicant(401);
    return this.admitVnAction(
      scope,
      {
        pan: state.pan,
        partner_name: input.businessName,
        ...(input.firmType && { firm_type: input.firmType }),
        ...(state.pan[3] === 'P' && { proprietor_name: input.applicantName }),
      },
      id
    );
  }

  async admitVnAction(scope: VnDealerScope, input: unknown, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (
      !scope.admission ||
      scope.admission.issuerOrgId !== scope.organizationId ||
      scope.vn.actorOrganizationId !== scope.organizationId ||
      Buffer.byteLength(scope.admission.hmacSecret) < 32
    )
      return rejectApplicant(503);
    const allowed = ['pan', 'partner_name', 'gst', 'mobile', 'firm_type', 'proprietor_name'];
    if (
      !object(input) ||
      Object.keys(input).some((name) => !allowed.includes(name)) ||
      typeof input.pan !== 'string' ||
      !panPattern.test(input.pan) ||
      typeof input.partner_name !== 'string' ||
      !input.partner_name.trim() ||
      input.partner_name.length > 255 ||
      allowed
        .slice(2)
        .some(
          (name) =>
            input[name] !== undefined &&
            (typeof input[name] !== 'string' || !(input[name] as string).trim() || (input[name] as string).length > 255)
        )
    )
      return rejectApplicant(400);
    const context = Object.fromEntries(
      allowed.filter((name) => input[name] !== undefined).map((name) => [name, input[name]])
    );
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state || !verifiedPublicActor(scope, state)) return rejectApplicant(401);
      if (state.vnAdmissionInput && JSON.stringify(state.vnAdmissionInput) !== JSON.stringify(context))
        return rejectApplicant(409);
      if (state.vnAdmissionDraftId) return { state: 'admitted' as const, draftId: state.vnAdmissionDraftId };
      if (!state.vnAdmissionInput) {
        state.vnAdmissionInput = context;
        await this.sessions.save(key, state);
      }
      const result = await this.admitVn(scope, state, scope.admission!.hmacSecret, context);
      if (
        !object(result) ||
        typeof result.draft_id !== 'string' ||
        !uuidPattern.test(result.draft_id) ||
        !Number.isSafeInteger(result.version) ||
        (result.version as number) < 1 ||
        typeof result.status !== 'string'
      )
        return rejectApplicant(503);
      state.vnAdmissionDraftId = result.draft_id;
      await this.sessions.save(key, state);
      return { state: 'admitted' as const, draftId: result.draft_id };
    });
  }

  async resumeVnAdmission(scope: VnDealerScope, input: unknown, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (
      !scope.admission ||
      scope.admission.issuerOrgId !== scope.organizationId ||
      scope.vn.actorOrganizationId !== scope.organizationId ||
      Buffer.byteLength(scope.admission.hmacSecret) < 32
    )
      return rejectApplicant(503);
    if (!object(input) || Object.keys(input).length !== 0) return rejectApplicant(400);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state || !verifiedPublicActor(scope, state) || !state.publicVn) return rejectApplicant(401);
      if (!state.vnAdmissionDraftId || !uuidPattern.test(state.vnAdmissionDraftId)) return rejectApplicant(409);
      const draftId = state.vnAdmissionDraftId;
      const result = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
        action: 'resume',
        draft_id: draftId,
      });
      if (
        !object(result) ||
        result.draft_id !== draftId ||
        !Number.isSafeInteger(result.version) ||
        (result.version as number) < 1 ||
        typeof result.status !== 'string' ||
        !['in_progress', 'submitted', 'changes_requested', 'approved', 'rejected'].includes(result.status)
      )
        return rejectApplicant(503);
      const stage = result.intake_stage;
      const requested = result.requested_document_codes;
      if (stage !== undefined && (typeof stage !== 'string' || !dealerStages.some((value) => value === stage)))
        return rejectApplicant(503);
      if (
        requested !== undefined &&
        (!Array.isArray(requested) ||
          requested.some(
            (code) => !['business_premises_photo', 'utility_bill', 'additional_documents'].includes(code)
          ) ||
          new Set(requested).size !== requested.length)
      )
        return rejectApplicant(503);
      return {
        draftId,
        version: result.version,
        status: result.status,
        ...(stage !== undefined && { intake_stage: stage }),
        ...(requested !== undefined && { requested_document_codes: requested }),
      };
    });
  }

  async uploadVnAdmissionDocument(scope: VnDealerScope, read: () => Promise<unknown>, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key || !id) return rejectApplicant(401);
    if (
      !scope.admission ||
      scope.admission.issuerOrgId !== scope.organizationId ||
      scope.vn.actorOrganizationId !== scope.organizationId ||
      Buffer.byteLength(scope.admission.hmacSecret) < 32
    )
      return rejectApplicant(503);
    const initial = await this.sessions.get(key);
    if (!initial?.publicVn || !initial.vnAdmissionDraftId || !verifiedPublicActor(scope, initial))
      return rejectApplicant(401);
    await this.sessions.rate(scope, 'upload', id, 20, 120);
    const input = await read();
    if (
      !object(input) ||
      Object.keys(input).some((k) => !['code', 'file', 'location'].includes(k)) ||
      typeof input.code !== 'string' ||
      !Buffer.isBuffer(input.file) ||
      !input.file.length ||
      input.file.length > maxDealerDocumentBytes
    )
      return rejectApplicant(400);
    const { code, file, location } = input;
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      const actor = state && verifiedPublicActor(scope, state);
      if (!state?.publicVn || !actor || !state.vnAdmissionDraftId || !uuidPattern.test(state.vnAdmissionDraftId))
        return rejectApplicant(401);
      const draft = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
        action: 'resume',
        draft_id: state.vnAdmissionDraftId,
      });
      if (
        !object(draft) ||
        draft.draft_id !== state.vnAdmissionDraftId ||
        !Number.isSafeInteger(draft.version) ||
        (draft.version as number) < 1 ||
        !['in_progress', 'changes_requested'].includes(draft.status as string)
      )
        return rejectApplicant(409);
      const requested = draft.requested_document_codes ?? [];
      if (
        !Array.isArray(requested) ||
        requested.some((c) => !['business_premises_photo', 'utility_bill', 'additional_documents'].includes(c)) ||
        new Set(requested).size !== requested.length
      )
        return rejectApplicant(503);
      const allowed =
        draft.intake_stage === 'premises_photo'
          ? ['business_premises_photo']
          : draft.intake_stage === 'electricity_bill'
            ? ['utility_bill']
            : draft.intake_stage === 'additional_documents'
              ? requested.length
                ? requested
                : ['additional_documents']
              : [];
      if (!allowed.includes(code)) return rejectApplicant(409);
      const camera = code === 'business_premises_photo';
      if (
        camera
          ? !validCameraLocation(location) || !validDocument('photo', file, undefined)
          : !validDocument('file', file, location)
      )
        return rejectApplicant(400);
      const metadata = JSON.stringify({
        input: {
          action: 'document-upload',
          referral_token: state.referral,
          draft_id: state.vnAdmissionDraftId,
          code,
          version: draft.version,
          location: camera ? location : null,
          sha256: createHash('sha256').update(file).digest('hex'),
        },
      });
      const headers = vnAdmissionHeaders(
        {
          organizationId: scope.organizationId,
          issuerOrgId: actor.actorOrgId,
          userId: actor.userId,
          email: actor.email,
          referral: state.referral,
          body: metadata,
        },
        scope.admission!.hmacSecret,
        undefined,
        VN_ADMISSION_DOCUMENT_PATH
      );
      const body = new FormData();
      body.append('metadata', metadata);
      body.append('file', new Blob([new Uint8Array(file)]), 'evidence');
      const response = await this.fetcher(`${scope.vn.destinyOrigin}${VN_ADMISSION_DOCUMENT_PATH}`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(35000),
        headers: { 'x-gct-org-id': scope.organizationId, ...headers },
        body,
      });
      if (!response.ok) return rejectApplicant([409, 422].includes(response.status) ? 409 : 503);
      return { uploaded: true };
    });
  }

  async rosterVn(scope: VnDealerScope, input: unknown, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (
      !scope.admission ||
      scope.admission.issuerOrgId !== scope.organizationId ||
      scope.vn.actorOrganizationId !== scope.organizationId ||
      Buffer.byteLength(scope.admission.hmacSecret) < 32
    )
      return rejectApplicant(503);
    if (!object(input) || !['state', 'save', 'issue', 'revoke'].includes(input.operation as string))
      return rejectApplicant(400);
    const save = input.operation === 'save';
    const invite = input.operation === 'issue' || input.operation === 'revoke';
    const keys = save
      ? ['operation', 'version', 'details', 'people']
      : invite
        ? ['operation', 'version', 'slot_id']
        : ['operation'];
    if (
      invite &&
      (!Number.isSafeInteger(input.version) ||
        (input.version as number) < 1 ||
        typeof input.slot_id !== 'string' ||
        !/^person[a-f0-9]{32}$/.test(input.slot_id))
    )
      return rejectApplicant(400);
    if (Object.keys(input).length !== keys.length || Object.keys(input).some((k) => !keys.includes(k)))
      return rejectApplicant(400);
    const detailsKeys = ['mobile', 'premises', 'cin', 'llpin'];
    const personKeys = ['slot_id', 'name', 'email', 'din'];
    const detailsValid = (value: unknown): value is Record<string, string> =>
      object(value) &&
      Object.keys(value).length === detailsKeys.length &&
      detailsKeys.every((k) => typeof value[k] === 'string' && (value[k] as string).length <= 255);
    const peopleValid = (value: unknown, allowNew: boolean) =>
      Array.isArray(value) &&
      value.length <= 30 &&
      value.every(
        (person) =>
          object(person) &&
          Object.keys(person).length === personKeys.length &&
          personKeys.every((k) => Object.prototype.hasOwnProperty.call(person, k)) &&
          ((allowNew && person.slot_id === null) ||
            (typeof person.slot_id === 'string' && /^person[a-f0-9]{32}$/.test(person.slot_id))) &&
          ['name', 'email', 'din'].every((k) => typeof person[k] === 'string' && (person[k] as string).length <= 255)
      ) &&
      new Set(value.filter((person) => person.slot_id !== null).map((person) => person.slot_id)).size ===
        value.filter((person) => person.slot_id !== null).length;
    if (
      save &&
      (!Number.isSafeInteger(input.version) ||
        (input.version as number) < 1 ||
        !detailsValid(input.details) ||
        !peopleValid(input.people, true))
    )
      return rejectApplicant(400);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state || !state.publicVn || !verifiedPublicActor(scope, state)) return rejectApplicant(401);
      const draftId = state.vnAdmissionDraftId;
      if (!draftId || !uuidPattern.test(draftId)) return rejectApplicant(409);
      const current = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
        action: 'resume',
        draft_id: draftId,
      });
      if (
        !object(current) ||
        current.draft_id !== draftId ||
        current.status !== 'in_progress' ||
        current.intake_stage !== 'people' ||
        !Number.isSafeInteger(current.version) ||
        (current.version as number) < 1 ||
        ((save || invite) && input.version !== current.version)
      )
        return rejectApplicant(409);
      const version = current.version as number;
      if (invite) {
        const response = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
          action: 'person-invite',
          draft_id: draftId,
          operation: input.operation,
          input: { version, slot_id: input.slot_id },
        });
        if (!object(response) || response.version !== version + 1) return rejectApplicant(503);
        if (input.operation === 'revoke') return { version: response.version };
        if (
          typeof response.url !== 'string' ||
          typeof response.expires_at !== 'string' ||
          !Number.isFinite(Date.parse(response.expires_at)) ||
          !scope.vn.viewerUrl
        )
          return rejectApplicant(503);
        try {
          const url = new URL(response.url),
            base = new URL(scope.vn.viewerUrl);
          const tokens = url.searchParams.getAll('participant');
          if (
            tokens.length !== 1 ||
            [...url.searchParams.keys()].length !== 1 ||
            !/^v3\.[A-Za-z0-9_-]{39,1021}$/.test(tokens[0])
          )
            return rejectApplicant(503);
          url.searchParams.delete('participant');
          if (url.href !== base.href) return rejectApplicant(503);
        } catch {
          return rejectApplicant(503);
        }
        return { version: response.version, url: response.url, expires_at: response.expires_at };
      }
      let submittedPeople = input.people;
      if (save) {
        const saved = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
          action: 'people',
          draft_id: draftId,
          operation: 'state',
          input: { version },
        });
        if (!object(saved) || saved.version !== version || !peopleValid(saved.people, false))
          return rejectApplicant(503);
        const contacts = new Map((saved.people as Record<string, string>[]).map((p) => [p.slot_id, p.email]));
        submittedPeople = (input.people as Record<string, string>[]).map((p) => ({
          ...p,
          email: p.email || contacts.get(p.slot_id) || '',
        }));
      }
      const result = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
        action: 'people',
        draft_id: draftId,
        operation: input.operation,
        input: { version, ...(save && { details: input.details, people: submittedPeople }) },
      });
      if (
        !object(result) ||
        !Number.isSafeInteger(result.version) ||
        (save ? result.version !== version && result.version !== version + 1 : result.version !== version) ||
        !['company', 'proprietorship', 'partnership', 'llp'].includes(result.entity as string) ||
        !object(result.details) ||
        !Array.isArray(result.people)
      )
        return rejectApplicant(503);
      const resultDetails = result.details;
      const details = Object.fromEntries(detailsKeys.map((k) => [k, resultDetails[k]]));
      const people = result.people.map((person) =>
        object(person) ? Object.fromEntries(personKeys.map((k) => [k, person[k]])) : person
      );
      if (!detailsValid(details) || !peopleValid(people, false)) return rejectApplicant(503);
      return {
        version: result.version,
        entity: result.entity,
        details,
        people: people.map((p: any) => ({ slot_id: p.slot_id, name: p.name, din: p.din, hasEmail: Boolean(p.email) })),
      };
    });
  }

  async financialVn(scope: VnDealerScope & { bankConsentOrigin: string }, input: unknown, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (
      !scope.admission ||
      scope.admission.issuerOrgId !== scope.organizationId ||
      scope.vn.actorOrganizationId !== scope.organizationId ||
      Buffer.byteLength(scope.admission.hmacSecret) < 32 ||
      !exactHttpsOrigin(scope.bankConsentOrigin)
    )
      return rejectApplicant(503);
    if (
      !object(input) ||
      !['bank', 'gst'].includes(input.purpose as string) ||
      !['start', 'status', 'sync', 'options', 'attach'].includes(input.operation as string)
    )
      return rejectApplicant(400);
    const purpose = input.purpose as FinancialPurpose;
    const operation = input.operation as 'start' | 'status' | 'sync' | 'options' | 'attach';
    const allowed =
      operation === 'start'
        ? ['purpose', 'operation', 'mobile']
        : operation === 'attach'
          ? ['purpose', 'operation', 'key']
          : ['purpose', 'operation'];
    if (Object.keys(input).length !== allowed.length || Object.keys(input).some((name) => !allowed.includes(name)))
      return rejectApplicant(400);
    const mobile = operation === 'start' ? normalizeApplicantPhone(input.mobile) : null;
    if (operation === 'start' && !mobile) return rejectApplicant(400);
    if (operation === 'attach' && (typeof input.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.key)))
      return rejectApplicant(400);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state || !state.publicVn || !verifiedPublicActor(scope, state)) return rejectApplicant(401);
      const draftId = state.vnAdmissionDraftId;
      if (!draftId || !uuidPattern.test(draftId)) return rejectApplicant(409);
      const attemptKey = purpose === 'bank' ? 'bankAa' : 'gstAa';
      const attempt = state[attemptKey];
      if (operation === 'start' && attempt && attempt.mobile !== mobile) return rejectApplicant(409);
      if (operation !== 'start' && (!attempt?.requestId || !uuidPattern.test(attempt.requestId)))
        return rejectApplicant(409);
      const ref = operation === 'attach' && typeof input.key === 'string' ? attempt?.choices?.[input.key] : undefined;
      if (operation === 'attach' && !ref) return rejectApplicant(409);
      if (operation === 'start' && !attempt) {
        state[attemptKey] = { mobile: mobile! };
        await this.sessions.save(key, state);
      }
      const current = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
        action: 'resume',
        draft_id: draftId,
      });
      if (
        !object(current) ||
        current.draft_id !== draftId ||
        !Number.isSafeInteger(current.version) ||
        (current.version as number) < 1 ||
        current.status !== 'in_progress'
      )
        return rejectApplicant(409);
      const version = current.version as number;
      const requestId = operation === 'start' ? `public-dealer-${purpose}:${draftId}` : attempt!.requestId!;
      const result = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
        action: 'financial',
        draft_id: draftId,
        purpose,
        operation,
        input: { version, request_id: requestId, ...(mobile && { mobile }), ...(ref && { linked_account_ref: ref }) },
      });
      if (operation === 'options') {
        const accounts = this.financialAccounts(
          purpose === 'gst' && object(result) ? { gst_accounts: result.accounts } : result,
          purpose
        );
        const choices: Record<string, string> = {};
        const safe = accounts.map(({ ref: accountRef, masked }) => {
          const choice = newApplicantHandle();
          choices[choice] = accountRef;
          return purpose === 'bank'
            ? { key: choice, maskedAccountNumber: masked }
            : { key: choice, maskedGstin: masked };
        });
        state[attemptKey] = { ...attempt!, choices };
        await this.sessions.save(key, state);
        return { accounts: safe };
      }
      if (operation === 'attach') {
        if (
          !object(result) ||
          !Number.isSafeInteger(result.version) ||
          (result.version !== version && result.version !== version + 1)
        )
          return rejectApplicant(503);
        state[attemptKey] = undefined;
        await this.sessions.save(key, state);
        return { version: result.version };
      }
      if (!object(result)) return rejectApplicant(503);
      const { id: request, ...safe } = this.financialView(
        { ...result, integration: 'saafe' },
        scope.bankConsentOrigin,
        attempt?.requestId
      );
      if (operation === 'start') {
        state[attemptKey] = { mobile: mobile!, requestId: request };
        await this.sessions.save(key, state);
      }
      return safe;
    });
  }

  private async voltcredIntakeRequest(
    scope: PublicDealerScope,
    userId: string,
    operation: 'lookup' | 'open',
    input: Payload
  ) {
    const suffix = operation === 'lookup' ? '/lookup' : '';
    const response = await this.fetcher(
      `${publicActorScope(scope).destinyOrigin}/v1/channel-partners/intakes${suffix}`,
      {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', 'x-gct-org-id': scope.organizationId, 'x-gct-user-id': userId },
        body: JSON.stringify({ input }),
      }
    );
    if (!response.ok) return rejectApplicant(response.status === 409 ? 409 : 503);
    return response.json();
  }

  async lookupVoltcred(scope: PublicDealerScope, input: unknown, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (
      !object(input) ||
      Object.keys(input).length !== 1 ||
      typeof input.pan !== 'string' ||
      !panPattern.test(input.pan)
    )
      return rejectApplicant(400);
    const pan = input.pan;
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      const actor = verifiedPublicActor(scope, state);
      if (!state || !actor) return rejectApplicant(401);
      if (state.draftId && state.pan !== pan) return rejectApplicant(409);
      const result = await this.voltcredIntakeRequest(scope, actor.userId, 'lookup', {
        pan,
        referral_token: state.referral,
      });
      const category = { C: 'company', F: 'firm', P: 'proprietorship' }[pan[3]];
      if (result?.status === 'new' && result.entity === category && !state.draftId) {
        await this.sessions.save(key, { ...state, pan });
        return { state: 'details' as const, category };
      }
      if (result?.status !== 'resume') return rejectApplicant(503);
      const draft = voltcredDraft(result.intake, scope.organizationId);
      if (state.draftId && state.draftId !== draft.id) return rejectApplicant(409);
      await this.sessions.save(key, { ...state, pan, draftId: draft.id });
      return { state: 'resume' as const, draft };
    });
  }

  async openVoltcred(scope: PublicDealerScope, input: unknown, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (
      !object(input) ||
      Object.keys(input).some((name) => !['businessName', 'applicantName', 'firmType'].includes(name))
    )
      return rejectApplicant(400);
    const { businessName, applicantName, firmType } = input;
    if (
      typeof businessName !== 'string' ||
      !businessName.trim() ||
      businessName.length > 255 ||
      typeof applicantName !== 'string' ||
      !applicantName.trim() ||
      applicantName.length > 255
    )
      return rejectApplicant(400);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      const actor = verifiedPublicActor(scope, state);
      if (!state || !actor) return rejectApplicant(401);
      const pan = state.pan;
      if (!pan || !panPattern.test(pan) || state.draftId) return rejectApplicant(409);
      if (pan[3] === 'F' ? firmType !== 'llp' && firmType !== 'partnership' : firmType !== undefined)
        return rejectApplicant(400);
      const role = { C: 'Director', P: 'Proprietor', F: firmType === 'llp' ? 'Designated partner' : 'Partner' }[pan[3]];
      const result = await this.voltcredIntakeRequest(scope, actor.userId, 'open', {
        referral_token: state.referral,
        dossier: {
          details: {
            pan,
            partner_name: businessName.trim(),
            email: actor.email,
            ...(typeof firmType === 'string' && { firm_type: firmType }),
          },
          people: [
            { id: 'person1', user_id: actor.userId, name: applicantName.trim(), role, kyc_contact: actor.email },
          ],
        },
      });
      const draft = voltcredDraft(result, scope.organizationId);
      await this.sessions.save(key, { ...state, draftId: draft.id });
      return { state: 'draft' as const, draft };
    });
  }

  private async readVoltcredDraft(scope: PublicDealerScope, state: State) {
    const actor = verifiedPublicActor(scope, state);
    if (!actor || !state.draftId || !state.pan) return rejectApplicant(401);
    const headers = { 'x-gct-org-id': scope.organizationId, 'x-gct-user-id': actor.userId };
    const response = await this.fetcher(
      `${publicActorScope(scope).destinyOrigin}/v1/channel-partners/intakes/${state.draftId}`,
      {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
        headers,
      }
    );
    if (!response.ok) return rejectApplicant(503);
    const data = await response.json();
    const draft = voltcredDraft(data, scope.organizationId);
    if (draft.id !== state.draftId) return rejectApplicant(409);
    return { draft, canWrite: data.can_write === true, pan: state.pan, headers, data };
  }

  private async financialDraft(scope: VoltcredBankScope, state: State, purpose: FinancialPurpose) {
    const { draft, canWrite, pan, headers } = await this.readVoltcredDraft(scope, state);
    if (draft.stage !== purpose || !canWrite) return rejectApplicant(409);
    return { ...draft, pan, headers };
  }

  private financialView(result: unknown, origin: string, expectedId?: string) {
    const statuses = [
      'unknown',
      'pending',
      'completed',
      'failed',
      'cancelled',
      'not_started',
      'cancel_requested',
      'cancel_unknown',
    ];
    if (
      !object(result) ||
      typeof result.id !== 'string' ||
      !uuidPattern.test(result.id) ||
      (expectedId && result.id !== expectedId) ||
      result.integration !== 'saafe' ||
      typeof result.status !== 'string' ||
      !statuses.includes(result.status)
    )
      return rejectApplicant(503);
    let consentUrl: string | undefined;
    if (result.status === 'pending' && result.gateway_url !== undefined) {
      if (typeof result.gateway_url !== 'string' || result.gateway_url.length > 4096) return rejectApplicant(503);
      try {
        const url = new URL(result.gateway_url);
        if (url.origin !== origin || url.username || url.password || url.protocol !== 'https:')
          return rejectApplicant(503);
        consentUrl = url.href;
      } catch {
        return rejectApplicant(503);
      }
    }
    return { id: result.id, status: result.status, ...(consentUrl && { consentUrl }) };
  }

  async startFinancialVoltcred(
    purpose: FinancialPurpose,
    scope: VoltcredBankScope,
    input: unknown,
    id: string | undefined
  ) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    const mobile = object(input) && Object.keys(input).length === 1 ? normalizeApplicantPhone(input.mobile) : null;
    if (!exactHttpsOrigin(scope.bankConsentOrigin) || !mobile) return rejectApplicant(400);
    return this.sessions.withLock(key, async () => {
      const attemptKey = purpose === 'bank' ? 'bankAa' : 'gstAa';
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(401);
      const draft = await this.financialDraft(scope, state, purpose);
      if (state[attemptKey] && state[attemptKey].mobile !== mobile) return rejectApplicant(409);
      if (!state[attemptKey]) await this.sessions.save(key, { ...state, [attemptKey]: { mobile } });
      // Use the same reservation key after a lost response so Destiny can return the existing attempt.
      const requestId = `public-dealer-${purpose}:${draft.id}`;
      const response = await this.fetcher(
        `${publicActorScope(scope).destinyOrigin}/v1/channel-partners/financial-data`,
        {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(45000),
          headers: { 'Content-Type': 'application/json', ...draft.headers },
          body: JSON.stringify({
            input: {
              purpose,
              request_id: requestId,
              pan: draft.pan,
              mobile,
              draft_id: draft.id,
              version: draft.version,
            },
          }),
        }
      );
      if (!response.ok) return rejectApplicant(response.status === 409 ? 409 : 503);
      const { id: request, ...safe } = this.financialView(
        await response.json(),
        scope.bankConsentOrigin,
        state[attemptKey]?.requestId
      );
      await this.sessions.save(key, { ...state, [attemptKey]: { mobile, requestId: request } });
      return safe;
    });
  }

  async statusFinancialVoltcred(
    purpose: FinancialPurpose,
    scope: VoltcredBankScope,
    input: unknown,
    id: string | undefined
  ) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (!exactHttpsOrigin(scope.bankConsentOrigin) || !object(input) || Object.keys(input).length)
      return rejectApplicant(400);
    return this.sessions.withLock(key, async () => {
      const attemptKey = purpose === 'bank' ? 'bankAa' : 'gstAa';
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(401);
      const draft = await this.financialDraft(scope, state, purpose);
      const requestId = state[attemptKey]?.requestId;
      if (!requestId || !uuidPattern.test(requestId)) return rejectApplicant(409);
      const response = await this.fetcher(
        `${publicActorScope(scope).destinyOrigin}/v1/channel-partners/financial-data/${requestId}?draft_id=${draft.id}&purpose=${purpose}`,
        {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
          headers: draft.headers,
        }
      );
      if (!response.ok) return rejectApplicant(503);
      const { id: _requestId, ...safe } = this.financialView(await response.json(), scope.bankConsentOrigin, requestId);
      return safe;
    });
  }

  private async financialAction(
    scope: VoltcredBankScope,
    purpose: FinancialPurpose,
    attempt: FinancialAttempt | undefined,
    draft: Awaited<ReturnType<DealerOnboarding['financialDraft']>>,
    action: 'sync' | 'options'
  ) {
    const requestId = attempt?.requestId;
    if (!requestId || !uuidPattern.test(requestId)) return rejectApplicant(409);
    const response = await this.fetcher(
      `${publicActorScope(scope).destinyOrigin}/v1/channel-partners/financial-data/${requestId}/${action === 'sync' ? action : purpose + '-options'}?draft_id=${draft.id}&purpose=${purpose}`,
      {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(action === 'sync' ? 45000 : 5000),
        headers: draft.headers,
      }
    );
    if (!response.ok) return rejectApplicant(response.status === 409 ? 409 : 503);
    return response.json();
  }

  private financialAccounts(data: unknown, purpose: FinancialPurpose) {
    const accounts = object(data) && data[purpose === 'bank' ? 'accounts' : 'gst_accounts'];
    if (!Array.isArray(accounts) || accounts.length > 100) return rejectApplicant(503);
    const seen = new Set<string>();
    const mask = purpose === 'bank' ? /^[Xx*]+\d{1,4}$/ : /^[0-9]{2}[Xx*]{10}[0-9A-Z]{3}$/;
    return accounts.map((account: unknown) => {
      if (!object(account)) return rejectApplicant(503);
      const ref = account.linked_account_ref;
      const masked = account[purpose === 'bank' ? 'masked_account_number' : 'masked_gstin'];
      if (
        typeof ref !== 'string' ||
        !ref ||
        ref.length > 512 ||
        seen.has(ref) ||
        typeof masked !== 'string' ||
        masked.length > 128 ||
        !mask.test(masked)
      )
        return rejectApplicant(503);
      seen.add(ref);
      return { ref, masked };
    });
  }

  async syncFinancialVoltcred(
    purpose: FinancialPurpose,
    scope: VoltcredBankScope,
    input: unknown,
    id: string | undefined
  ) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (!exactHttpsOrigin(scope.bankConsentOrigin) || !object(input) || Object.keys(input).length)
      return rejectApplicant(400);
    return this.sessions.withLock(key, async () => {
      const attemptKey = purpose === 'bank' ? 'bankAa' : 'gstAa';
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(401);
      const draft = await this.financialDraft(scope, state, purpose);
      const { id: _id, ...safe } = this.financialView(
        await this.financialAction(scope, purpose, state[attemptKey], draft, 'sync'),
        scope.bankConsentOrigin,
        state[attemptKey]?.requestId
      );
      return safe;
    });
  }

  async optionsFinancialVoltcred(
    purpose: FinancialPurpose,
    scope: VoltcredBankScope,
    input: unknown,
    id: string | undefined
  ) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (!exactHttpsOrigin(scope.bankConsentOrigin) || !object(input) || Object.keys(input).length)
      return rejectApplicant(400);
    return this.sessions.withLock(key, async () => {
      const attemptKey = purpose === 'bank' ? 'bankAa' : 'gstAa';
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(401);
      const draft = await this.financialDraft(scope, state, purpose);
      const attempt = state[attemptKey];
      if (!attempt?.requestId) return rejectApplicant(409);
      const accounts = this.financialAccounts(
        await this.financialAction(scope, purpose, state[attemptKey], draft, 'options'),
        purpose
      );
      const choices: Record<string, string> = {};
      const safe = accounts.map(({ ref, masked }) => {
        const choice = newApplicantHandle();
        choices[choice] = ref;
        return purpose === 'bank' ? { key: choice, maskedAccountNumber: masked } : { key: choice, maskedGstin: masked };
      });
      await this.sessions.save(key, { ...state, [attemptKey]: { ...attempt, choices } });
      return { accounts: safe };
    });
  }

  async attachFinancialVoltcred(
    purpose: FinancialPurpose,
    scope: VoltcredBankScope,
    input: unknown,
    id: string | undefined
  ) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    if (
      !exactHttpsOrigin(scope.bankConsentOrigin) ||
      !object(input) ||
      Object.keys(input).length !== 1 ||
      typeof input.key !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.key)
    )
      return rejectApplicant(400);
    const choice = input.key;
    return this.sessions.withLock(key, async () => {
      const attemptKey = purpose === 'bank' ? 'bankAa' : 'gstAa';
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(401);
      const draft = await this.financialDraft(scope, state, purpose);
      const attempt = state[attemptKey];
      const ref = attempt?.choices?.[choice];
      if (!ref || !attempt?.requestId) return rejectApplicant(409);
      const accounts = this.financialAccounts(
        await this.financialAction(scope, purpose, state[attemptKey], draft, 'options'),
        purpose
      );
      if (!accounts.some((account) => account.ref === ref)) return rejectApplicant(409);
      const response = await this.fetcher(
        `${publicActorScope(scope).destinyOrigin}/v1/channel-partners/intakes/${draft.id}/financial-data`,
        {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(45000),
          headers: { 'Content-Type': 'application/json', ...draft.headers },
          body: JSON.stringify({
            input: { version: draft.version, purpose, request_id: attempt.requestId, linked_account_ref: ref },
          }),
        }
      );
      if (!response.ok) return rejectApplicant(response.status === 409 ? 409 : 503);
      const data = await response.json();
      const result = voltcredDraft(data, scope.organizationId);
      if (
        result.id !== draft.id ||
        !result.stage ||
        dealerStages.indexOf(result.stage) <= dealerStages.indexOf(purpose) ||
        result.version <= draft.version
      )
        return rejectApplicant(503);
      await this.sessions.save(key, { ...state, [attemptKey]: undefined });
      return { draft: result };
    });
  }

  async evidenceStatusVoltcred(scope: PublicDealerScope, input: unknown, id: string | undefined) {
    if (!object(input) || Object.keys(input).length) return rejectApplicant(400);
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(401);
      const { draft, canWrite, data } = await this.readVoltcredDraft(scope, state);
      if (!canWrite || !isVoltcredEvidenceStage(draft.stage)) return rejectApplicant(409);
      return projectVoltcredEvidence(draft.stage, data);
    });
  }

  async executionVn(
    scope: VnDealerScope & { ownerHmacKey?: string; kycOrigin?: string },
    input: unknown,
    id: string | undefined
  ) {
    if (
      !object(input) ||
      (input.action !== 'STATUS' && input.action !== 'SAVE_EXECUTION') ||
      Object.keys(input).length !== (input.action === 'STATUS' ? 1 : scope.admission ? 3 : 2) ||
      (scope.admission &&
        input.action === 'SAVE_EXECUTION' &&
        (!Number.isSafeInteger(input.version) || (input.version as number) < 1))
    )
      return rejectApplicant(400);
    const action = input.action;
    const names = [
      'legal_name',
      'registered_address',
      'additional_address',
      'signatory_name',
      'signatory_designation',
      'bank_account_holder',
      'bank_name',
      'bank_account_number',
      'confirm_account_number',
      'bank_ifsc',
      'approved_outlets',
    ];
    if (action === 'SAVE_EXECUTION') {
      if (!object(input.fields)) return rejectApplicant(400);
      const fields = input.fields;
      const keys = Object.keys(fields);
      const allowed = [...names, ...(keys.includes('registration_details') ? ['registration_details'] : [])];
      if (
        keys.length !== allowed.length ||
        !allowed.every(
          (k) =>
            Object.prototype.hasOwnProperty.call(fields, k) &&
            typeof fields[k] === 'string' &&
            (fields[k] as string).length <= 2000
        )
      )
        return rejectApplicant(400);
    }
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state || !state.referral || !state.vnActor) return rejectApplicant(401);
      if (scope.admission) {
        if (
          scope.admission.issuerOrgId !== scope.organizationId ||
          scope.vn.actorOrganizationId !== scope.organizationId ||
          Buffer.byteLength(scope.admission.hmacSecret) < 32
        )
          return rejectApplicant(503);
        if (!state.publicVn || !verifiedPublicActor(scope, state)) return rejectApplicant(401);
        const draftId = state.vnAdmissionDraftId;
        if (!draftId || !uuidPattern.test(draftId)) return rejectApplicant(409);
        const snapshot = await this.admitVn(scope, state, scope.admission.hmacSecret, {
          action: 'resume',
          draft_id: draftId,
        });
        if (
          !object(snapshot) ||
          snapshot.draft_id !== draftId ||
          !Number.isSafeInteger(snapshot.version) ||
          (snapshot.version as number) < 1 ||
          snapshot.status !== 'in_progress' ||
          snapshot.intake_stage !== 'additional_documents' ||
          (action === 'SAVE_EXECUTION' && input.version !== snapshot.version)
        )
          return rejectApplicant(409);
        const version = snapshot.version as number;
        const send = async (operation: 'STATUS' | 'SAVE') => {
          const result = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
            action: 'execution',
            draft_id: draftId,
            operation,
            version,
            ...(operation === 'SAVE' && { fields: input.fields }),
          });
          if (
            !object(result) ||
            !Number.isSafeInteger(result.version) ||
            (result.version as number) < 1 ||
            ![null, 'registered_entity', 'registration_details'].includes(result.execution as any)
          )
            return rejectApplicant(503);
          return {
            version: result.version as number,
            execution: result.execution as null | 'registered_entity' | 'registration_details',
          };
        };
        const current = await send('STATUS');
        if (current.version !== version) return rejectApplicant(409);
        if (action === 'STATUS') return current;
        if (
          !current.execution ||
          !object(input.fields) ||
          Object.prototype.hasOwnProperty.call(input.fields, 'registration_details') !==
            (current.execution === 'registration_details')
        )
          return rejectApplicant(409);
        const saved = await send('SAVE');
        if (saved.version <= version || saved.execution !== null) return rejectApplicant(503);
        return saved;
      }
      if (!scope.ownerHmacKey || !scope.kycOrigin) return rejectApplicant(503);
      const ownerScope = scope as VnDealerScope & {
        ownerHmacKey: string;
        kycOrigin: string;
      };
      const { draft, canWrite } = await this.readVoltcredDraft(scope, state);
      if (!canWrite || draft.stage !== 'additional_documents') return rejectApplicant(409);
      const project = (data: unknown) => {
        if (
          !object(data) ||
          typeof data.version !== 'number' ||
          !Number.isSafeInteger(data.version) ||
          data.version < 1 ||
          !(
            data.execution === null ||
            data.execution === 'registered_entity' ||
            data.execution === 'registration_details'
          ) ||
          !['pending', 'saved', 'unavailable'].includes(data.execution_readiness as string) ||
          (data.execution_readiness === 'pending') !== (data.execution !== null)
        )
          return rejectApplicant(503);
        return { version: data.version, execution: data.execution, execution_readiness: data.execution_readiness };
      };
      const current = project(
        await this.publicOwnerRequest(ownerScope, state, 'referral-dossier', { action: 'STATUS' })
      );
      if (current.version !== draft.version) return rejectApplicant(409);
      if (action === 'STATUS')
        return { execution: current.execution, execution_readiness: current.execution_readiness };
      if (
        current.execution_readiness !== 'pending' ||
        !current.execution ||
        !object(input.fields) ||
        Object.prototype.hasOwnProperty.call(input.fields, 'registration_details') !==
          (current.execution === 'registration_details')
      )
        return rejectApplicant(409);
      const saved = project(
        await this.publicOwnerRequest(ownerScope, state, 'referral-dossier', {
          action,
          version: current.version,
          fields: input.fields,
        })
      );
      if (saved.version <= current.version || saved.execution_readiness !== 'saved') return rejectApplicant(503);
      return { execution: saved.execution, execution_readiness: saved.execution_readiness };
    });
  }

  async reviewVoltcred(scope: PublicDealerScope, input: unknown, id: string | undefined) {
    if (
      !object(input) ||
      Object.keys(input).length !== 1 ||
      (input.action !== 'STATUS' && input.action !== 'PREPARE' && input.action !== 'SUBMIT')
    )
      return rejectApplicant(400);
    const action = input.action;
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state || !state.referral) return rejectApplicant(401);
      if ('vn' in scope) {
        if (
          !scope.admission ||
          scope.admission.issuerOrgId !== scope.organizationId ||
          scope.vn.actorOrganizationId !== scope.organizationId ||
          Buffer.byteLength(scope.admission.hmacSecret) < 32
        )
          return rejectApplicant(503);
        if (!state.publicVn || !verifiedPublicActor(scope, state)) return rejectApplicant(401);
        const draftId = state.vnAdmissionDraftId;
        if (!draftId || !uuidPattern.test(draftId)) return rejectApplicant(409);
        const snapshot = await this.admitVn(scope, state, scope.admission.hmacSecret, {
          action: 'resume',
          draft_id: draftId,
        });
        if (
          !object(snapshot) ||
          snapshot.draft_id !== draftId ||
          !Number.isSafeInteger(snapshot.version) ||
          (snapshot.version as number) < 1 ||
          !['in_progress', 'changes_requested', 'submitted'].includes(snapshot.status as string) ||
          !['additional_documents', 'review'].includes(snapshot.intake_stage as string)
        )
          return rejectApplicant(409);
        if (
          action !== 'STATUS' &&
          (snapshot.intake_stage !== 'additional_documents' || snapshot.status === 'submitted')
        )
          return rejectApplicant(409);
        const send = async (operation: typeof action, version: number) => {
          const result = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
            action: 'completion',
            draft_id: draftId,
            operation,
            version,
          });
          const allowed: Record<string, string | null> = {
            evidence_ready: 'PREPARE',
            ready_to_submit: 'SUBMIT',
            submitted: null,
            evidence_required: null,
            bank_details_required: null,
            bank_verification_required: null,
            agreement_ready: null,
            signing_pending: null,
            review_pending: null,
            closed: null,
            agreement_unavailable: null,
          };
          if (
            !object(result) ||
            typeof result.stage !== 'string' ||
            !Object.prototype.hasOwnProperty.call(allowed, result.stage) ||
            !Number.isSafeInteger(result.version) ||
            (result.version as number) < version ||
            !Array.isArray(result.actions) ||
            result.actions.length !== (allowed[result.stage] ? 1 : 0) ||
            (allowed[result.stage] && result.actions[0] !== allowed[result.stage])
          )
            return rejectApplicant(503);
          return { stage: result.stage, version: result.version as number, action: allowed[result.stage] };
        };
        const current = await send('STATUS', snapshot.version as number);
        if (current.version !== snapshot.version || (snapshot.intake_stage === 'review' && current.action !== null))
          return rejectApplicant(409);
        if (action === 'STATUS') return { stage: current.stage, action: current.action };
        if (current.action !== action) return rejectApplicant(409);
        const result = await send(action, current.version);
        if (result.version <= current.version) return rejectApplicant(503);
        return { stage: result.stage, action: result.action };
      }
      const { draft, canWrite, headers } = await this.readVoltcredDraft(scope, state);
      if (!canWrite || draft.stage !== 'additional_documents') return rejectApplicant(409);
      const send = async (operation: typeof action, version?: number) => {
        const response = await this.fetcher(
          `${publicActorScope(scope).destinyOrigin}/v1/channel-partners/intakes/${draft.id}/referral-completion`,
          {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.timeout(operation === 'STATUS' ? 20000 : 30000),
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: { action: operation, referral_token: state.referral, ...(version !== undefined && { version }) },
            }),
          }
        );
        if (!response.ok) return rejectApplicant([409, 422].includes(response.status) ? 409 : 503);
        const result = await response.json();
        const allowed: Record<string, string | null> = {
          evidence_ready: 'PREPARE',
          ready_to_submit: 'SUBMIT',
          submitted: null,
          evidence_required: null,
          bank_details_required: null,
          review_pending: null,
          closed: null,
          agreement_unavailable: null,
        };
        if (
          !object(result) ||
          typeof result.stage !== 'string' ||
          !Object.prototype.hasOwnProperty.call(allowed, result.stage) ||
          typeof result.version !== 'number' ||
          !Number.isSafeInteger(result.version) ||
          result.version < draft.version ||
          !Array.isArray(result.actions) ||
          result.actions.length !== (allowed[result.stage] ? 1 : 0) ||
          (allowed[result.stage] && result.actions[0] !== allowed[result.stage])
        )
          return rejectApplicant(503);
        return { stage: result.stage, version: result.version, action: allowed[result.stage] };
      };
      const current = await send('STATUS');
      if (current.version !== draft.version) return rejectApplicant(409);
      if (action === 'STATUS') return { stage: current.stage, action: current.action };
      if (current.action !== action) return rejectApplicant(409);
      const result = await send(action, current.version);
      return { stage: result.stage, action: result.action };
    });
  }

  async agreementVoltcred(
    scope: (PublicOwnerScope & { signingOrigin?: string }) | VnDealerScope,
    input: unknown,
    id: string | undefined
  ) {
    if (
      !object(input) ||
      Object.keys(input).length !== 1 ||
      typeof input.action !== 'string' ||
      !['STATUS', 'VERIFY_BANK', 'FREEZE', 'REFRESH', 'SIGN'].includes(input.action)
    )
      return rejectApplicant(400);
    const action = input.action;
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state || !state.referral) return rejectApplicant(401);
      if ('vn' in scope && scope.admission) {
        if (!['STATUS', 'VERIFY_BANK', 'FREEZE', 'REFRESH'].includes(action)) return rejectApplicant(409);
        if (
          scope.admission.issuerOrgId !== scope.organizationId ||
          scope.vn.actorOrganizationId !== scope.organizationId ||
          Buffer.byteLength(scope.admission.hmacSecret) < 32
        )
          return rejectApplicant(503);
        if (!state.publicVn || !verifiedPublicActor(scope, state)) return rejectApplicant(401);
        const draftId = state.vnAdmissionDraftId;
        if (!draftId || !uuidPattern.test(draftId)) return rejectApplicant(409);
        const snapshot = await this.admitVn(scope, state, scope.admission.hmacSecret, {
          action: 'resume',
          draft_id: draftId,
        });
        if (
          !object(snapshot) ||
          snapshot.draft_id !== draftId ||
          !Number.isSafeInteger(snapshot.version) ||
          (snapshot.version as number) < 1
        )
          return rejectApplicant(409);
        if (snapshot.status === 'approved' && snapshot.intake_stage === 'completed') {
          if (action !== 'STATUS') return rejectApplicant(409);
          return { stage: 'completed', action: null, canSign: false, signed: true };
        }
        if (snapshot.status !== 'submitted' || snapshot.intake_stage !== 'agreement') return rejectApplicant(409);
        const send = async (operation: string, version: number) => {
          const result = await this.admitVn(scope, state, scope.admission!.hmacSecret, {
            action: 'completion',
            draft_id: draftId,
            operation,
            version,
          });
          const allowed: Record<string, string | null> = {
            bank_verification_required: 'VERIFY_BANK',
            agreement_pending: 'FREEZE',
            signing_pending: null,
            agreement_signed: null,
            completed: null,
            review_pending: null,
            agreement_unavailable: null,
          };
          if (
            !object(result) ||
            Object.keys(result).length !== 3 ||
            typeof result.stage !== 'string' ||
            !Object.prototype.hasOwnProperty.call(allowed, result.stage) ||
            !Number.isSafeInteger(result.version) ||
            (result.version as number) < version ||
            !Array.isArray(result.actions) ||
            (result.stage === 'signing_pending'
              ? !(result.actions.length === 0 || (result.actions.length === 1 && result.actions[0] === 'REFRESH'))
              : result.actions.length !== (allowed[result.stage] ? 1 : 0) ||
                (allowed[result.stage] && result.actions[0] !== allowed[result.stage])) ||
            (operation === 'REFRESH' && (result.version as number) > version + 1)
          )
            return rejectApplicant(503);
          return {
            stage: result.stage,
            version: result.version as number,
            action: result.stage === 'signing_pending' && result.actions.length ? 'REFRESH' : allowed[result.stage],
          };
        };
        const current = await send('STATUS', snapshot.version as number);
        if (current.version !== snapshot.version) return rejectApplicant(409);
        if (action === 'STATUS')
          return {
            stage: current.stage,
            action: current.action,
            canSign: false,
            signed: ['agreement_signed', 'completed'].includes(current.stage),
          };
        if (current.action !== action) return rejectApplicant(409);
        const result = await send(action, current.version);
        return {
          stage: result.stage,
          action: result.action,
          canSign: false,
          signed: ['agreement_signed', 'completed'].includes(result.stage),
        };
      }
      if (!('ownerHmacKey' in scope)) return rejectApplicant(503);
      const { draft, canWrite, headers, data } = await this.readVoltcredDraft(scope, state);
      if (draft.stage === 'completed' && action === 'STATUS')
        return { stage: 'completed', action: null, canSign: false, signed: true };
      if (!canWrite || draft.stage !== 'agreement') return rejectApplicant(409);
      const signable =
        ['prepared', 'requesting', 'requested'].includes(data.agreement?.status) &&
        exactHttpsOrigin(scope.signingOrigin);
      const send = async (operation: string, version?: number) => {
        const response = await this.fetcher(
          `${publicActorScope(scope).destinyOrigin}/v1/channel-partners/intakes/${draft.id}/referral-completion`,
          {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.timeout(operation === 'STATUS' ? 20000 : 30000),
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: { action: operation, referral_token: state.referral, ...(version !== undefined && { version }) },
            }),
          }
        );
        if (!response.ok) return rejectApplicant([409, 422].includes(response.status) ? 409 : 503);
        const result = await response.json();
        const allowed: Record<string, string | null> = {
          bank_details_required: null,
          bank_verification_required: 'VERIFY_BANK',
          agreement_ready: 'FREEZE',
          signing_pending: 'REFRESH',
          ready_to_submit: null,
          submitted: null,
          evidence_required: null,
          review_pending: null,
          closed: null,
          agreement_unavailable: null,
        };
        if (
          !object(result) ||
          typeof result.stage !== 'string' ||
          !Object.prototype.hasOwnProperty.call(allowed, result.stage) ||
          typeof result.version !== 'number' ||
          !Number.isSafeInteger(result.version) ||
          result.version < draft.version ||
          !Array.isArray(result.actions) ||
          result.actions.length !== (allowed[result.stage] ? 1 : 0) ||
          (allowed[result.stage] && result.actions[0] !== allowed[result.stage])
        )
          return rejectApplicant(503);
        return { stage: result.stage, version: result.version, action: allowed[result.stage] };
      };
      const current = await send('STATUS');
      if (current.version !== draft.version) return rejectApplicant(409);
      if (action === 'SIGN') {
        if (!signable || current.stage !== 'signing_pending') return rejectApplicant(409);
        const result = await this.publicOwnerRequest(scope, state, 'agreement/own-sign', { version: current.version });
        if (!object(result) || result.status !== 'requested') return rejectApplicant(503);
        return { status: 'requested', url: dealerProviderRedirect(result.url, scope.signingOrigin) };
      }
      if (action === 'STATUS')
        return {
          stage: current.stage,
          action: current.action,
          canSign: Boolean(signable && current.stage === 'signing_pending'),
          signed: data.agreement?.status === 'completed',
        };
      if (current.action !== action) return rejectApplicant(409);
      const result = await send(action, current.version);
      const updated = await this.readVoltcredDraft(scope, state);
      if (updated.draft.stage === 'completed')
        return { stage: 'completed', action: null, canSign: false, signed: true };
      if (updated.draft.stage !== 'agreement' || !updated.canWrite || updated.draft.version !== result.version)
        return rejectApplicant(409);
      const status = updated.data.agreement?.status;
      return {
        stage: result.stage,
        action: result.action,
        canSign: Boolean(
          result.stage === 'signing_pending' &&
          ['prepared', 'requesting', 'requested'].includes(status) &&
          exactHttpsOrigin(scope.signingOrigin)
        ),
        signed: status === 'completed',
      };
    });
  }

  private async publicOwnerRequest(scope: PublicOwnerScope, state: State, suffix: string, input: Payload) {
    const actor = verifiedPublicActor(scope, state);
    if (!actor || !state.draftId) return rejectApplicant(401);
    const path = `/v1/channel-partners/intakes/${state.draftId}/email-owner/${suffix}`;
    const issuedAt = String(Math.floor(Date.now() / 1000));
    const email = actor.email.trim().toLowerCase();
    const signature = createHmac('sha256', scope.ownerHmacKey)
      .update(
        JSON.stringify([
          'destiny-owner-email-v1',
          'POST',
          path,
          scope.organizationId,
          actor.userId,
          state.draftId,
          email,
          issuedAt,
        ]),
        'utf8'
      )
      .digest('hex');
    const response = await this.fetcher(`${publicActorScope(scope).destinyOrigin}${path}`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(input.action === 'STATUS' || suffix === 'kyc/status' ? 10000 : 25000),
      headers: {
        'Content-Type': 'application/json',
        'x-gct-org-id': scope.organizationId,
        'x-gct-user-id': actor.userId,
        'x-gct-owner-email': email,
        'x-gct-owner-issued-at': issuedAt,
        'x-gct-owner-signature': signature,
      },
      body: JSON.stringify({ input: { ...input, referral_token: state.referral } }),
    });
    if (!response.ok) return rejectApplicant([409, 422].includes(response.status) ? response.status : 503);
    return response.json();
  }

  private async publicOwnerCurrent(
    scope: PublicOwnerScope,
    state: State,
    snapshot?: Awaited<ReturnType<DealerOnboarding['readVoltcredDraft']>>
  ) {
    const { draft, canWrite } = snapshot ?? (await this.readVoltcredDraft(scope, state));
    if (draft.stage !== 'people' || !canWrite) return rejectApplicant(409);
    const [dossier, kyc] = await Promise.all([
      this.publicOwnerRequest(scope, state, 'referral-dossier', { action: 'STATUS' }),
      this.publicOwnerRequest(scope, state, 'kyc/status', {}),
    ]);
    if (
      !object(dossier) ||
      typeof dossier.version !== 'number' ||
      !Number.isSafeInteger(dossier.version) ||
      dossier.version < 1 ||
      !(dossier.own_din === null || dossier.own_din === 'DIN' || dossier.own_din === 'DPIN') ||
      !object(kyc) ||
      typeof kyc.person_id !== 'string' ||
      !/^(?:[1-9]\d{0,18}|person[a-zA-Z0-9_-]{1,40})$/.test(kyc.person_id) ||
      typeof kyc.status !== 'string' ||
      !ownerKycStatuses.includes(kyc.status) ||
      typeof kyc.version !== 'number' ||
      !Number.isSafeInteger(kyc.version) ||
      kyc.version < 1 ||
      !Array.isArray(kyc.actions) ||
      new Set(kyc.actions).size !== kyc.actions.length ||
      !kyc.actions.every((a: unknown) => typeof a === 'string' && ['START', 'SYNC', 'SELFIE'].includes(a))
    )
      return rejectApplicant(503);
    if (kyc.version !== draft.version || dossier.version !== draft.version) return rejectApplicant(409);
    const needsDin = dossier.own_din !== null;
    return {
      personId: kyc.person_id,
      version: draft.version,
      status: kyc.status,
      actions: [...kyc.actions, ...(needsDin ? ['SAVE_DIN'] : [])] as string[],
      needsDin,
    };
  }

  private publicOwnerView(current: Awaited<ReturnType<DealerOnboarding['publicOwnerCurrent']>>) {
    return { status: current.status, actions: current.actions, needsDin: current.needsDin };
  }

  private async publicOwnerAfter(scope: PublicOwnerScope, state: State) {
    const snapshot = await this.readVoltcredDraft(scope, state);
    if (isVoltcredEvidenceStage(snapshot.draft.stage)) {
      return { status: 'verified', actions: [], needsDin: false };
    }
    return this.publicOwnerView(await this.publicOwnerCurrent(scope, state, snapshot));
  }

  async publicOwnerVoltcred(scope: PublicOwnerScope, input: unknown, id: string | undefined) {
    if (
      !object(input) ||
      typeof input.action !== 'string' ||
      !['STATUS', 'START', 'SYNC', 'SAVE_DIN'].includes(input.action) ||
      (input.action === 'SAVE_DIN'
        ? Object.keys(input).length !== 2 || typeof input.din !== 'string' || !/^\d{8}$/.test(input.din)
        : Object.keys(input).length !== 1)
    )
      return rejectApplicant(400);
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(401);
      const current = await this.publicOwnerCurrent(scope, state);
      if (input.action === 'STATUS') return this.publicOwnerView(current);
      if (!current.actions.includes(input.action as string)) return rejectApplicant(409);
      let redirectUrl: string | undefined;
      if (input.action === 'SAVE_DIN') {
        await this.publicOwnerRequest(scope, state, 'referral-dossier', {
          action: 'SAVE_OWN_DIN',
          version: current.version,
          fields: { din: input.din },
        });
      } else {
        const restart = input.action === 'START' && ['failed', 'cancelled'].includes(current.status);
        const result = await this.publicOwnerRequest(
          scope,
          state,
          `people/${current.personId}/kyc/${String(input.action).toLowerCase()}`,
          {
            version: current.version,
            ...(restart && { restart }),
          }
        );
        if (!object(result) || typeof result.status !== 'string' || !ownerKycStatuses.includes(result.status))
          return rejectApplicant(503);
        if (input.action === 'START' && result.gateway_url != null)
          redirectUrl = dealerProviderRedirect(result.gateway_url, scope.kycOrigin);
      }
      return { ...(await this.publicOwnerAfter(scope, state)), ...(redirectUrl && { redirectUrl }) };
    });
  }

  async publicOwnerSelfieVoltcred(scope: PublicOwnerScope, read: () => Promise<Buffer>, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(401);
      const current = await this.publicOwnerCurrent(scope, state);
      if (current.status !== 'verified' || !current.actions.includes('SELFIE')) return rejectApplicant(409);
      await this.sessions.rate(scope, 'public-owner-selfie', verifiedPublicActor(scope, state)!.userId, 5, 60);
      const result = await this.publicOwnerRequest(scope, state, `people/${current.personId}/kyc/selfie`, {
        version: current.version,
        selfie: dealerSelfieData(await read()),
      });
      if (!object(result) || result.selfie_verified !== true) return rejectApplicant(503);
      return this.publicOwnerAfter(scope, state);
    });
  }

  async peopleStatusVoltcred(scope: PublicDealerScope, input: unknown, id: string | undefined) {
    if (!object(input) || Object.keys(input).length) return rejectApplicant(400);
    const key = this.sessions.key(scope, id);
    if (!key) return rejectApplicant(401);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(401);
      const { draft, canWrite, pan, data } = await this.readVoltcredDraft(scope, state);
      if (draft.stage !== 'people' || !canWrite) return rejectApplicant(409);
      const dossier = data.dossier;
      if (
        !object(dossier) ||
        !object(dossier.details) ||
        !Array.isArray(dossier.people) ||
        dossier.people.length > 30 ||
        !object(dossier.kyc)
      )
        return rejectApplicant(503);
      const kycByPerson = dossier.kyc;
      const needsDin = pan[3] === 'C' || (pan[3] === 'F' && dossier.details.firm_type === 'llp');
      const people = dossier.people.map((person: unknown) => {
        if (
          !object(person) ||
          typeof person.id !== 'string' ||
          !/^(?:[1-9]\d{0,18}|person[a-zA-Z0-9_-]{1,40})$/.test(person.id)
        )
          return rejectApplicant(503);
        const kyc = Object.prototype.hasOwnProperty.call(kycByPerson, person.id) ? kycByPerson[person.id] : undefined;
        if (
          person.name === '' &&
          Object.entries(person).every(([key, value]) => key === 'id' || value == null || value === '')
        )
          return {
            name: 'Pending invitation',
            role: 'Participant',
            needs_din: needsDin,
            kyc_complete: false,
            selfie_complete: false,
          };
        if (
          typeof person.name !== 'string' ||
          person.name.length > 255 ||
          (person.role != null && (typeof person.role !== 'string' || person.role.length > 255))
        )
          return rejectApplicant(503);
        return {
          name: person.name.trim() || 'Name pending',
          role: (typeof person.role === 'string' && person.role.trim()) || 'Role pending',
          needs_din: needsDin,
          kyc_complete: object(kyc) && kyc.status === 'verified',
          selfie_complete: object(kyc) && kyc.selfie_verified === true,
        };
      });
      return { people };
    });
  }

  async uploadVoltcredEvidence(scope: PublicDealerScope, read: () => Promise<unknown>, id: string | undefined) {
    const key = this.sessions.key(scope, id);
    if (!key || !id) return rejectApplicant(401);
    const session = await this.sessions.get(key);
    if (!session?.draftId || !verifiedPublicActor(scope, session)) return rejectApplicant(401);
    await this.sessions.rate(scope, 'upload', id, 20, 120);
    const input = await read();
    if (
      !object(input) ||
      Object.keys(input).some((name) => !['code', 'file', 'location'].includes(name)) ||
      typeof input.code !== 'string' ||
      !/^[a-z_]{1,64}$/.test(input.code) ||
      !Buffer.isBuffer(input.file) ||
      !input.file.length ||
      input.file.length > maxDealerDocumentBytes
    )
      return rejectApplicant(400);
    const { code, file, location } = input;
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state) return rejectApplicant(401);
      const { draft, canWrite, headers, data } = await this.readVoltcredDraft(scope, state);
      if (!canWrite || !isVoltcredEvidenceStage(draft.stage)) return rejectApplicant(409);
      const evidence = projectVoltcredEvidence(draft.stage, data);
      const offered = evidence.document_actions.find((action) => action.code === code);
      if (!offered || offered.count >= (offered.code === 'additional_documents' ? 24 : 1)) return rejectApplicant(409);
      const valid =
        offered.mode === 'camera'
          ? validCameraLocation(location) && validDocument('photo', file, undefined)
          : validDocument('file', file, location);
      if (!valid) return rejectApplicant(400);

      const body = new FormData();
      body.append('metadata', JSON.stringify({ version: draft.version, ...(location !== undefined && { location }) }));
      body.append('file', new Blob([new Uint8Array(file)]), 'evidence');
      const response = await this.fetcher(
        `${publicActorScope(scope).destinyOrigin}/v1/channel-partners/intakes/${draft.id}/documents/${offered.code}`,
        {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(35000),
          headers,
          body,
        }
      );
      if (!response.ok) return rejectApplicant([409, 422].includes(response.status) ? 409 : 503);
      const receipt = await response.json();
      const fileId =
        typeof receipt?.file_id === 'number' && Number.isSafeInteger(receipt.file_id)
          ? String(receipt.file_id)
          : receipt?.file_id;
      if (
        typeof fileId !== 'string' ||
        !/^[1-9]\d{0,18}$/.test(fileId) ||
        !Number.isSafeInteger(receipt?.version) ||
        receipt.version < draft.version
      )
        return rejectApplicant(503);
      const current = await this.readVoltcredDraft(scope, state);
      if (current.draft.version < receipt.version) return rejectApplicant(503);
      return { state: 'resume' as const, draft: current.draft };
    });
  }

  async statusVoltcred(scope: PublicDealerScope, input: unknown, id: string | undefined) {
    if (!object(input) || Object.keys(input).length) return rejectApplicant(400);
    const key = this.sessions.key(scope, id);
    const state = key ? await this.sessions.get(key) : null;
    if (!state || !verifiedPublicActor(scope, state)) return { state: 'invite' as const };
    if (!state.draftId || !key) return { state: 'pan' as const };
    return this.sessions.withLock(key, async () => {
      const current = await this.sessions.get(key);
      if (!current) return rejectApplicant(401);
      const { draft, canWrite } = await this.readVoltcredDraft(scope, current);
      const stageIndex = draft.stage ? dealerStages.indexOf(draft.stage) : -1;
      const bankAa = stageIndex > dealerStages.indexOf('bank') ? undefined : current.bankAa;
      const gstAa = stageIndex > dealerStages.indexOf('gst') ? undefined : current.gstAa;
      if (bankAa !== current.bankAa || gstAa !== current.gstAa)
        await this.sessions.save(key, { ...current, bankAa, gstAa });
      return { state: 'resume' as const, draft: { ...draft, ...(draft.stage === 'agreement' && { canWrite }) } };
    });
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

  private async gst(scope: ApplicantScope, state: State, key: string, command: Extract<Operation, { kind: 'gst' }>) {
    if (!state.draftId || !state.phone || (command.action === 'ATTACH' && !state.gstRequestId))
      return rejectApplicant(409);
    await this.sessions.rate(scope, 'dealer-gst', state.phone, 20, 60);
    const action = state.gstRequestId && command.action === 'STATUS' ? 'CHECK' : command.action;
    const result = await this.fury.request(
      scope,
      docs.gst,
      {
        draftId: state.draftId,
        action,
        ...(state.gstRequestId && { requestId: state.gstRequestId }),
        ...(command.account && { account: command.account }),
      },
      state
    );
    const { status, requestId, consentUrl, accounts } = result;
    if (
      typeof status !== 'string' ||
      !['not_started', 'pending', 'completed', 'failed', 'cancelled', 'unknown', 'attached'].includes(status) ||
      (requestId != null && (typeof requestId !== 'string' || !uuidPattern.test(requestId))) ||
      !Array.isArray(accounts)
    )
      return rejectApplicant(503);
    if (typeof requestId === 'string' && requestId !== state.gstRequestId)
      await this.sessions.save(key, { ...state, gstRequestId: requestId });
    const choices = accounts
      .filter(
        (account: unknown) =>
          object(account) &&
          typeof account.key === 'string' &&
          gstChoicePattern.test(account.key) &&
          typeof account.maskedGstin === 'string' &&
          /^[0-9]{2}X{10}[A-Z0-9*]{3}$/.test(account.maskedGstin)
      )
      .map(({ key, maskedGstin }) => ({ key, maskedGstin }));
    let redirect;
    if (status === 'pending' && typeof consentUrl === 'string' && consentUrl.length <= 4096) {
      try {
        const url = new URL(consentUrl);
        if (url.protocol === 'https:' && !url.username && !url.password) redirect = url.href;
      } catch {
        return rejectApplicant(503);
      }
    }
    return { state: 'gstAa', status, accounts: choices, ...(redirect && { consentUrl: redirect }) };
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
    return {
      status,
      actions: actions.filter((action) => action !== 'SIGN' || exactHttpsOrigin(scope.signingOrigin)),
      version,
    };
  }

  async ownerKyc(scope: OwnerKycScope, input: unknown, id: string | undefined) {
    if (
      !object(input) ||
      Object.keys(input).length !== 1 ||
      !['STATUS', 'START', 'SYNC', 'SIGN'].includes(String(input.action))
    )
      return rejectApplicant(400);
    const { action } = input;
    return this.withOwnerKyc(scope, id, async (state, binding, origin) => {
      const { status, actions, version } = await this.ownerKycStatus(scope, state, binding);
      if (action === 'STATUS') return { status, actions };
      if (!actions.includes(action)) return rejectApplicant(409);
      const result = await this.fury.request(scope, ownerKycQuery, { ...binding, action, version }, state);
      if (action === 'SIGN') {
        if (result.status !== 'requested') return rejectApplicant(503);
        return { status: 'requested', redirectUrl: dealerProviderRedirect(result.redirectUrl, scope.signingOrigin) };
      }
      if (typeof result.status !== 'string' || !ownerKycStatuses.includes(result.status)) return rejectApplicant(503);
      const view = { status: result.status };
      if (action !== 'START' || result.redirectUrl == null) return view;
      return { ...view, redirectUrl: dealerProviderRedirect(result.redirectUrl, origin) };
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
      if (state.publicVoltcred || state.publicVn) return rejectApplicant(409);
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
      if (command.kind === 'gst') return this.gst(scope, state, key, command);
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
              draftId: state.draftId,
              fields: command.fields,
            },
            state
          ),
          state.draftId
        );
      }
      if (state.draftId) return this.status(scope, state, key);
      const gstin = command.fields.gstin?.trim().toUpperCase();
      if (gstin !== undefined && (!gstPattern.test(gstin) || gstin.slice(2, 12) !== state.pan))
        return rejectApplicant(400);
      const result = await this.fury.request(
        scope,
        docs.start,
        {
          referral_token: state.referral,
          input: { ...command.fields, ...(gstin !== undefined && { gstin }), pan: state.pan },
        },
        state
      );
      const view = draftView(result);
      await this.sessions.save(key, { ...state, draftId: view.draft.id });
      return view;
    });
  }
}

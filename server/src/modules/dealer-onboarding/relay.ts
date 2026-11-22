import {
  ApplicantFury,
  ApplicantScope,
  applicantScope,
  normalizeApplicantPhone,
  rejectApplicant,
} from '../applicant-session/fury';
import { ApplicantRedis, ApplicantSessions, newApplicantHandle } from '../applicant-session/store';

export const DEALER_ONBOARDING_ENV = 'TOOLJET_DEALER_ONBOARDING';
const tokenPattern = /^v2[.][A-Za-z0-9_-]{39,1021}$/;
const panPattern = /^[A-Z]{3}[CFP][A-Z][0-9]{4}[A-Z]$/;
const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fieldLimits = { businessName: 255, applicantName: 255, applicantRole: 30, email: 254, gstin: 15, firmType: 20 };
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
    dealerPanLookup(referral_token: $referral_token, pan: $pan) { status category draft { id status nextStep canWrite } }
  }`,
  },
  start: {
    field: 'dealerIntakeStart',
    query: `mutation DealerStart($referral_token: String!, $input: DealerIntakeStartInput!) {
    dealerIntakeStart(referral_token: $referral_token, input: $input) { id status nextStep canWrite }
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
  return { state: 'draft', draft: { id, status, nextStep, canWrite }, actions: [], continuationAvailable: false };
}

export class DealerOnboarding {
  private readonly fury: ApplicantFury;
  private readonly sessions: ApplicantSessions<State>;

  constructor(redis: ApplicantRedis, fetcher: typeof fetch = fetch) {
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
    return { state: 'details', category: result.category };
  }

  private async status(scope: ApplicantScope, state: State, key: string) {
    if (!state.auth) return { state: state.phone ? 'otp' : 'phone' };
    if (!state.pan) return { state: 'pan' };
    return this.lookup(scope, state, key, state.pan);
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

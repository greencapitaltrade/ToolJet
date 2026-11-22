import {
  ApplicantFury,
  ApplicantScope,
  applicantScope,
  normalizeApplicantPhone,
  rejectApplicant,
} from '../applicant-session/fury';
import { ApplicantRedis, ApplicantSessions, newApplicantHandle } from '../applicant-session/store';

export const DEALER_PARTICIPANT_ENV = 'TOOLJET_DEALER_PARTICIPANT';
const referralPattern = /^v2[.][A-Za-z0-9_-]{39,1021}$/;
const receiptPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const guestTtl = 600;
const statuses = ['pending', 'accepted', 'expired', 'withdrawn'];
const actions = { startKyc: 'START_KYC', syncKyc: 'SYNC_KYC', sign: 'SIGN', withdraw: 'WITHDRAW' } as const;
type Action = keyof typeof actions;
type Scope = ApplicantScope & { kycOrigin: string; signingOrigin: string };
type State = { referral: string; device: string; phone?: string; auth?: { token: string }; receipt?: string };
type SetCookie = (id: string, ttl: number) => void;
type Input = Record<string, unknown>;

const eligibility = {
  field: 'dealerReferralEligibility',
  query: `mutation DealerParticipantEligibility($referral_token: String!) {
    dealerReferralEligibility(referral_token: $referral_token) { organizationId eligible }
  }`,
};
const attachment = {
  field: 'dealerParticipantAttach',
  query: `mutation DealerParticipantAttach($referralToken: String!, $consentId: ID!) {
    dealerParticipantAttach(referralToken: $referralToken, consentId: $consentId) {
      status kycStatus selfieVerified agreementPrepared
    }
  }`,
};
const ownAction = {
  field: 'dealerParticipantAction',
  query: `mutation DealerParticipantAction($consentId: ID!, $action: DealerParticipantAction!) {
    dealerParticipantAction(consentId: $consentId, action: $action) { status redirectUrl }
  }`,
};

const isObject = (value: unknown): value is Input =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validStatus = (value: unknown): value is string => typeof value === 'string' && /^[a-z_]{1,32}$/.test(value);

function exactHttpsOrigin(value: unknown): value is string {
  try {
    return typeof value === 'string' && value.startsWith('https://') && new URL(value).origin === value;
  } catch {
    return false;
  }
}

export function parseDealerParticipantConfig(value: string | undefined): Scope | null {
  try {
    const input = JSON.parse(value ?? 'null');
    if (!isObject(input) || Object.keys(input).length !== 6) return null;
    const scope = applicantScope(input);
    const { kycOrigin, signingOrigin } = input;
    return scope && exactHttpsOrigin(kycOrigin) && exactHttpsOrigin(signingOrigin)
      ? { ...scope, kycOrigin, signingOrigin }
      : null;
  } catch {
    return null;
  }
}

type Command =
  | { kind: 'entry'; referral?: string }
  | { kind: 'status' }
  | { kind: 'requestOtp'; phone: string }
  | { kind: 'verifyOtp'; otp: string }
  | { kind: 'attach'; receipt: string }
  | { kind: Action };

function parseCommand(input: unknown): Command {
  if (
    !isObject(input) ||
    !isObject(input.fields) ||
    Object.keys(input).some((key) => !['operation', 'fields', 'referralToken'].includes(key))
  )
    return rejectApplicant(400);
  const { fields, operation, referralToken } = input;
  const keys = Object.keys(fields);
  if (operation === 'entry' && keys.length === 0) {
    if (referralToken === undefined) return { kind: 'entry' };
    if (typeof referralToken === 'string' && referralPattern.test(referralToken))
      return { kind: 'entry', referral: referralToken };
  }
  if ('referralToken' in input) return rejectApplicant(400);
  if (operation === 'status' && keys.length === 0) return { kind: 'status' };
  if (typeof operation === 'string' && keys.length === 0 && Object.prototype.hasOwnProperty.call(actions, operation))
    return { kind: operation as Action };
  if (operation === 'requestOtp' && keys.length === 1) {
    const phone = normalizeApplicantPhone(fields.phone);
    if (phone) return { kind: 'requestOtp', phone };
  }
  if (
    operation === 'verifyOtp' &&
    keys.length === 1 &&
    typeof fields.otp === 'string' &&
    /^[0-9]{4,8}$/.test(fields.otp)
  )
    return { kind: 'verifyOtp', otp: fields.otp };
  if (
    operation === 'attach' &&
    keys.length === 1 &&
    typeof fields.consentId === 'string' &&
    receiptPattern.test(fields.consentId)
  )
    return { kind: 'attach', receipt: fields.consentId };
  return rejectApplicant(400);
}

function participantView(result: Input) {
  const { status, kycStatus } = result;
  if (!validStatus(status) || !statuses.includes(status)) return rejectApplicant(503);
  const allowed: Action[] = [];
  const accepted = status === 'accepted';
  const selfieVerified = accepted && result.selfieVerified === true;
  const agreementPrepared = accepted && result.agreementPrepared === true;
  if (accepted) {
    if (kycStatus !== 'verified') allowed.push('startKyc');
    allowed.push('syncKyc');
    if (kycStatus === 'verified' && selfieVerified && agreementPrepared) allowed.push('sign');
  }
  if (accepted || status === 'pending') allowed.push('withdraw');
  return {
    state: 'participant',
    status,
    actions: allowed,
    selfieVerified,
    agreementPrepared,
    ...(accepted && validStatus(kycStatus) && { kycStatus }),
  };
}

function actionView(scope: Scope, action: Action, result: Input) {
  const { status, redirectUrl } = result;
  if (!validStatus(status) || (action === 'sign' && (status !== 'requested' || !redirectUrl)))
    return rejectApplicant(503);
  const view = { state: 'action', status };
  if (redirectUrl === undefined || redirectUrl === null) return view;
  const origin = action === 'sign' ? scope.signingOrigin : action === 'startKyc' ? scope.kycOrigin : null;
  if (!origin || typeof redirectUrl !== 'string' || redirectUrl.length > 4096) return rejectApplicant(503);
  try {
    const url = new URL(redirectUrl);
    if (url.origin === origin && !url.username && !url.password) return { ...view, redirectUrl: url.href };
  } catch {
    // Use the same public failure for malformed and unconfigured redirects.
  }
  return rejectApplicant(503);
}

export class DealerParticipant {
  private readonly fury: ApplicantFury;
  private readonly sessions: ApplicantSessions<State>;

  constructor(redis: ApplicantRedis, fetcher: typeof fetch = fetch) {
    this.fury = new ApplicantFury(fetcher);
    this.sessions = new ApplicantSessions(redis, 'dealer-participant');
  }

  private async eligible(scope: Scope, referral: string) {
    try {
      const result = await this.fury.request(scope, eligibility, { referral_token: referral });
      return result.eligible === true && result.organizationId === scope.organizationId;
    } catch {
      return false;
    }
  }

  private async attach(scope: Scope, state: State, receipt: string) {
    try {
      return participantView(
        await this.fury.request(scope, attachment, { referralToken: state.referral, consentId: receipt }, state)
      );
    } catch {
      return null;
    }
  }

  async run(scope: Scope, input: unknown, id: string | undefined, setCookie: SetCookie) {
    const command = parseCommand(input);
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
      if (command.kind === 'entry' || command.kind === 'status') {
        if (!state.auth) return { state: state.phone ? 'otp' : 'phone' };
        if (!state.receipt || !state.phone) return { state: 'receipt' };
        await this.sessions.rate(scope, 'status', state.phone, 40, 60);
        return (await this.attach(scope, state, state.receipt)) ?? { state: 'receipt' };
      }
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
        return { state: 'receipt' };
      }
      if (!state.auth || !state.phone) return rejectApplicant(409);
      if (command.kind === 'attach') {
        if (state.receipt && state.receipt !== command.receipt) return rejectApplicant(409);
        await this.sessions.rate(scope, 'attach', state.phone, 8, guestTtl);
        const view = await this.attach(scope, state, command.receipt);
        if (!view) return { state: 'receipt' };
        if (!state.receipt && (view.status === 'accepted' || view.status === 'pending'))
          await this.sessions.save(key, { ...state, receipt: command.receipt });
        return view;
      }
      if (!state.receipt) return rejectApplicant(409);
      await this.sessions.rate(scope, 'action', state.phone, 12, 60);
      const current = await this.attach(scope, state, state.receipt);
      if (!current?.actions.includes(command.kind)) return rejectApplicant(409);
      const result = await this.fury.request(
        scope,
        ownAction,
        { consentId: state.receipt, action: actions[command.kind] },
        state
      );
      return actionView(scope, command.kind, result);
    });
  }
}

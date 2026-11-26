import { createHmac } from 'node:crypto';
import { ApplicantScope, isApplicantReferral, rejectApplicant } from '../applicant-session/fury';
import { ApplicantRedis, newApplicantHandle } from '../applicant-session/store';

const handle = /^[A-Za-z0-9_-]{43}$/;
const account = /^[1-9][0-9]{0,18}$/;
const jwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ttl = 600;
const verifiedTtl = 1800;
// Both keys share the lender organization hash tag for Redis Cluster.
const arm = `-- CONTINUATION_ARM
local current=redis.call('GET',KEYS[1])
if current~=ARGV[1] then return 0 end
local remaining=redis.call('TTL',KEYS[1])
if remaining<=0 then return 0 end
local lifetime=math.min(remaining,tonumber(ARGV[3]))
if not redis.call('SET',KEYS[2],ARGV[2],'EX',lifetime,'NX') then return 0 end
redis.call('SET',KEYS[1],'armed','KEEPTTL')
return 1`;
const consume = `-- CONTINUATION_CONSUME
local value=redis.call('GET',KEYS[1])
if not value then return nil end
local record=cjson.decode(value)
if record.guest~=ARGV[1] then return nil end
redis.call('DEL',KEYS[1])
return value`;

type ReceiptInput = { token: unknown; device: unknown; user_id: unknown };
type Pending = { guest: string; referral: string };
type Receipt = Pending & { userId: string; actorOrgId: string; email: string; expires: number };

/** Storage only: callers authenticate the server receipt and establish guest eligibility first. */
export class DealerContinuation {
  constructor(private readonly redis: ApplicantRedis) {}

  private digest(scope: ApplicantScope, value: string) {
    return createHmac('sha256', scope.lspSecret)
      .update(JSON.stringify([scope.origin, scope.organizationId, scope.furyUrl, value]))
      .digest('hex');
  }

  private key(scope: ApplicantScope, kind: string, value: string) {
    return `dealer-continuation:{${scope.organizationId}}:${kind}:${this.digest(scope, value)}`;
  }

  async start(scope: ApplicantScope, guestId: string, referral: string) {
    if (!handle.test(guestId) || !isApplicantReferral(referral)) return rejectApplicant(400);
    const state = newApplicantHandle();
    const pending: Pending = { guest: this.digest(scope, guestId), referral };
    if (
      (await this.redis.call(
        'SET',
        this.key(scope, 'state', state),
        JSON.stringify(pending),
        'EX',
        String(ttl),
        'NX'
      )) !== 'OK'
    )
      return rejectApplicant(503);
    return state;
  }

  async receive(scope: ApplicantScope, state: string, input: ReceiptInput, actorOrgId: string) {
    if (
      !handle.test(state) ||
      typeof actorOrgId !== 'string' ||
      !account.test(actorOrgId) ||
      typeof input?.token !== 'string' ||
      input.token.length > 8192 ||
      !jwt.test(input.token) ||
      typeof input.device !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.device) ||
      typeof input.user_id !== 'string' ||
      !account.test(input.user_id)
    )
      return rejectApplicant(401);
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(input.token.split('.')[1], 'base64url').toString('utf8'));
    } catch {
      return rejectApplicant(401);
    }
    const user =
      typeof claims?.user_id === 'number' && Number.isSafeInteger(claims.user_id)
        ? String(claims.user_id)
        : claims?.user_id;
    const org =
      typeof claims?.org_id === 'number' && Number.isSafeInteger(claims.org_id)
        ? String(claims.org_id)
        : claims?.org_id;
    const email = claims?.email;
    if (
      user !== input.user_id ||
      org !== actorOrgId ||
      claims?.app !== 'voltcred' ||
      claims?.device !== input.device ||
      typeof email !== 'string' ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof claims?.exp !== 'number' ||
      !Number.isSafeInteger(claims.exp)
    )
      return rejectApplicant(401);
    const remaining = claims.exp - Math.floor(Date.now() / 1000);
    if (remaining <= 0) return rejectApplicant(401);
    const key = this.key(scope, 'state', state);
    const raw = await this.redis.call('GET', key);
    if (typeof raw !== 'string' || raw === 'armed') return rejectApplicant(409);
    let pending: Pending;
    try {
      pending = JSON.parse(raw);
    } catch {
      return rejectApplicant(409);
    }
    if (!pending || typeof pending.guest !== 'string' || !isApplicantReferral(pending.referral))
      return rejectApplicant(409);
    const code = newApplicantHandle();
    const record: Receipt = { ...pending, userId: input.user_id, actorOrgId, email, expires: claims.exp };
    if (
      (await this.redis.call(
        'EVAL',
        arm,
        '2',
        key,
        this.key(scope, 'code', code),
        raw,
        JSON.stringify(record),
        String(Math.min(ttl, remaining))
      )) !== 1
    )
      return rejectApplicant(409);
    return code;
  }

  async consume(scope: ApplicantScope, guestId: string, code: string) {
    if (!handle.test(guestId) || !handle.test(code)) return rejectApplicant(400);
    const raw = await this.redis.call('EVAL', consume, '1', this.key(scope, 'code', code), this.digest(scope, guestId));
    if (typeof raw !== 'string') return rejectApplicant(409);
    let record: Receipt;
    try {
      record = JSON.parse(raw);
    } catch {
      return rejectApplicant(409);
    }
    const seconds = Math.min(verifiedTtl, record.expires - Math.floor(Date.now() / 1000));
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return rejectApplicant(401);
    return {
      referral: record.referral,
      userId: record.userId,
      actorOrgId: record.actorOrgId,
      email: record.email,
      seconds,
    };
  }
}

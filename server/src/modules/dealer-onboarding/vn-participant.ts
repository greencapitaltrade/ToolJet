import { createHash, createHmac, randomBytes } from 'node:crypto';

export const PARTICIPANT_ELIGIBILITY_PATH = '/v1/channel-partners/intakes/participant-eligibility';
export const PARTICIPANT_RECHECK_PATH = '/api/dealer-onboarding/vn/participant/recheck';
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const mac = (key: string, value: unknown[]) =>
  createHmac('sha256', key).update(JSON.stringify(value), 'utf8').digest('hex');
const id = (value: string) => /^[1-9]\d{0,18}$/.test(value) && (value.length < 19 || value <= '9223372036854775807');
const secret = (value: string) => typeof value === 'string' && Buffer.byteLength(value) >= 32;

export function participantRecipientKey(key: string, organizationId: string, clientId: string, jti: string) {
  if (!secret(key) || !id(organizationId) || !/^[\x21-\x7e]{1,256}$/.test(clientId) || !/^[A-Za-z0-9_-]{43}$/.test(jti))
    throw new Error('Invalid participant intent');
  return mac(key, ['vn_delegated_person_recipient_v1', organizationId, clientId, jti]);
}

export function participantEligibilityHeaders(
  issuer: string,
  body: string,
  key: string,
  issuedAt = String(Math.floor(Date.now() / 1000)),
  nonce = randomBytes(16).toString('hex')
) {
  if (
    !id(issuer) ||
    !secret(key) ||
    !/^[1-9]\d{0,11}$/.test(issuedAt) ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    typeof body !== 'string' ||
    Buffer.byteLength(body) > 16384
  )
    throw new Error('Invalid participant eligibility');
  return {
    'x-gct-org-id': issuer,
    'x-gct-participant-issuer-org': issuer,
    'x-gct-participant-issued-at': issuedAt,
    'x-gct-participant-nonce': nonce,
    'x-participant-eligibility-signature': mac(key, [
      'destiny-vn-participant-eligibility-v1',
      'POST',
      PARTICIPANT_ELIGIBILITY_PATH,
      issuer,
      issuedAt,
      nonce,
      hash(body),
    ]),
  };
}

export function participantRecheckSignature(key: string, organizationId: string, issuedAt: string, body: string) {
  if (
    !secret(key) ||
    !id(organizationId) ||
    !/^[1-9]\d{0,11}$/.test(issuedAt) ||
    typeof body !== 'string' ||
    Buffer.byteLength(body) > 16384
  )
    throw new Error('Invalid participant recheck');
  return mac(key, [
    'thor-vn-participant-recheck-v1',
    'POST',
    PARTICIPANT_RECHECK_PATH,
    organizationId,
    issuedAt,
    hash(body),
  ]);
}

/** Short-lived intent records are addressed by an HMAC, never by the participant token. */
export class ParticipantIntentStore {
  private readonly redis: { call(command: string, ...args: string[]): Promise<unknown> };
  private readonly organizationId: string;
  private readonly keySecret: string;
  constructor(
    redis: { call(command: string, ...args: string[]): Promise<unknown> },
    organizationId: string,
    keySecret: string
  ) {
    if (!id(organizationId) || !secret(keySecret)) throw new Error('Invalid participant store');
    this.redis = redis;
    this.organizationId = organizationId;
    this.keySecret = keySecret;
  }
  private key(jti: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(jti)) throw new Error('Invalid participant intent');
    return `dealer-participant-intent:{${this.organizationId}}:${createHmac('sha256', this.keySecret).update(jti).digest('hex')}`;
  }
  async put(jti: string, guest: string, token: string, commitment: string) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(guest) ||
      !/^v3\.[A-Za-z0-9_-]{39,1021}$/.test(token) ||
      !/^[a-f0-9]{64}$/.test(commitment)
    )
      throw new Error('Invalid participant intent');
    if (
      (await this.redis.call('SET', this.key(jti), JSON.stringify({ guest, token, commitment }), 'EX', '600', 'NX')) !==
      'OK'
    )
      throw new Error('Participant intent unavailable');
  }
  async get(jti: string): Promise<{ guest: string; token: string; commitment: string } | null> {
    const raw = await this.redis.call('GET', this.key(jti));
    if (typeof raw !== 'string') return null;
    try {
      const value = JSON.parse(raw);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(value.guest) ||
        !/^v3\.[A-Za-z0-9_-]{39,1021}$/.test(value.token) ||
        !/^[a-f0-9]{64}$/.test(value.commitment)
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }
}

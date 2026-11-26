import { createHash, createHmac, randomBytes } from 'node:crypto';

export const SIGNER_ELIGIBILITY_PATH = '/v1/channel-partners/intakes/signer-eligibility';
export const SIGNER_RECHECK_PATH = '/api/dealer-onboarding/vn/signer/recheck';
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const mac = (key: string, value: unknown[]) =>
  createHmac('sha256', key).update(JSON.stringify(value), 'utf8').digest('hex');
const id = (value: string) => /^[1-9]\d{0,18}$/.test(value) && (value.length < 19 || value <= '9223372036854775807');
const secret = (value: string) => typeof value === 'string' && Buffer.byteLength(value) >= 32;

export function signerRecipientKey(key: string, organizationId: string, clientId: string, jti: string) {
  if (!secret(key) || !id(organizationId) || !/^[\x21-\x7e]{1,256}$/.test(clientId) || !/^[A-Za-z0-9_-]{43}$/.test(jti))
    throw new Error('Invalid signer intent');
  return mac(key, ['vn_delegated_agreement_signer_recipient_v1', organizationId, clientId, jti]);
}

export function signerEligibilityHeaders(
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
    throw new Error('Invalid signer eligibility');
  return {
    'x-gct-org-id': issuer,
    'x-gct-signer-issuer-org': issuer,
    'x-gct-signer-issued-at': issuedAt,
    'x-gct-signer-nonce': nonce,
    'x-signer-eligibility-signature': mac(key, [
      'destiny-vn-signer-eligibility-v1',
      'POST',
      SIGNER_ELIGIBILITY_PATH,
      issuer,
      issuedAt,
      nonce,
      hash(body),
    ]),
  };
}

export function signerRecheckSignature(key: string, organizationId: string, issuedAt: string, body: string) {
  if (
    !secret(key) ||
    !id(organizationId) ||
    !/^[1-9]\d{0,11}$/.test(issuedAt) ||
    typeof body !== 'string' ||
    Buffer.byteLength(body) > 16384
  )
    throw new Error('Invalid signer recheck');
  return mac(key, ['thor-vn-signer-recheck-v1', 'POST', SIGNER_RECHECK_PATH, organizationId, issuedAt, hash(body)]);
}

/** Short-lived intent records are addressed by an HMAC, never by the signer token. */
export class SignerIntentStore {
  private readonly redis: {
    call(command: string, ...args: string[]): Promise<unknown>;
  };
  private readonly organizationId: string;
  private readonly keySecret: string;
  constructor(
    redis: { call(command: string, ...args: string[]): Promise<unknown> },
    organizationId: string,
    keySecret: string
  ) {
    if (!id(organizationId) || !secret(keySecret)) throw new Error('Invalid signer store');
    this.redis = redis;
    this.organizationId = organizationId;
    this.keySecret = keySecret;
  }
  private key(jti: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(jti)) throw new Error('Invalid signer intent');
    return `dealer-signer-intent:{${this.organizationId}}:${createHmac('sha256', this.keySecret).update(jti).digest('hex')}`;
  }
  async put(jti: string, guest: string, token: string, commitment: string) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(guest) ||
      !/^v3\.[A-Za-z0-9_-]{39,1021}$/.test(token) ||
      !/^[a-f0-9]{64}$/.test(commitment)
    )
      throw new Error('Invalid signer intent');
    if (
      (await this.redis.call('SET', this.key(jti), JSON.stringify({ guest, token, commitment }), 'EX', '600', 'NX')) !==
      'OK'
    )
      throw new Error('Signer intent unavailable');
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

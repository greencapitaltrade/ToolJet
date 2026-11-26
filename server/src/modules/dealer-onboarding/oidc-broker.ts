import { createHash, createHmac, randomBytes } from 'node:crypto';

const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const positiveId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) &&
  (value.length < 19 || value <= '9223372036854775807');

/** Do not send authorization requests or client credentials outside the configured issuer. */
export function dealerOidcEndpointAllowed(issuer: string, endpoint: unknown): boolean {
  try {
    if (typeof endpoint !== 'string' || !endpoint || /%(?:2f|5c|2e)/i.test(endpoint)) return false;
    const base = new URL(issuer);
    const url = new URL(endpoint);
    const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
      url.origin === base.origin && url.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

export type DealerOidcConfig = {
  issuer: string; clientId: string; organizationId: string; redirectUri: string; intentSecret: string;
};
type Pending = { continuation: string; nonce: string; verifier: string };
type Store = { put(state: string, value: Pending): Promise<void>; take(state: string): Promise<Pending | null | undefined> };
type Client = {
  authorizationUrl(params: Record<string, string>): string;
  callback(uri: string, params: { state: string; code: string }, checks: { state: string; nonce: string; code_verifier: string }): Promise<{ claims(): Record<string, unknown> }>;
};
type Resolver = (subject: string) => Promise<{ sub: unknown; organization_id: unknown }>;

/** The store must atomically consume state and expire it within ten minutes.
 * Construct client from discovery pinned to config.issuer, registered client ID and redirect URI.
 * Call start only after the server-side signed-referral eligibility check succeeds. */
export class DealerOidcBroker {
  private readonly config: DealerOidcConfig;
  private readonly store: Store;
  private readonly client: Client;
  private readonly resolve: Resolver;
  constructor(config: DealerOidcConfig, store: Store, client: Client, resolve: Resolver) {
    this.config = config; this.store = store; this.client = client; this.resolve = resolve;
    const issuer = new URL(config.issuer);
    const callback = new URL(config.redirectUri);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash ||
      callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash ||
      !config.clientId || !positiveId(config.organizationId) || !/^[\x21-\x7e]{32,512}$/.test(config.intentSecret))
      throw new Error('Invalid dealer OIDC configuration');
  }

  async start(continuation: string) {
    if (typeof continuation !== 'string' || !continuation || continuation.length > 256) throw new Error('Invalid continuation');
    const state = opaque(); const nonce = opaque(); const verifier = opaque();
    const iat = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ v: 1, purpose: 'vn_dealer_enrollment', client_id: this.config.clientId,
      jti: opaque(), iat, exp: iat + 600, state_hash: hash(state) })).toString('base64url');
    const signature = createHmac('sha256', this.config.intentSecret).update(payload).digest('base64url');
    await this.store.put(state, { continuation, nonce, verifier });
    return this.client.authorizationUrl({ scope: 'openid email', response_type: 'code', client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri, state, nonce, code_challenge: hash(verifier), code_challenge_method: 'S256',
      prompt: 'login', enrollment_intent: `${payload}.${signature}` });
  }

  async callback(params: { state: string; code: string }) {
    if (!params || typeof params.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(params.state) ||
      typeof params.code !== 'string' || !params.code || params.code.length > 2048) throw new Error('Invalid callback');
    const pending = await this.store.take(params.state);
    if (!pending) throw new Error('Expired callback');
    const token = await this.client.callback(this.config.redirectUri, params,
      { state: params.state, nonce: pending.nonce, code_verifier: pending.verifier });
    const claims = token.claims();
    if (claims.iss !== this.config.issuer || !positiveId(claims.sub) || claims.email_verified !== true ||
      typeof claims.email !== 'string' || claims.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email))
      throw new Error('Invalid dealer identity');
    const subject = await this.resolve(claims.sub);
    if (subject.sub !== claims.sub || subject.organization_id !== this.config.organizationId) throw new Error('Invalid dealer organization');
    return { continuation: pending.continuation, userId: claims.sub, organizationId: this.config.organizationId, email: claims.email };
  }
}

const takeOnce = "local v=redis.call('GET',KEYS[1]); if v then redis.call('DEL',KEYS[1]) end; return v";
export class DealerOidcRedisStore {
  private readonly redis: { call(command: string, ...args: string[]): Promise<unknown> };
  private readonly organizationId: string;
  private readonly secret: string;
  constructor(redis: { call(command: string, ...args: string[]): Promise<unknown> }, organizationId: string, secret: string) {
    if (!positiveId(organizationId) || !/^[\x21-\x7e]{32,512}$/.test(secret)) throw new Error('Invalid state configuration');
    this.redis = redis; this.organizationId = organizationId; this.secret = secret;
  }
  private key(state: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('Invalid state');
    return `dealer-oidc:{${this.organizationId}}:${createHmac('sha256', this.secret).update(state).digest('hex')}`;
  }
  async put(state: string, value: Pending) {
    if (await this.redis.call('SET', this.key(state), JSON.stringify(value), 'EX', '600', 'NX') !== 'OK') throw new Error('State unavailable');
  }
  async take(state: string): Promise<Pending | null> {
    const raw = await this.redis.call('EVAL', takeOnce, '1', this.key(state));
    if (typeof raw !== 'string') return null;
    try {
      const value = JSON.parse(raw);
      if (typeof value.continuation !== 'string' || typeof value.nonce !== 'string' || typeof value.verifier !== 'string') return null;
      return value;
    } catch { return null; }
  }
}

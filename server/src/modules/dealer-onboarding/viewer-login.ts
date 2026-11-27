type Scope = { origin: string; organizationId: string; lspSecret: string };
type Guest = { referral: string; personToken?: string };
type Viewer = Guest & { userId: string; organizationId: string; email: string; emailVerified: true };
type Sessions = {
  start(scope: Scope, value: Guest | Viewer, seconds: number): Promise<{ id: string; key: string }>;
  key(scope: Scope, id: string | undefined): string | undefined;
  get(key: string): Promise<Guest | Viewer | null>;
  rotate(scope: Scope, key: string, value: Guest | Viewer, seconds: number): Promise<{ id: string; key: string }>;
};
type Broker = {
  start(continuation: string): Promise<string>;
  callback(params: { state: string; code: string; iss?: string }): Promise<{ continuation: string; userId: string; organizationId: string; email: string }>;
};
const opaque = /^[A-Za-z0-9_-]{43}$/;
const referralPattern = /^[A-Za-z0-9_-]{39,1021}$/;
const failure = () => { throw new Error('Dealer login unavailable'); };

/** Referral eligibility precedes enrollment. Both the referral and verified actor remain server-side. */
export class DealerViewerLogin {
  private readonly scope: Scope;
  private readonly destinyOrigin: string;
  private readonly sessions: Sessions;
  private readonly broker: Broker;
  private readonly fetcher: typeof fetch;
  constructor(scope: Scope, destinyOrigin: string, sessions: Sessions, broker: Broker, fetcher: typeof fetch = fetch) {
    this.scope = scope; this.destinyOrigin = destinyOrigin; this.sessions = sessions; this.broker = broker; this.fetcher = fetcher;
  }

  async start(referral: unknown, personToken?: unknown) {
    if (typeof referral !== 'string' || !referralPattern.test(referral) || (personToken !== undefined && (typeof personToken !== 'string' || !referralPattern.test(personToken)))) return failure();
    const response = await this.fetcher(new URL('/v1/channel-partners/referrals/eligibility', this.destinyOrigin).href, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-gct-org-id': this.scope.organizationId },
      body: JSON.stringify({ referral_token: referral }),
    });
    if (!response.ok) return failure();
    const eligibility = await response.json();
    if (eligibility?.eligible !== true || eligibility?.organization_id !== this.scope.organizationId) return failure();
    const session = await this.sessions.start(this.scope, { referral, ...(typeof personToken === 'string' ? { personToken } : {}) }, 600);
    const url = await this.broker.start(session.id);
    const state = new URL(url).searchParams.get('state');
    if (!state || !opaque.test(state)) return failure();
    return { id: session.id, state, url };
  }

  async callback(params: { state: string; code: string; iss?: string }, id: string | undefined, stateCookie: string | undefined) {
    if (!params || !opaque.test(params.state) || params.state !== stateCookie) return failure();
    const key = this.sessions.key(this.scope, id);
    const guest = key && await this.sessions.get(key);
    if (!key || !guest || !referralPattern.test(guest.referral)) return failure();
    const actor = await this.broker.callback(params);
    if (actor.continuation !== id || actor.organizationId !== this.scope.organizationId) return failure();
    const session = await this.sessions.rotate(this.scope, key, { referral: guest.referral, ...(guest.personToken ? { personToken: guest.personToken } : {}), userId: actor.userId,
      organizationId: actor.organizationId, email: actor.email, emailVerified: true }, 1800);
    return { ...session, director: !!guest.personToken };
  }
}

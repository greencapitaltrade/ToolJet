const jwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const accountId = /^[1-9][0-9]{0,18}$/;
const verifiedLifetime = 1800;

export type ApplicantScope = {
  origin: string;
  organizationId: string;
  furyUrl: string;
  lspSecret: string;
};
type ApplicantIdentity = { device: string; phone?: string; auth?: { token: string } };
type Payload = Record<string, unknown>;

export function applicantScope(value: Payload): ApplicantScope | null {
  const { origin, organizationId, furyUrl, lspSecret } = value;
  if (
    typeof origin !== 'string' ||
    typeof organizationId !== 'string' ||
    !accountId.test(organizationId) ||
    typeof furyUrl !== 'string' ||
    typeof lspSecret !== 'string' ||
    !/^[\x21-\x7e]{16,1024}$/.test(lspSecret)
  )
    return null;
  try {
    const site = new URL(origin);
    const gateway = new URL(furyUrl);
    if (
      site.origin !== origin ||
      site.protocol !== 'https:' ||
      gateway.protocol !== 'https:' ||
      gateway.username ||
      gateway.password ||
      gateway.pathname !== '/v2/graphql' ||
      gateway.search ||
      gateway.hash
    )
      return null;
    return { origin, organizationId, furyUrl: gateway.href, lspSecret };
  } catch {
    return null;
  }
}

export class ApplicantRequestError extends Error {
  constructor(readonly status: number) {
    super('Applicant request unavailable');
  }
}

export function rejectApplicant(status: number): never {
  throw new ApplicantRequestError(status);
}

export function normalizeApplicantPhone(value: unknown) {
  if (typeof value !== 'string' || !/^\+?[0-9 ()-]{10,25}$/.test(value)) return null;
  const number = value.replace(/[ ()-]/g, '').replace(/^\+?91(?=\d{10}$)/, '');
  return /^[6-9][0-9]{9}$/.test(number) ? number : null;
}

const sessionStart = `mutation ApplicantSendOtp($phone: String!) {
  sessionCreateV2(data: {phone: $phone}) { success status }
}`;
const sessionVerify = `mutation ApplicantVerifyOtp($phone: String!, $otp: String!) {
  sessionPut(data: {phone: $phone, otp: $otp}) { token }
}`;

export class ApplicantFury {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** The adapter supplies the fixed document. This never forwards browser headers or arbitrary GraphQL. */
  async request(
    scope: ApplicantScope,
    operation: { field: string; query: string },
    variables: Payload,
    identity?: ApplicantIdentity
  ): Promise<Payload> {
    const response = await this.fetcher(scope.furyUrl, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type': 'application/json',
        ...(identity?.device && { device: identity.device }),
        ...(identity?.auth
          ? { cookie: `authorization=${identity.auth.token}; device=${identity.device}` }
          : { 'api-secret': scope.lspSecret }),
      },
      body: JSON.stringify({ query: operation.query, variables }),
    });
    const status = operation.field === 'sessionPut' ? 401 : 503;
    if (!response.ok) return rejectApplicant(status);
    const packet = await response.json();
    const data = packet?.data?.[operation.field];
    if (packet?.errors?.length || !data || typeof data !== 'object' || Array.isArray(data))
      return rejectApplicant(status);
    return data;
  }

  async requestOtp(scope: ApplicantScope, identity: ApplicantIdentity, phone: string) {
    if (identity.auth || normalizeApplicantPhone(phone) !== phone) return rejectApplicant(409);
    const result = await this.request(scope, { field: 'sessionCreateV2', query: sessionStart }, { phone }, identity);
    if (result.success !== true || result.status !== 'otp_sent') rejectApplicant(409);
  }

  async verifyOtp(scope: ApplicantScope, identity: ApplicantIdentity, otp: string) {
    if (identity.auth || !identity.phone || !/^[0-9]{4,8}$/.test(otp)) return rejectApplicant(409);
    const result = await this.request(
      scope,
      { field: 'sessionPut', query: sessionVerify },
      { phone: identity.phone, otp },
      identity
    );
    const token = result.token;
    if (typeof token !== 'string' || token.length > 8192 || !jwtPattern.test(token)) return rejectApplicant(401);
    try {
      // Scope-check Fury's HTTPS reply. Heimdallr verifies the signature and
      // the device again on every authenticated downstream request.
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      if (
        !claims ||
        typeof claims !== 'object' ||
        String(claims.org_id) !== scope.organizationId ||
        !accountId.test(String(claims.user_id)) ||
        claims.device !== identity.device ||
        normalizeApplicantPhone(claims.phone) !== identity.phone ||
        !Number.isSafeInteger(claims.exp)
      )
        return rejectApplicant(401);
      const remaining = claims.exp - Math.floor(Date.now() / 1000);
      if (remaining <= 0) return rejectApplicant(401);
      return { token, seconds: Math.min(remaining, verifiedLifetime) };
    } catch {
      return rejectApplicant(401);
    }
  }
}

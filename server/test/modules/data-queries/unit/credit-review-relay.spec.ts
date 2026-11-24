import { generateKeyPairSync, verify } from 'node:crypto';
import { runCreditReview } from '@modules/data-queries/credit-review.relay';
import { sanitizeOAuthRequest, sanitizeTraceObject } from '@otel/sanitize';

const site = 'https://workspace.example.test';
const issuer = 'https://issuer.example.test/oidc';
const thor = 'http://thor.namespace.svc.cluster.local';
const destiny = 'http://destiny.namespace.svc.cluster.local';
const workspaceId = 'e38e7590-76c7-46b1-9413-d56ec6ee28af';
const userId = '9007199254740993';
const orgId = '9007199254740994';
const signedKey = generateKeyPairSync('ed25519');
const user = { id: 'tooljet-user', sessionId: 'native-session', organizationId: workspaceId };
const sessions = { getOidcActor: jest.fn() };

async function relay(body: unknown) {
  const result = await runCreditReview(sessions as never, user, body);
  return { status: result.status, body: result.data ? { data: result.data } : { error: result.error } };
}

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    TOOLJET_EDITION: 'ce',
    TOOLJET_HOST: site,
    TOOLJET_OIDC_ISSUER: issuer,
    TOOLJET_OIDC_CLIENT_ID: 'test-client',
    TOOLJET_OIDC_CLIENT_SECRET: 'synthetic-test-client-secret',
    TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
    TOOLJET_PARTNER_OPS_THOR_ORIGIN: thor,
    TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN: destiny,
    TOOLJET_CREDIT_REVIEW_SIGNING_KEY: signedKey.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  });
  sessions.getOidcActor.mockReset().mockResolvedValue({ issuer, clientId: 'test-client', sub: userId });
  jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (url === `${thor}/v1/users/oidc-subject/${userId}`) {
      return globalThis.Response.json({ sub: userId, organization_id: orgId });
    }
    return globalThis.Response.json({ cases: [] });
  });
});

afterEach(() => jest.restoreAllMocks());

describe('private credit review relay', () => {
  it('keeps case details and signed proof out of telemetry', () => {
    expect(
      sanitizeOAuthRequest({
        id: 'request-1',
        method: 'POST',
        url: '/tools/api/data-queries/fixture-query/run?caseId=23',
        headers: { 'x-gct-credit-review-proof': 'synthetic-proof' },
        body: { fields: { reason: 'synthetic private case detail' } },
      })
    ).toEqual({ id: 'request-1', method: 'POST', url: '/tools/api/data-queries/fixture-query/run' });
    expect(sanitizeTraceObject({ 'x-gct-credit-review-proof': 'synthetic-proof' })).toEqual({
      'x-gct-credit-review-proof': '[REDACTED]',
    });
  });
  it.each([
    [
      { operation: 'queue', fields: { after: '23' } },
      'queue',
      ['queue', '23'],
      '/v1/applications/credit-review/queue',
      { action: 'queue', after: '23' },
    ],
    [
      { operation: 'queue', fields: {} },
      'queue',
      ['queue', null],
      '/v1/applications/credit-review/queue',
      { action: 'queue' },
    ],
    [
      { operation: 'case', fields: { applicationId: '23' } },
      '23',
      ['options', null, null, null, null, null],
      '/v1/23/credit-review',
      { action: 'options' },
    ],
    [
      {
        operation: 'action',
        fields: {
          applicationId: '23',
          action: 'close',
          reviewStepId: '44',
          revision: 'rev-2',
          reason: 'Reason supplied',
        },
      },
      '23',
      ['close', '44', 'rev-2', null, 'Reason supplied', null],
      '/v1/23/credit-review',
      { action: 'close', reviewStepId: '44', revision: 'rev-2', reason: 'Reason supplied' },
    ],
  ])(
    'binds the canonical verified actor, operation and request to Destiny',
    async (body, target, fields, path, expected) => {
      expect(await relay(body)).toEqual({ status: 200, body: { data: { cases: [] } } });
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        `${thor}/v1/users/oidc-subject/${userId}`,
        expect.objectContaining({
          redirect: 'error',
          headers: { 'x-gct-oidc-client-id': 'test-client', 'x-gct-oidc-issuer': issuer },
        })
      );
      const [url, options] = jest.mocked(fetch).mock.calls[1];
      expect(url).toBe(destiny + path);
      expect(options).toEqual(expect.objectContaining({ method: 'POST', redirect: 'error' }));
      expect(JSON.parse(options.body as string)).toEqual(expected);
      const headers = options.headers as Record<string, string>;
      expect(headers['x-gct-user-id']).toBe(userId);
      expect(headers['x-gct-org-id']).toBe(orgId);
      const [subject, expiry, signature] = headers['x-gct-credit-review-proof'].split('.');
      expect(subject).toBe(userId);
      expect(Number(expiry) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(30);
      expect(
        verify(
          null,
          Buffer.from(JSON.stringify(['destiny-borrower-credit-review-v2', target, userId, orgId, fields, expiry])),
          signedKey.publicKey,
          Buffer.from(signature, 'base64url')
        )
      ).toBe(true);
    }
  );

  it.each([
    { operation: 'queue', fields: { organizationId: '1' } },
    { operation: 'queue', fields: { after: '01' } },
    { operation: 'case', fields: { applicationId: '1/other' } },
    { operation: 'case', fields: { applicationId: '9223372036854775808' } },
    {
      operation: 'action',
      fields: {
        applicationId: '23',
        action: 'close',
        reviewStepId: '1',
        revision: 'x',
        reason: ' ',
        role: 'credit_officer',
      },
    },
    {
      operation: 'action',
      fields: { applicationId: '23', action: 'return', reviewStepId: '1', revision: 'x', reason: 'Required' },
    },
  ])('rejects caller-supplied scope or invalid review requests before contacting either service', async (body) => {
    expect((await relay(body)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires registered Thor identity and never exposes upstream failures', async () => {
    sessions.getOidcActor.mockRejectedValueOnce(new Error('private error'));
    expect((await relay({ operation: 'queue', fields: {} })).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();

    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '222', organization_id: orgId }));
    expect((await relay({ operation: 'queue', fields: {} })).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);

    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ sub: userId, organization_id: orgId }))
      .mockResolvedValueOnce(globalThis.Response.json({ proof: 'sensitive upstream error' }, { status: 403 }));
    expect(await relay({ operation: 'queue', fields: {} })).toEqual({
      status: 403,
      body: { error: 'You do not have access to this action.' },
    });
  });
});

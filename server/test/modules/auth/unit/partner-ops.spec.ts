import { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PartnerOpsController, PartnerOpsGuard } from '@modules/auth/oauth/partner-ops.controller';
import type { SessionUtilService } from '@modules/session/util.service';

const issuer = 'https://issuer.example.test/oidc';
const workspaceId = 'e38e7590-76c7-46b1-9413-d56ec6ee28af';
const tooljetOrigin = 'https://workspace.example.test';
const upstream = 'http://operations.default.svc.cluster.local';
const session = { getOidcActor: jest.fn() };
const controller = new PartnerOpsController(session as unknown as SessionUtilService);

function request(headers: Record<string, string> = {}, cookies: Record<string, string> = { tj_auth_token: 'fixture' }) {
  return {
    headers: { origin: tooljetOrigin, 'content-type': 'application/json', ...headers },
    cookies,
    user: { id: 'test-user', sessionId: 'test-session', organizationId: workspaceId },
  } as unknown as Parameters<typeof controller.relay>[0];
}

async function relay(body: unknown, req = request()) {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await controller.relay(req, body, response as unknown as Response);
  return { status: response.status.mock.calls[0][0], body: response.json.mock.calls[0][0] };
}

function ctx(req: Request) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    TOOLJET_EDITION: 'ce',
    TOOLJET_HOST: tooljetOrigin,
    TOOLJET_OIDC_ISSUER: issuer,
    TOOLJET_OIDC_CLIENT_ID: 'test-client',
    TOOLJET_OIDC_CLIENT_SECRET: 'synthetic-test-only-sign-in-client',
    TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
    TOOLJET_PARTNER_OPS_ISSUER: issuer,
    TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN: upstream,
  });
  session.getOidcActor.mockReset().mockResolvedValue({ issuer, sub: '42' });
  jest.spyOn(global, 'fetch').mockResolvedValue(globalThis.Response.json({ data: { rows: [] } }));
});

afterEach(() => jest.restoreAllMocks());

describe('partner operator workspace relay', () => {
  it('requires a native browser session and pins the configured workspace before authenticating', async () => {
    const guard = new PartnerOpsGuard();
    const passport = jest
      .spyOn(Object.getPrototypeOf(PartnerOpsGuard.prototype), 'canActivate')
      .mockResolvedValue(true);
    const native = request({ 'tj-workspace-id': 'untrusted' });
    await expect(guard.canActivate(ctx(native))).resolves.toBe(true);
    expect(passport).toHaveBeenCalledTimes(1);
    expect(native.headers['tj-workspace-id']).toBe(workspaceId);

    for (const forged of [
      request({}, {}),
      request({ origin: 'https://foreign.example' }),
      request({ tj_auth_token: 'test-header' }),
      request({ 'x-tooljet-delegation': 'test-header' }),
      request({ 'tj-admin-api-key': 'test-header' }),
      request({}, { tj_auth_token: 'fixture', tj_oauth_viewer: 'test-viewer' }),
      request({ 'content-type': 'text/plain' }),
    ]) {
      await expect(guard.canActivate(ctx(forged))).resolves.toBe(false);
    }
    expect(passport).toHaveBeenCalledTimes(1);
  });

  it('forwards only fixed path, allowed parameters and verified identity through the configured mesh', async () => {
    const selector = { operation: 'borrowerDpd', partnerId: '11', after: '999' };
    const req = request({
      'x-gct-org-id': '9000',
      'x-gct-user-id': '9000',
      'x-gct-oidc-issuer': 'https://foreign.example',
      'x-gct-oidc-subject': '24',
      authorization: 'Bearer untrusted',
      'x-gct-app': 'untrusted',
    });
    expect(await relay(selector, req)).toEqual({ status: 200, body: { data: { rows: [] } } });
    expect(session.getOidcActor).toHaveBeenCalledWith(req.user);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      upstream + '/v1/channel-partners/operator',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify(selector),
        headers: { 'Content-Type': 'application/json', 'x-gct-oidc-issuer': issuer, 'x-gct-oidc-subject': '42' },
      })
    );
  });

  it.each([
    { operation: 'feeCheckout', dealerId: '11', amountPaise: '1' },
    { operation: 'partners', partnerId: '1/path' },
    { operation: 'borrowerApplications', partnerId: '9223372036854775808' },
    { operation: 'dealerLink', organizationId: '7' },
    { operation: 'feeStatus' },
    { operation: 'session', route: '/private' },
    { operation: 'authorize' },
    ['partnerId', '11'],
  ])('rejects unexpected operation parameters before forwarding', async (body) => {
    expect((await relay(body)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects missing, invalid and foreign OIDC sessions', async () => {
    for (const actor of [
      { issuer, sub: 'abc' },
      { issuer: 'https://foreign.example', sub: '42' },
    ]) {
      session.getOidcActor.mockResolvedValueOnce(actor);
      expect((await relay({ operation: 'session' })).status).toBe(401);
    }
    session.getOidcActor.mockRejectedValueOnce(Error('old non-OIDC session'));
    expect((await relay({ operation: 'session' })).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stays disabled without approved issuer and a fixed upstream', async () => {
    const guard = new PartnerOpsGuard();
    const passport = jest
      .spyOn(Object.getPrototypeOf(PartnerOpsGuard.prototype), 'canActivate')
      .mockResolvedValue(true);
    for (const origin of [undefined, 'http://public.example.test', upstream + '/redirect', upstream + '/?target=x']) {
      if (origin === undefined) delete process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN;
      else process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN = origin;
      await expect(guard.canActivate(ctx(request()))).resolves.toBe(false);
    }
    expect(passport).not.toHaveBeenCalled();
    process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN = upstream;
    process.env.TOOLJET_PARTNER_OPS_ISSUER = 'https://foreign.example';
    expect((await relay({ operation: 'session' })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves scope denial and suppresses raw upstream response or transport errors', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ stack: 'private' }, { status: 404 }));
    expect(await relay({ operation: 'borrowerDpd', partnerId: '11' })).toEqual({
      status: 404,
      body: { error: 'This record is unavailable.' },
    });
    jest.mocked(fetch).mockRejectedValueOnce(Error('private'));
    expect((await relay({ operation: 'feeCheckout', dealerId: '11' })).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

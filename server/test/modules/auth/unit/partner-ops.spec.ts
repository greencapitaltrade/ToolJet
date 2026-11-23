import { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PartnerOpsController, PartnerOpsGuard } from '@modules/auth/oauth/partner-ops.controller';
import type { SessionUtilService } from '@modules/session/util.service';

const issuer = 'https://issuer.example.test/oidc';
const clientId = 'test-client';
const workspaceId = 'e38e7590-76c7-46b1-9413-d56ec6ee28af';
const tooljetOrigin = 'https://workspace.example.test';
const thorOrigin = 'http://thor.default.svc.cluster.local';
const upstream = 'http://operations.default.svc.cluster.local';
const draftId = '2dd5b04c-f85f-4d9f-afe5-06345d14a3c7';
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
    TOOLJET_OIDC_CLIENT_ID: clientId,
    TOOLJET_OIDC_CLIENT_SECRET: 'synthetic-test-only-sign-in-client',
    TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
    TOOLJET_PARTNER_OPS_ISSUER: issuer,
    TOOLJET_PARTNER_OPS_THOR_ORIGIN: thorOrigin,
    TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN: upstream,
  });
  session.getOidcActor.mockReset().mockResolvedValue({ issuer, sub: '42', clientId });
  jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (url === thorOrigin + '/v1/users/oidc-subject/42') {
      return globalThis.Response.json({ sub: '42', organization_id: '9007199254740993' });
    }
    return globalThis.Response.json({ loans: [], next_after: null });
  });
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
      'x-gct-oidc-client-id': 'untrusted-client',
      'x-gct-oidc-subject': '24',
      authorization: 'Bearer untrusted',
      'x-gct-app': 'untrusted',
    });
    expect(await relay(selector, req)).toEqual({ status: 200, body: { data: { rows: [] } } });
    expect(session.getOidcActor).toHaveBeenCalledWith(req.user);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      thorOrigin + '/v1/users/oidc-subject/42',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { 'x-gct-oidc-issuer': issuer, 'x-gct-oidc-client-id': clientId },
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      upstream + '/v1/partners/11/dpd?after=999',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { 'x-gct-user-id': '42', 'x-gct-org-id': '9007199254740993' },
      })
    );
  });

  it.each([
    { operation: 'feeCheckout', dealerId: '11', amountPaise: '1' },
    { operation: 'partners', partnerId: '1/path' },
    { operation: 'borrowerApplications', partnerId: '9223372036854775808' },
    { operation: 'dealerLink', organizationId: '7' },
    { operation: 'dealerLink' },
    { operation: 'dealerLink', partnerId: '11', after: '1' },
    { operation: 'borrowerLink', partnerId: '9223372036854775808' },
    { operation: 'borrowerApplications' },
    { operation: 'borrowerDpd' },
    { operation: 'borrowerDpd', partnerId: '11', applicationId: '11/path' },
    { operation: 'borrowerApplications', partnerId: '11', applicationId: '24' },
    { operation: 'feeStatus' },
    { operation: 'session', route: '/private' },
    { operation: 'authorize' },
    ['partnerId', '11'],
  ])('rejects unexpected operation parameters before forwarding', async (body) => {
    expect((await relay(body)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['dealerLink', 'dealer'],
    ['borrowerLink', 'borrower'],
  ])('requests a scoped Destiny referral for %s', async (operation, purpose) => {
    const url = `https://invite.example.test/#onboarding=v3.${'a'.repeat(39)}`;
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ url }));
    expect(await relay({ operation, partnerId: '11' })).toEqual({ status: 200, body: { data: { url } } });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      upstream + '/v1/channel-partners/referrals',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ purpose, partner_id: '11' }) })
    );
  });

  it.each([
    'https://invite.example.test/',
    'https://invite.example.test/#onboarding=legacy',
    `https://invite.example.test/?onboarding=v3.${'a'.repeat(39)}`,
    `http://invite.example.test/#onboarding=v3.${'a'.repeat(39)}`,
  ])('rejects a URL without an HTTPS v3 referral fragment', async (url) => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ url }));
    expect((await relay({ operation: 'dealerLink', partnerId: '11' })).status).toBe(503);
  });

  it('projects only the app session and eligible branches', async () => {
    delete process.env.TOOLJET_PARTNER_OPS_ISSUER;
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest.mocked(fetch).mockResolvedValueOnce(
      globalThis.Response.json({
        display_name: 'Klassic fixture',
        organization_id: '7',
        channels: [{ id: '11', name: 'Klassic fixture' }],
        permissions: { directory: true, cases: true, onboard: true },
        referral_targets: { dealer: [{ id: '11', name: 'Klassic fixture' }], borrower: [] },
      })
    );
    expect(await relay({ operation: 'session' })).toEqual({
      status: 200,
      body: {
        data: {
          name: 'Klassic fixture',
          partnerDirectory: true,
          capabilities: ['partners', 'borrowerApplications', 'borrowerDpd', 'feeStatus', 'dealerLink'],
          caseTargets: [{ id: '11', name: 'Klassic fixture' }],
          linkTargets: { dealerLink: [{ id: '11', name: 'Klassic fixture' }], borrowerLink: [] },
        },
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      upstream + '/v1/channel-partners/session',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('offers case access without requiring an approved self-service dealer to have a staff membership', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest.mocked(fetch).mockResolvedValueOnce(
      globalThis.Response.json({
        display_name: 'Dealer fixture',
        channels: [],
        case_targets: [{ id: '17', name: 'Dealer fixture' }],
        permissions: { directory: false, cases: true, onboard: true },
      })
    );
    const result = await relay({ operation: 'session' });
    expect(result.body.data).toMatchObject({
      partnerDirectory: false,
      capabilities: ['partners', 'borrowerApplications', 'borrowerDpd'],
      caseTargets: [{ id: '17', name: 'Dealer fixture' }],
    });
  });

  it('uses the existing partner tree and preserves branch pagination without returning draft or contact data', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest.mocked(fetch).mockResolvedValueOnce(
      globalThis.Response.json({
        partners: [
          {
            id: '17',
            name: 'Dealer fixture',
            type: 'dealer',
            status: 'pending',
            parent_id: '11',
            onboarding_status: 'in_progress',
            draft_id: draftId,
            partner_code: 'private',
          },
        ],
        next_after: '17',
      })
    );
    expect(await relay({ operation: 'partners', partnerId: '11', after: '16' })).toEqual({
      status: 200,
      body: {
        data: {
          rows: [
            {
              id: '17',
              name: 'Dealer fixture',
              type: 'dealer',
              status: 'pending',
              parentId: '11',
              onboardingStatus: 'in_progress',
              canPayFee: true,
            },
          ],
          nextAfter: '17',
        },
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      upstream + '/v1/partners?parent_id=11&after=16',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('lists scoped borrower applications without forwarding unneeded fields', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest.mocked(fetch).mockResolvedValueOnce(
      globalThis.Response.json({
        applications: [{ id: 24, status: 'pending', organization_id: '7', partner_id: '17' }],
        next_after: 24,
      })
    );
    expect(await relay({ operation: 'borrowerApplications', partnerId: '11' })).toEqual({
      status: 200,
      body: {
        data: {
          rows: [{ id: '24', status: 'pending', partnerId: '17' }],
          nextAfter: '24',
        },
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      upstream + '/v1/partners/11/applications',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('uses an optional exact case filter with the authorized partner DPD route', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest.mocked(fetch).mockResolvedValueOnce(
      globalThis.Response.json({
        loans: [{ id: draftId, application_id: '24', days_past_due: 0, as_of: '2026-11-23' }],
        next_after: null,
      })
    );
    expect(await relay({ operation: 'borrowerDpd', partnerId: '11', applicationId: '24' })).toEqual({
      status: 200,
      body: {
        data: {
          rows: [{ id: draftId, applicationId: '24', daysPastDue: 0, asOf: '2026-11-23' }],
        },
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      upstream + '/v1/partners/11/dpd?application_id=24',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it.each([
    ['feeStatus', 'refresh'],
    ['feeCheckout', 'checkout'],
  ])('resolves the authorized dealer draft for %s before calling the existing fee route', async (operation, action) => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(
        globalThis.Response.json({ id: '11', type: 'dealer', status: 'pending', draft_id: draftId })
      );
    jest.mocked(fetch).mockResolvedValueOnce(
      globalThis.Response.json({
        status: 'unpaid',
        total_paise: 350,
        currency: 'INR',
        invoice_number: 'FIXTURE',
        payment_url: 'https://pay.example.test/',
      })
    );
    expect(await relay({ operation, dealerId: '11' })).toEqual({
      status: 200,
      body: {
        data: {
          status: 'unpaid',
          amountPaise: '350',
          currency: 'INR',
          invoiceReference: 'FIXTURE',
          ...(action === 'checkout' && { checkoutUrl: 'https://pay.example.test/' }),
        },
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(2, upstream + '/v1/partners/11', expect.objectContaining({ method: 'GET' }));
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      upstream + `/v1/channel-partners/intakes/${draftId}/fee/${action}`,
      expect.objectContaining({ method: 'POST', body: '{}' })
    );
  });

  it.each([
    { id: '12', type: 'dealer', status: 'pending', draft_id: draftId },
    { id: '11', type: 'channel_partner', status: 'pending', draft_id: draftId },
    { id: '11', type: 'dealer', status: 'active', draft_id: draftId },
    { id: '11', type: 'dealer', status: 'pending', draft_id: '../different' },
  ])('does not run checkout outside the resolved pending dealer draft', async (partner) => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json(partner));
    expect((await relay({ operation: 'feeCheckout', dealerId: '11' })).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects missing, invalid and foreign OIDC sessions', async () => {
    for (const actor of [
      { issuer, sub: 'abc', clientId },
      { issuer: 'https://foreign.example', sub: '42', clientId },
      { issuer, sub: '42', clientId: 'previous-client' },
    ]) {
      session.getOidcActor.mockResolvedValueOnce(actor);
      expect((await relay({ operation: 'session' })).status).toBe(401);
    }
    session.getOidcActor.mockRejectedValueOnce(Error('old non-OIDC session'));
    expect((await relay({ operation: 'session' })).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { sub: '43', organization_id: '7' },
    { sub: '42', organization_id: 7 },
    { sub: '42', organization_id: '9223372036854775808' },
    { sub: '42', organization_id: '07' },
    null,
  ])('does not forward when Thor returns an invalid identity', async (actor) => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json(actor));
    expect((await relay({ operation: 'session' })).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, 401],
    [429, 503],
    [500, 503],
  ])('maps Thor status %s without calling the operations service', async (status, expected) => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ private: 'fixture' }, { status }));
    expect((await relay({ operation: 'session' })).status).toBe(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stays disabled without configured SSO and private upstreams', async () => {
    const guard = new PartnerOpsGuard();
    const passport = jest
      .spyOn(Object.getPrototypeOf(PartnerOpsGuard.prototype), 'canActivate')
      .mockResolvedValue(true);
    for (const origin of [undefined, 'https://public.example.test', upstream + '/redirect', upstream + '/?target=x']) {
      if (origin === undefined) delete process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN;
      else process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN = origin;
      await expect(guard.canActivate(ctx(request()))).resolves.toBe(false);
    }
    expect(passport).not.toHaveBeenCalled();
    process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN = upstream;
    for (const origin of [undefined, 'https://public.example.test', thorOrigin + '/override']) {
      if (origin === undefined) delete process.env.TOOLJET_PARTNER_OPS_THOR_ORIGIN;
      else process.env.TOOLJET_PARTNER_OPS_THOR_ORIGIN = origin;
      expect(await guard.canActivate(ctx(request()))).toBe(false);
    }
    process.env.TOOLJET_PARTNER_OPS_THOR_ORIGIN = thorOrigin;
    delete process.env.TOOLJET_OIDC_ISSUER;
    expect((await relay({ operation: 'session' })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves scope denial and suppresses raw upstream response or transport errors', async () => {
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }))
      .mockResolvedValueOnce(globalThis.Response.json({ stack: 'private' }, { status: 404 }));
    expect(await relay({ operation: 'borrowerDpd', partnerId: '11' })).toEqual({
      status: 404,
      body: { error: 'This record is unavailable.' },
    });
    jest.mocked(fetch).mockRejectedValueOnce(Error('private'));
    expect((await relay({ operation: 'feeCheckout', dealerId: '11' })).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

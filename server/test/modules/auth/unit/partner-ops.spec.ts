import { runPartnerOps } from '@modules/data-queries/partner-ops.relay';
import type { SessionUtilService } from '@modules/session/util.service';

const issuer = 'https://issuer.example.test/oidc';
const clientId = 'test-client';
const workspaceId = 'e38e7590-76c7-46b1-9413-d56ec6ee28af';
const tooljetOrigin = 'https://workspace.example.test';
const thorOrigin = 'http://thor.default.svc.cluster.local';
const upstream = 'http://operations.default.svc.cluster.local';
const draftId = '2dd5b04c-f85f-4d9f-afe5-06345d14a3c7';
const session = { getOidcActor: jest.fn() };
const user = { id: 'test-user', sessionId: 'test-session', organizationId: workspaceId };

async function relay(body: unknown) {
  const result = await runPartnerOps(session as unknown as SessionUtilService, user, body);
  return { status: result.status, body: result.data ? { data: result.data } : { error: result.error } };
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
  it('forwards only fixed path, allowed parameters and verified identity through the configured mesh', async () => {
    const selector = { operation: 'borrowerDpd', partnerId: '11', after: '999' };
    expect(await relay(selector)).toEqual({ status: 200, body: { data: { rows: [] } } });
    expect(session.getOidcActor).toHaveBeenCalledWith(user);
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
    { operation: 'partners', partnerId: 11 },
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
            id: 17,
            name: 'Dealer fixture',
            type: 'dealer',
            status: 'pending',
            parent_id: 11,
            onboarding_status: 'in_progress',
            draft_id: draftId,
            partner_code: 'private',
          },
        ],
        next_after: 17,
      })
    );
    const firstPage = await relay({ operation: 'partners', partnerId: '11', after: '16' });
    expect(firstPage).toEqual({
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

    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }))
      .mockResolvedValueOnce(globalThis.Response.json({ partners: [], next_after: null }));
    const { nextAfter, rows } = firstPage.body.data;
    expect(await relay({ operation: 'partners', partnerId: rows[0].parentId, after: nextAfter })).toEqual({
      status: 200,
      body: { data: { rows: [] } },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      upstream + '/v1/partners?parent_id=11&after=17',
      expect.objectContaining({ method: 'GET' })
    );

    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }))
      .mockResolvedValueOnce(globalThis.Response.json({ applications: [], next_after: null }));
    expect(await relay({ operation: 'borrowerApplications', partnerId: rows[0].id })).toEqual({
      status: 200,
      body: { data: { rows: [] } },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      6,
      upstream + '/v1/partners/17/applications',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('preserves exact decimal BIGINT strings in partner rows and cursors', async () => {
    const id = '9223372036854775807';
    const parent = '9007199254740993';
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }))
      .mockResolvedValueOnce(
        globalThis.Response.json({
          partners: [{ id, name: 'Dealer fixture', type: 'dealer', status: 'pending', parent_id: parent }],
          next_after: id,
        })
      );
    expect(await relay({ operation: 'partners', partnerId: parent })).toMatchObject({
      status: 200,
      body: { data: { rows: [{ id, parentId: parent }], nextAfter: id } },
    });
  });

  it.each([
    [{ operation: 'partners' }, { partners: [{ id: 9007199254740992, parent_id: null }] }],
    [{ operation: 'partners' }, { partners: [{ id: 11, parent_id: 9007199254740992 }] }],
    [{ operation: 'partners' }, { partners: [], next_after: 9007199254740992 }],
    [
      { operation: 'borrowerApplications', partnerId: '11' },
      { applications: [{ id: 24, status: 'pending', partner_id: 9007199254740992 }] },
    ],
    [
      { operation: 'borrowerDpd', partnerId: '11' },
      { loans: [], next_after: 9007199254740992 },
    ],
    [
      { operation: 'feeCheckout', dealerId: '9007199254740992' },
      { id: 9007199254740992, type: 'dealer', status: 'pending' },
    ],
  ])('fails closed when Destiny returns an unsafe numeric identifier for %p', async (input, result) => {
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }))
      .mockResolvedValueOnce(globalThis.Response.json(result));
    expect((await relay(input)).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('lists scoped borrower applications without forwarding unneeded fields', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest.mocked(fetch).mockResolvedValueOnce(
      globalThis.Response.json({
        applications: [{ id: 24, status: 'pending', organization_id: 7, partner_id: 17 }],
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
    ['feeStatus', 'refresh', 11, 'limit=1&after=10'],
    ['feeCheckout', 'checkout', 1, 'limit=1'],
    ['feeCheckout', 'checkout', '9223372036854775807', 'limit=1&after=9223372036854775806'],
  ])('resolves the authorized dealer draft for %s via %s with ID %s', async (operation, action, id, query) => {
    const dealer = { id, type: 'dealer', status: 'pending' };
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }))
      .mockResolvedValueOnce(globalThis.Response.json(dealer))
      .mockResolvedValueOnce(globalThis.Response.json({ partners: [{ ...dealer, draft_id: draftId }] }));
    jest.mocked(fetch).mockResolvedValueOnce(
      globalThis.Response.json({
        status: 'unpaid',
        total_paise: 350,
        currency: 'INR',
        invoice_number: 'FIXTURE',
        payment_url: 'https://pay.example.test/',
      })
    );
    expect(await relay({ operation, dealerId: String(id) })).toEqual({
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
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      upstream + `/v1/partners/${id}`,
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      upstream + `/v1/partners?${query}`,
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      upstream + `/v1/channel-partners/intakes/${draftId}/fee/${action}`,
      expect.objectContaining({ method: 'POST', body: '{}' })
    );
  });

  it.each([
    { id: 12, type: 'dealer', status: 'pending' },
    { id: 11, type: 'channel_partner', status: 'pending' },
    { id: 11, type: 'dealer', status: 'active' },
  ])('does not look up a draft when the selected partner is not the authorized pending dealer', async (partner) => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }));
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json(partner));
    expect((await relay({ operation: 'feeCheckout', dealerId: '11' })).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [[]],
    [[{ id: 12, type: 'dealer', status: 'pending', draft_id: draftId }]],
    [[{ id: 11, type: 'channel_partner', status: 'pending', draft_id: draftId }]],
    [[{ id: 11, type: 'dealer', status: 'active', draft_id: draftId }]],
    [[{ id: 11, type: 'dealer', status: 'pending', draft_id: '../different' }]],
  ])('does not run checkout without the exact matching pending dealer draft in the directory', async (partners) => {
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }))
      .mockResolvedValueOnce(globalThis.Response.json({ id: 11, type: 'dealer', status: 'pending' }))
      .mockResolvedValueOnce(globalThis.Response.json({ partners }));
    expect((await relay({ operation: 'feeCheckout', dealerId: '11' })).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('preserves Destiny scope denial before looking up a draft', async () => {
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ sub: '42', organization_id: '7' }))
      .mockResolvedValueOnce(globalThis.Response.json({}, { status: 403 }));
    expect((await relay({ operation: 'feeCheckout', dealerId: '11' })).status).toBe(403);
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
    for (const origin of [undefined, 'https://public.example.test', upstream + '/redirect', upstream + '/?target=x']) {
      if (origin === undefined) delete process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN;
      else process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN = origin;
      expect((await relay({ operation: 'session' })).status).toBe(404);
    }
    process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN = upstream;
    for (const origin of [undefined, 'https://public.example.test', thorOrigin + '/override']) {
      if (origin === undefined) delete process.env.TOOLJET_PARTNER_OPS_THOR_ORIGIN;
      else process.env.TOOLJET_PARTNER_OPS_THOR_ORIGIN = origin;
      expect((await relay({ operation: 'session' })).status).toBe(404);
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

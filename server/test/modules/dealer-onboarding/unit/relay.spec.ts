/** @group platform */
import { DealerOnboarding, parseDealerOnboardingConfig } from '../../../../src/modules/dealer-onboarding/relay';
import { isApplicantOnboardingRequest, sanitizeOAuthRequest } from '../../../../src/otel/sanitize';

const config = parseDealerOnboardingConfig(
  JSON.stringify({
    origin: 'https://app.example.test',
    organizationId: '39',
    furyUrl: 'https://gateway.example.test/v2/graphql',
    lspSecret: 'synthetic-service-credential',
  })
);
const referralToken = `v2.${'a'.repeat(45)}`;
const draft = {
  id: '67528714-825d-4801-b011-099e4dbe50de',
  status: 'in_progress',
  nextStep: 'details',
  canWrite: true,
};
const details = {
  gstin: '07AAAFA1234A1Z1',
  firmType: 'llp',
  businessName: 'Synthetic Dealer',
  applicantName: 'Synthetic Partner',
  applicantRole: 'Designated partner',
  email: 'applicant@example.test',
};

function setup() {
  const keys = new Map<string, string>();
  const redis = {
    async call(command: string, ...args: string[]) {
      const [key, value] = args;
      if (command === 'GET') return keys.get(key) ?? null;
      if (command === 'SET') {
        if ((args.includes('NX') && keys.has(key)) || (args.includes('XX') && !keys.has(key))) return null;
        keys.set(key, value);
        return 'OK';
      }
      if (command !== 'EVAL') throw new Error(command);
      if (args[0].includes('INCR')) {
        const count = Number(keys.get(args[2])) || 0;
        keys.set(args[2], String(count + 1));
        return count + 1;
      }
      if (args[0].includes('EXISTS')) {
        if (!keys.has(args[2]) || keys.has(args[3])) return 0;
        keys.set(args[3], args[4]);
        return Number(keys.delete(args[2]));
      }
      return keys.get(args[2]) === args[3] ? Number(keys.delete(args[2])) : 0;
    },
  };
  let created = false;
  const fetcher = jest.fn(async (_url, request) => {
    const { query, variables } = JSON.parse(request.body);
    if (query.includes('dealerReferralEligibility'))
      return Response.json({ data: { dealerReferralEligibility: { organizationId: '39', eligible: true } } });
    if (query.includes('sessionCreateV2'))
      return Response.json({ data: { sessionCreateV2: { success: true, status: 'otp_sent' } } });
    if (query.includes('sessionPut')) {
      const claims = {
        device: request.headers.device,
        phone: variables.phone,
        org_id: '39',
        user_id: '21',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      return Response.json({
        data: {
          sessionPut: { token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature` },
        },
      });
    }
    if (query.includes('dealerPanLookup'))
      return Response.json({
        data: { dealerPanLookup: created ? { status: 'resume', draft } : { status: 'new', category: 'firm' } },
      });
    if (!query.includes('dealerIntakeStart')) throw new Error('Unsupported operation');
    created = true;
    return Response.json({ data: { dealerIntakeStart: { ...draft, dossier: 'private' } } });
  });
  const service = new DealerOnboarding(redis, fetcher);
  let session: string | undefined;
  const capture = (id: string) => {
    session = id;
  };
  const call = (operation: string, fields = {}, extra = {}) =>
    service.run(config, { operation, fields, ...extra }, session, capture);
  return { service, call, fetcher, cookie: () => session };
}

it('verifies the invite and OTP, saves PAN server-side, creates under the invite and resumes only its draft', async () => {
  const { call, cookie, service, fetcher } = setup();
  await expect(call('entry', {}, { referralToken })).resolves.toEqual({ state: 'phone' });
  const old = cookie();
  await expect(call('requestOtp', { phone: '9999900001' })).resolves.toEqual({ state: 'otp' });
  await expect(call('verifyOtp', { otp: '123456' })).resolves.toEqual({ state: 'pan' });
  expect(cookie()).not.toBe(old);
  await expect(service.run(config, { operation: 'status', fields: {} }, old, jest.fn())).resolves.toEqual({
    state: 'invite',
  });
  await expect(call('lookup', { pan: ' aaafa1234a ' })).resolves.toEqual({ state: 'details', category: 'firm' });
  await expect(call('start', details)).resolves.toEqual({
    state: 'draft',
    draft,
    actions: [],
    continuationAvailable: false,
  });
  await expect(call('status')).resolves.toEqual({ state: 'draft', draft, actions: [], continuationAvailable: false });
  const requests = fetcher.mock.calls.map(([url, req]) => ({ url, headers: req.headers, ...JSON.parse(req.body) }));
  expect(requests.find((r) => r.query.includes('dealerIntakeStart')).variables).toEqual({
    referral_token: referralToken,
    input: { ...details, pan: 'AAAFA1234A' },
  });
  for (const call of requests.filter((r) => /dealerPanLookup|dealerIntakeStart/.test(r.query))) {
    expect(call.headers['api-secret']).toBeUndefined();
    expect(call.headers.cookie).toMatch(/^authorization=header\..+; device=/);
  }
});

it('rejects a foreign invite, unverified writes and browser-supplied identity', async () => {
  const { call, fetcher } = setup();
  fetcher.mockResolvedValueOnce(
    Response.json({ data: { dealerReferralEligibility: { organizationId: '42', eligible: true } } })
  );
  await expect(call('entry', {}, { referralToken })).resolves.toEqual({ state: 'invite' });
  await expect(call('requestOtp', { phone: '9999900001' })).rejects.toMatchObject({ status: 409 });
  await call('entry', {}, { referralToken });
  await expect(call('start', details)).rejects.toMatchObject({ status: 409 });
  await expect(call('start', { ...details, parent_id: '99' })).rejects.toMatchObject({ status: 400 });
  await expect(call('step', { nodeId: 'sign' })).rejects.toMatchObject({ status: 400 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('remains off without an exact HTTPS scope', () => {
  expect(parseDealerOnboardingConfig(undefined)).toBeNull();
  expect(
    parseDealerOnboardingConfig(
      JSON.stringify({ ...config, furyUrl: 'https://gateway.example.test/v2/graphql?override=true' })
    )
  ).toBeNull();
});

it('removes dealer PAN, contact details and invite tokens from application traces only on the exact route', () => {
  const body = { operation: 'lookup', fields: { pan: 'AAAFA1234A', email: 'private@example.test' } };
  expect(sanitizeOAuthRequest({ url: '/api/dealer-onboarding', body, rawBody: JSON.stringify(body) })).toMatchObject({
    body: '[REDACTED]',
    rawBody: '[REDACTED]',
  });
  expect(isApplicantOnboardingRequest('/api/dealer-onboarding-preview')).toBe(false);
});

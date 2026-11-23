/** @group platform */
import { BorrowerOnboarding, parseBorrowerOnboardingConfig } from '../../../../src/modules/borrower-onboarding/relay';
import { sanitizeOAuthRequest } from '../../../../src/otel/sanitize';
import { ApplicantSessions } from '../../../../src/modules/applicant-session/store';

const origin = 'https://app.example.test';
const referralToken = 'v3.' + 'a'.repeat(60);
const config = parseBorrowerOnboardingConfig(
  JSON.stringify({
    origin,
    organizationId: '39',
    furyUrl: 'https://gateway.example.test/v2/graphql',
    lspSecret: 'fixture-private-credential',
    returnUrl: origin + '/applications/example/documentation',
    providerOrigins: ['https://provider.example.test'],
  })
);

function setup() {
  const keys = new Map<string, string>();
  const redis = {
    async call(command: string, ...args: string[]) {
      const [key, value, option] = args;
      if (command === 'GET') return keys.get(key) ?? null;
      if (command === 'SET') {
        if (args.includes('NX') && keys.has(key)) return null;
        if (option === 'KEEPTTL' && !keys.has(key)) throw new Error('expired fixture');
        keys.set(key, value);
        return 'OK';
      }
      if (command === 'DEL') return Number(keys.delete(key));
      if (command === 'EVAL' && args[0].includes('INCR')) {
        const count = Number(keys.get(args[2]) ?? '0') + 1;
        keys.set(args[2], String(count));
        return count;
      }
      if (command === 'EVAL' && args[0].includes('EXISTS')) {
        if (!keys.has(args[2]) || keys.has(args[3])) return 0;
        keys.set(args[3], args[4]);
        return Number(keys.delete(args[2]));
      }
      if (command === 'EVAL' && keys.get(args[2]) === args[3]) return Number(keys.delete(args[2]));
      if (command === 'EVAL') return 0;
      throw new Error(command);
    },
  };
  const flow: {
    productId: number;
    steps: {
      nodeId: string;
      stepType: string;
      label: string;
      status: string;
      borrowerAction?: string;
      formFields?: { name: string; label: string; type: string; required: boolean }[];
    }[];
  } = {
    productId: 12,
    steps: [
      {
        nodeId: 'vehicle',
        stepType: 'form',
        label: 'Vehicle details',
        status: 'active',
        borrowerAction: 'form',
        formFields: [{ name: 'registered', label: 'Registered', type: 'boolean', required: true }],
      },
      { nodeId: 'bureau', stepType: 'credit_check', label: 'Bureau', status: 'active' },
      { nodeId: 'invoice', stepType: 'document_collection', label: 'Battery invoice', status: 'active' },
    ],
  };
  const fetcher = jest.fn(async (_url, request) => {
    const { query, variables } = JSON.parse(request.body);
    const body = query.includes('borrowerReferralEligibility')
      ? { borrowerReferralEligibility: { organizationId: '39', productId: 12 } }
      : query.includes('sessionCreateV2')
        ? { sessionCreateV2: { success: true, status: 'otp_sent' } }
        : query.includes('sessionPut')
          ? { sessionPut: { token: makeToken(request.headers.device, variables.phone) } }
          : query.includes('applicationCreateFromReferral')
            ? { applicationCreateFromReferral: { id: 701, product_id: 12 } }
            : query.includes('executeFlowStep')
              ? { executeFlowStep: { __typename: 'FlowStepSuccess' } }
              : { applicationFlow: flow };
    return Response.json({ data: body });
  });
  const service = new BorrowerOnboarding(redis, fetcher);
  let session: string | undefined;
  const call = (operation: string, fields = {}, extra = {}) =>
    service.run(config, { operation, fields, ...extra }, session, (value) => {
      session = value;
    });
  return { call, fetcher, flow, redis, service, getCookie: () => session };
}

function makeToken(device: string, phone: string, org = '39') {
  return (
    'header.' +
    Buffer.from(
      JSON.stringify({
        device,
        phone,
        org_id: org,
        user_id: '28',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString('base64url') +
    '.signature'
  );
}

it('keeps all auth and application authority server side across the full relay', async () => {
  const { call, fetcher, getCookie, service } = setup();
  await expect(call('entry', {}, { referralToken: 'v2.' + referralToken.slice(3) })).rejects.toMatchObject({
    status: 400,
  });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(call('entry', {}, { referralToken })).resolves.toEqual({ state: 'phone' });
  const guest = getCookie();
  await expect(call('requestOtp', { phone: '9000000001' })).resolves.toEqual({ state: 'otp' });
  const view = await call('verifyOtp', { otp: '123456' });
  expect(getCookie()).not.toBe(guest);
  await expect(service.run(config, { operation: 'status', fields: {} }, guest, jest.fn())).resolves.toEqual({
    state: 'invite',
  });
  expect(view).toMatchObject({
    state: 'journey',
    journey: {
      id: 701,
      actions: [{ nodeId: 'vehicle' }],
      steps: expect.arrayContaining([
        { nodeId: 'invoice', label: 'Battery invoice', status: 'active', actionUnavailable: true },
      ]),
    },
  });
  expect(JSON.stringify(view)).not.toMatch(/header\.|fixture-private|device|provider_reference/);

  const requests = fetcher.mock.calls.map(([url, request]) => ({ url, ...request, ...JSON.parse(request.body) }));
  expect(requests.every(({ url }) => url === 'https://gateway.example.test/v2/graphql')).toBe(true);
  expect(
    requests
      .slice(0, 4)
      .every(({ headers }) => headers['api-secret'] === 'fixture-private-credential' && !headers.cookie)
  ).toBe(true);
  expect(
    requests
      .slice(4)
      .every(({ headers }) => !headers['api-secret'] && /^authorization=.+; device=/.test(headers.cookie))
  ).toBe(true);
  expect(requests[4].variables).toEqual({ referral_token: referralToken });
});

it('rejects cross-provider selectors, unavailable steps and added form fields', async () => {
  const { call, fetcher } = setup();
  await expect(call('entry', {}, { referralToken, organizationId: '42' })).rejects.toMatchObject({ status: 400 });
  await call('entry', {}, { referralToken });
  await call('requestOtp', { phone: '9000000001' });
  await call('verifyOtp', { otp: '123456' });
  await expect(call('step', { nodeId: 'bureau', values: {} })).rejects.toMatchObject({ status: 409 });
  await expect(call('step', { nodeId: 'invoice', values: {} })).rejects.toMatchObject({ status: 409 });
  await expect(call('step', { nodeId: 'vehicle', values: { registered: 'Yes', user_id: '2' } })).rejects.toMatchObject({
    status: 400,
  });
  await call('step', { nodeId: 'vehicle', values: { registered: 'Yes' } });
  const submissions = fetcher.mock.calls
    .map(([, req]) => JSON.parse(req.body))
    .filter(({ query }) => query.includes('executeFlowStep'));
  expect(submissions).toHaveLength(1);
  expect(submissions[0].variables).toMatchObject({
    application_id: 701,
    type: 'FORM',
    kind: 'FORM',
    data: { nodeId: 'vehicle', formAnswers: { registered: 'true' } },
  });
});

it('fails closed before any OTP on a foreign or invalid scoped invitation', async () => {
  const { call, fetcher } = setup();
  fetcher.mockResolvedValueOnce(
    Response.json({ data: { borrowerReferralEligibility: { organizationId: '42', productId: 12 } } })
  );
  await expect(call('entry', {}, { referralToken })).resolves.toEqual({ state: 'invite' });
  await expect(call('requestOtp', { phone: '9000000001' })).rejects.toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('partitions shared applicant sessions by purpose and exact tenant scope', async () => {
  const { call, redis, getCookie } = setup();
  await call('entry', {}, { referralToken });
  const borrower = new ApplicantSessions(redis, 'borrower');
  const dealer = new ApplicantSessions(redis, 'dealer');
  const cookie = getCookie();
  expect(await borrower.get(borrower.key(config, cookie))).not.toBeNull();
  expect(await dealer.get(dealer.key(config, cookie))).toBeNull();
  expect(await borrower.get(borrower.key({ ...config, organizationId: '42' }, cookie))).toBeNull();
});

it('keeps the relay disabled with an invalid destination or absent config', () => {
  expect(parseBorrowerOnboardingConfig(undefined)).toBeNull();
  expect(
    parseBorrowerOnboardingConfig(JSON.stringify({ ...config, furyUrl: 'http://downstream.example.test/v2/graphql' }))
  ).toBeNull();
  expect(
    parseBorrowerOnboardingConfig(JSON.stringify({ ...config, returnUrl: 'https://foreign.example.test/' }))
  ).toBeNull();
});

it('rejects an OTP exchange for a different organization or device before creating any case', async () => {
  const { call, fetcher, getCookie } = setup();
  await call('entry', {}, { referralToken });
  await call('requestOtp', { phone: '9000000001' });
  const original = getCookie();
  fetcher.mockImplementationOnce(async (_url, request) =>
    Response.json({
      data: { sessionPut: { token: makeToken(request.headers.device, '9000000001', '42') } },
    })
  );
  fetcher.mockImplementationOnce(async () =>
    Response.json({
      data: { sessionPut: { token: makeToken('different-device', '9000000001') } },
    })
  );
  await expect(call('verifyOtp', { otp: '123456' })).rejects.toMatchObject({ status: 401 });
  await expect(call('verifyOtp', { otp: '123456' })).rejects.toMatchObject({ status: 401 });
  expect(getCookie()).toBe(original);
  expect(fetcher.mock.calls.every(([, req]) => !req.body.includes('applicationCreateFromReferral'))).toBe(true);
});

it('fails closed when revoked after entry and enforces a shared phone send budget', async () => {
  const { call, fetcher } = setup();
  await call('entry', {}, { referralToken });
  fetcher.mockResolvedValueOnce(Response.json({ errors: [{ message: 'private provider message' }] }));
  await expect(call('requestOtp', { phone: '9000000001' })).rejects.toMatchObject({ status: 409 });
  await call('requestOtp', { phone: '9000000001' });
  await call('requestOtp', { phone: '9000000001' });
  const before = fetcher.mock.calls.length;
  await expect(call('requestOtp', { phone: '9000000001' })).rejects.toMatchObject({ status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(before);
});

it('redacts the whole borrower payload and strips a legacy invite from logged URLs', () => {
  const result = sanitizeOAuthRequest({
    url: '/api/borrower-onboarding',
    body: { operation: 'verifyOtp', fields: { otp: '123456' }, referralToken },
    rawBody: Buffer.from(referralToken),
    headers: { referer: `${origin}/applications/example/documentation?onboarding=${referralToken}` },
  });
  expect(result.body).toBe('[REDACTED]');
  expect(result.rawBody).toBe('[REDACTED]');
  expect(result.headers.referer).toBe(origin + '/applications/example/documentation');
});

it('serializes concurrent provider actions and withholds unapproved redirect destinations', async () => {
  const { call, fetcher, flow } = setup();
  await call('entry', {}, { referralToken });
  await call('requestOtp', { phone: '9000000001' });
  await call('verifyOtp', { otp: '123456' });
  fetcher.mockResolvedValueOnce(Response.json({ data: { applicationFlow: flow } }));
  let releaseProvider: (value: Response) => void;
  let providerStarted: () => void;
  const called = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  fetcher.mockImplementationOnce(() => {
    providerStarted();
    return new Promise<Response>((resolve) => {
      releaseProvider = resolve;
    });
  });
  const first = call('step', { nodeId: 'vehicle', values: { registered: 'Yes' } });
  await called;
  await expect(call('step', { nodeId: 'vehicle', values: { registered: 'No' } })).rejects.toMatchObject({
    status: 409,
  });
  releaseProvider(
    Response.json({
      data: {
        executeFlowStep: {
          __typename: 'FlowStepPending',
          redirectUrl: 'https://unapproved.example.test/callback',
        },
      },
    })
  );
  await expect(first).rejects.toMatchObject({ status: 503 });
  await expect(call('status')).resolves.toMatchObject({ state: 'journey' });
});

it('supports explicit PAN and bank consent without reading or logging the persisted PAN', async () => {
  const { call, fetcher, flow } = setup();
  flow.steps.push({ nodeId: 'pan', stepType: 'kyc_pan', label: 'PAN', status: 'active', borrowerAction: 'pan' });
  flow.steps.push({
    nodeId: 'bank',
    stepType: 'bank_statement',
    label: 'Bank',
    status: 'active',
    borrowerAction: 'account_aggregator',
  });
  flow.steps.push({ nodeId: 'aadhaar', stepType: 'kyc_aadhaar', label: 'Aadhaar', status: 'active' });
  await call('entry', {}, { referralToken });
  await call('requestOtp', { phone: '9000000001' });
  const view = await call('verifyOtp', { otp: '123456' });
  expect(view).toMatchObject({
    journey: {
      actions: expect.arrayContaining([expect.objectContaining({ nodeId: 'pan' })]),
      steps: expect.arrayContaining([expect.objectContaining({ nodeId: 'aadhaar', actionUnavailable: true })]),
    },
  });
  await expect(call('step', { nodeId: 'pan', values: { value: 'bad' } })).rejects.toMatchObject({ status: 400 });
  await call('step', { nodeId: 'pan', values: { value: 'abcpe1234f' } });
  await call('step', { nodeId: 'bank', values: {} });
  const calls = fetcher.mock.calls.map(([, req]) => JSON.parse(req.body));
  expect(calls.some(({ query }) => query.includes('applicationUserPan'))).toBe(false);
  expect(calls.filter(({ query }) => query.includes('executeFlowStep')).map(({ variables }) => variables)).toEqual([
    { application_id: 701, type: 'KYC', kind: 'PAN', data: { value: 'ABCPE1234F' } },
    {
      application_id: 701,
      type: 'BANK_STATEMENT',
      kind: 'AA',
      data: { mobile: '9000000001', redirectUrl: origin + '/applications/example/documentation' },
    },
  ]);
});

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
    documentRequest?: unknown;
    steps: {
      nodeId: string;
      stepType: string;
      label: string;
      status: string;
      allowedKinds?: string[];
      documentRequirements?: { type: string; provider: string; required: boolean; status?: string }[];
      formFields?: { name: string; label: string; type: string; required: boolean; maxlength?: number }[];
    }[];
  } = {
    productId: 12,
    steps: [
      {
        nodeId: 'vehicle',
        stepType: 'form',
        label: 'Vehicle details',
        status: 'active',
        formFields: [{ name: 'registered', label: 'Registered', type: 'boolean', required: true }],
      },
      { nodeId: 'bureau', stepType: 'credit_check', label: 'Bureau', status: 'active' },
      {
        nodeId: 'invoice',
        stepType: 'document_collection',
        label: 'Battery invoice',
        status: 'active',
        documentRequirements: [{ type: 'invoice', provider: 'manual', required: true, status: 'pending' }],
      },
    ],
  };
  const fetcher = jest.fn(async (_url, request) => {
    if (request.body instanceof FormData) {
      flow.steps.find(({ nodeId }) => nodeId === 'invoice')!.documentRequirements![0].status = 'collected';
      return Response.json({ attached: true });
    }
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
      documentUploads: [{ nodeId: 'invoice', documents: [{ code: 'invoice', required: true }] }],
      steps: expect.arrayContaining([{ nodeId: 'invoice', label: 'Battery invoice', status: 'active' }]),
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
  const flowRead = requests.find(({ query }) => query.includes('applicationFlow'));
  expect(flowRead.query).toMatch(/steps\s*\{\s*nodeId stepType status label formFields/);
  expect(flowRead.query).not.toContain('borrowerAction');
});

it('uploads only configured pending manual evidence using its bound actor and case', async () => {
  const { call, fetcher, getCookie, service, flow } = setup();
  const file = Buffer.from('%PDF-1.4 fixture');
  const read = jest.fn().mockResolvedValue({ nodeId: 'invoice', code: 'invoice', file });
  await call('entry', {}, { referralToken });
  await expect(service.upload(config!, read, getCookie())).rejects.toMatchObject({ status: 409 });
  expect(read).not.toHaveBeenCalled();
  await call('requestOtp', { phone: '9000000001' });
  await call('verifyOtp', { otp: '123456' });
  const bad = { nodeId: 'invoice', code: 'pan', file };
  await expect(service.upload(config!, async () => bad, getCookie())).rejects.toMatchObject({ status: 409 });
  await expect(
    service.upload(config!, async () => ({ ...bad, applicationId: 999 }), getCookie())
  ).rejects.toMatchObject({ status: 400 });
  const result = await service.upload(config!, read, getCookie());
  expect(result).not.toHaveProperty('journey.documentUploads');
  expect(result).toMatchObject({ state: 'journey', journey: { id: 701 } });
  const uploads = fetcher.mock.calls.filter(([, req]) => req.body instanceof FormData);
  expect(uploads).toHaveLength(1);
  const [url, request] = uploads[0];
  expect(String(url)).toBe('https://gateway.example.test/v2/borrower/document');
  expect(request.headers.cookie).toMatch(/^authorization=.+; device=/);
  expect(request.headers['api-secret']).toBeUndefined();
  expect(JSON.parse(request.body.get('metadata'))).toEqual({ applicationId: 701, nodeId: 'invoice', code: 'invoice' });
  await expect(request.body.get('file').text()).resolves.toBe(file.toString());
  flow.steps.find(({ nodeId }) => nodeId === 'invoice')!.status = 'completed';
  await expect(service.upload(config!, read, getCookie())).rejects.toMatchObject({ status: 409 });
});

it('offers DigiLocker only for the active KYC node, and refreshes the step before submission', async () => {
  const { call, fetcher, flow } = setup();
  const kyc = {
    nodeId: 'primary-identity-check',
    stepType: 'document_collection',
    label: 'KYC',
    status: 'active',
    allowedKinds: ['DIGILOCKER'],
    documentRequirements: [{ type: 'pan', provider: 'digilocker', required: true }],
  };
  const invoice = flow.steps.find(({ nodeId }) => nodeId === 'invoice')!;
  invoice.status = 'pending';
  flow.steps.unshift(kyc);

  await call('entry', {}, { referralToken });
  await call('requestOtp', { phone: '9000000001' });
  await expect(call('verifyOtp', { otp: '123456' })).resolves.toMatchObject({
    journey: {
      actions: [{ nodeId: kyc.nodeId, label: 'Verify identity with DigiLocker' }, { nodeId: 'vehicle' }],
    },
  });

  await call('step', { nodeId: kyc.nodeId, values: {} });
  kyc.status = 'completed';
  invoice.status = 'active';
  await expect(call('step', { nodeId: kyc.nodeId, values: {} })).rejects.toMatchObject({ status: 409 });
  await expect(call('step', { nodeId: 'invoice', values: {} })).rejects.toMatchObject({ status: 409 });
  const submissions = fetcher.mock.calls
    .map(([, request]) => JSON.parse(request.body))
    .filter(({ query }) => query.includes('executeFlowStep'));
  expect(submissions.map(({ variables }) => variables)).toEqual([
    {
      application_id: 701,
      type: 'KYC',
      kind: 'DIGILOCKER',
      data: { nodeId: kyc.nodeId, redirectUrl: origin + '/applications/example/documentation' },
    },
  ]);
});

it('offers pending DigiLocker and manual evidence on the same configured node', async () => {
  const { call, fetcher, flow } = setup();
  const node = flow.steps.find(({ nodeId }) => nodeId === 'invoice')!;
  const identity = { type: 'aadhaar', provider: 'digilocker', required: true, status: 'pending' };
  node.allowedKinds = ['DIGILOCKER'];
  node.documentRequirements!.push(identity);

  await call('entry', {}, { referralToken });
  await call('requestOtp', { phone: '9000000001' });
  await expect(call('verifyOtp', { otp: '123456' })).resolves.toMatchObject({
    journey: {
      actions: [{ nodeId: 'vehicle' }, { nodeId: 'invoice', label: 'Verify identity with DigiLocker' }],
      documentUploads: [{ nodeId: 'invoice', documents: [{ code: 'invoice', required: true }] }],
    },
  });

  await call('step', { nodeId: 'invoice', values: {} });
  const submissions = () =>
    fetcher.mock.calls
      .map(([, request]) => JSON.parse(request.body))
      .filter(({ query }) => query.includes('executeFlowStep'));
  expect(submissions().map(({ variables }) => variables)).toEqual([
    {
      application_id: 701,
      type: 'KYC',
      kind: 'DIGILOCKER',
      data: { nodeId: 'invoice', redirectUrl: origin + '/applications/example/documentation' },
    },
  ]);

  identity.status = 'collected';
  await expect(call('status')).resolves.toMatchObject({
    journey: {
      actions: [{ nodeId: 'vehicle' }],
      documentUploads: [{ nodeId: 'invoice', documents: [{ code: 'invoice', required: true }] }],
    },
  });
  await expect(call('step', { nodeId: 'invoice', values: {} })).rejects.toMatchObject({ status: 409 });

  identity.status = 'pending';
  node.allowedKinds = ['PAN'];
  await expect(call('step', { nodeId: 'invoice', values: {} })).rejects.toMatchObject({ status: 409 });
  expect(submissions()).toHaveLength(1);
});

it('accepts the configured active camera node only through the authenticated selfie upload', async () => {
  const { call, fetcher, flow, getCookie, service } = setup();
  const selfie = {
    nodeId: 'capture',
    stepType: 'selfie',
    label: 'Selfie',
    status: 'active',
    allowedKinds: ['CAPTURE'],
  };
  flow.steps.push(selfie, { ...selfie, nodeId: 'future', status: 'pending' });
  const file = Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xd9]);
  const read = jest.fn().mockResolvedValue({ nodeId: 'capture', file });

  await call('entry', {}, { referralToken });
  await expect(service.uploadSelfie(config!, read, getCookie())).rejects.toMatchObject({ status: 409 });
  expect(read).not.toHaveBeenCalled();
  await call('requestOtp', { phone: '9000000001' });
  await expect(call('verifyOtp', { otp: '123456' })).resolves.toMatchObject({
    journey: {
      actions: [
        expect.objectContaining({ nodeId: 'vehicle' }),
        { nodeId: 'capture', label: 'Take your selfie', camera: true },
      ],
    },
  });
  await expect(call('step', { nodeId: 'capture', values: {} })).rejects.toMatchObject({ status: 400 });
  await expect(
    service.uploadSelfie(config!, async () => ({ nodeId: 'future', file }), getCookie())
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    service.uploadSelfie(config!, async () => ({ nodeId: 'capture', file, applicationId: 999 }), getCookie())
  ).rejects.toMatchObject({ status: 400 });
  await service.uploadSelfie(config!, read, getCookie());
  const submissions = fetcher.mock.calls
    .map(([, request]) => ({ headers: request.headers, ...JSON.parse(request.body) }))
    .filter(({ query }) => query.includes('executeFlowStep'));
  expect(submissions).toHaveLength(1);
  expect(submissions[0].headers.cookie).toMatch(/^authorization=.+; device=/);
  expect(submissions[0].variables).toEqual({
    application_id: 701,
    type: 'SELFIE',
    kind: 'CAPTURE',
    data: { nodeId: 'capture', selfie: 'data:image/jpeg;base64,/9j//9k=' },
  });
  selfie.allowedKinds = [];
  await expect(service.uploadSelfie(config!, read, getCookie())).rejects.toMatchObject({ status: 409 });
});

it('returns the scoped bank statement request and clears it from a subsequent server read', async () => {
  const { call, fetcher, flow, getCookie, service } = setup();
  const bank = {
    nodeId: 'bank',
    stepType: 'bank_statement',
    label: 'Bank statements',
    status: 'active',
    allowedKinds: ['AA'],
  };
  const documentRequest = {
    stepId: 'bank',
    reason: 'Please provide two more months of bank statements.',
    requiredDocuments: ['bank_statement'],
  };
  flow.steps.push(bank);
  flow.documentRequest = { ...documentRequest, officerId: 'private-reviewer', caseId: 999 };

  await call('entry', {}, { referralToken });
  const guest = getCookie();
  await call('requestOtp', { phone: '9000000001' });
  const first = await call('verifyOtp', { otp: '123456' });
  expect(first).toMatchObject({ journey: { id: 701, documentRequest } });
  expect(JSON.stringify(first)).not.toMatch(/private-reviewer|caseId/);
  const requests = fetcher.mock.calls.map(([, req]) => JSON.parse(req.body));
  const flowRead = requests.find(({ query }) => query.includes('applicationFlow'));
  expect(flowRead.query).toMatch(/documentRequest\s*\{\s*stepId\s+reason\s+requiredDocuments\s*\}/);
  expect(flowRead.variables).toEqual({ application_id: 701 });

  await expect(service.run(config, { operation: 'status', fields: {} }, guest, jest.fn())).resolves.toEqual({
    state: 'invite',
  });
  await expect(call('status', { application_id: 999 })).rejects.toMatchObject({ status: 400 });

  bank.status = 'completed';
  flow.documentRequest = null;
  const next = await call('status');
  expect(next).not.toHaveProperty('journey.documentRequest');
});

it('withholds document requests for the wrong step, unsupported documents and invalid reasons', async () => {
  const { call, flow } = setup();
  flow.steps.push({
    nodeId: 'bank',
    stepType: 'bank_statement',
    label: 'Bank statements',
    status: 'active',
    allowedKinds: ['AA'],
  });
  await call('entry', {}, { referralToken });
  await call('requestOtp', { phone: '9000000001' });
  await call('verifyOtp', { otp: '123456' });
  const request = { stepId: 'bank', reason: 'Recent statements', requiredDocuments: ['bank_statement'] };
  for (const invalid of [
    { ...request, stepId: 'vehicle' },
    { ...request, stepId: 'foreign-bank' },
    { ...request, requiredDocuments: ['arbitrary_upload'] },
    { ...request, reason: 'x'.repeat(501) },
  ]) {
    flow.documentRequest = invalid;
    expect(await call('status')).not.toHaveProperty('journey.documentRequest');
  }
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

it('passes configured text limits and forwards answers at those limits unchanged', async () => {
  const { call, fetcher, flow } = setup();
  const node = flow.steps.find(({ nodeId }) => nodeId === 'vehicle')!;
  node.formFields = [
    { name: 'reference', label: 'Reference', type: 'text', required: true, maxlength: 1 },
    { name: 'description', label: 'Description', type: 'textarea', required: true, maxlength: 400 },
    { name: 'legacy', label: 'Legacy field', type: 'text', required: false },
  ];
  await call('entry', {}, { referralToken });
  await call('requestOtp', { phone: '9000000001' });
  const view = await call('verifyOtp', { otp: '123456' });
  expect(view).toMatchObject({ journey: { actions: [{ nodeId: 'vehicle', fields: node.formFields }] } });

  const values = { reference: 'A', description: 'x'.repeat(400), legacy: 'old' };
  await call('step', { nodeId: 'vehicle', values });
  const submissions = fetcher.mock.calls
    .map(([, req]) => JSON.parse(req.body))
    .filter(({ query }) => query.includes('executeFlowStep'));
  expect(submissions).toHaveLength(1);
  expect(submissions[0].variables.data).toEqual({ nodeId: 'vehicle', formAnswers: values });
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
  flow.steps.push({ nodeId: 'pan', stepType: 'kyc_pan', label: 'PAN', status: 'active', allowedKinds: ['PAN'] });
  flow.steps.push({
    nodeId: 'bank',
    stepType: 'bank_statement',
    label: 'Bank',
    status: 'active',
    allowedKinds: ['AA'],
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

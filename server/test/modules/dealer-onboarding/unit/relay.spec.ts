/** @group platform */
import { DealerOnboarding, parseDealerOnboardingConfig } from '../../../../src/modules/dealer-onboarding/relay';
import { parseDealerParticipantConfig } from '../../../../src/modules/dealer-onboarding/participant';
import { isApplicantOnboardingRequest, sanitizeOAuthRequest } from '../../../../src/otel/sanitize';

const config = parseDealerOnboardingConfig(
  JSON.stringify({
    origin: 'https://app.example.test',
    organizationId: '39',
    furyUrl: 'https://gateway.example.test/v2/graphql',
    lspSecret: 'synthetic-service-credential',
  })
);
const referralToken = `v3.${'a'.repeat(45)}`;
const draft = {
  id: '67528714-825d-4801-b011-099e4dbe50de',
  status: 'in_progress',
  nextStep: 'details',
  canWrite: true,
};
const details = {
  firmType: 'llp',
  businessName: 'Synthetic Dealer',
  applicantName: 'Synthetic Partner',
  applicantRole: 'Designated partner',
  email: 'applicant@example.test',
};

const signingUrl = 'https://sign.example.test/synthetic-own-link';
const signing = { kycOrigin: 'https://kyc.example.test', signingOrigin: 'https://sign.example.test' };

function setup(settings = config) {
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
  let entityFields: string[] = [];
  let evidence: unknown[] = [];
  let completionStage = 'bank_verification_required';
  let completionUrl = signingUrl;
  const fetcher = jest.fn(async (_url, request) => {
    if (request.body instanceof FormData) return Response.json({ attached: true });
    const { query, variables } = JSON.parse(request.body);
    if (new URL(_url).pathname === '/v2/dealer/dossier') {
      const saved = variables.action === 'SAVE_OWN_DIN';
      return Response.json({
        version: saved ? 6 : 5,
        history: 'bank_and_gst',
        execution: 'registered_entity',
        own_din: saved ? null : 'DIN',
        bank_account_number: 'private',
      });
    }
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
    if (query.includes('dealerOwnerParticipant'))
      return Response.json({ data: { dealerOwnerParticipant: { status: 'invited', id: draft.id } } });
    if (query.includes('dealerOwnerCompletion'))
      return Response.json({
        data: {
          dealerOwnerCompletion: {
            stage: completionStage,
            version: 5,
            actions:
              completionStage === 'bank_verification_required'
                ? ['VERIFY_BANK']
                : completionStage === 'signing_pending'
                  ? ['REFRESH', 'SIGN']
                  : [],
            signingUrl: completionUrl,
            signer: 'private',
          },
        },
      });
    if (query.includes('dealerPanLookup'))
      return Response.json({
        data: {
          dealerPanLookup: created
            ? { status: 'resume', draft: { ...draft, entityFields, documentActions: evidence, version: 3 } }
            : { status: 'new', category: 'firm' },
        },
      });
    if (query.includes('dealerIntakeStatus'))
      return Response.json({
        data: { dealerIntakeStatus: { ...draft, entityFields, documentActions: evidence, version: 3 } },
      });
    if (query.includes('dealerEntityDetailsSave'))
      return Response.json({ data: { dealerEntityDetailsSave: { ...draft, entityFields } } });
    if (!query.includes('dealerIntakeStart')) throw new Error('Unsupported operation');
    created = true;
    return Response.json({ data: { dealerIntakeStart: { ...draft, entityFields, dossier: 'private' } } });
  });
  const service = new DealerOnboarding(redis, fetcher);
  let session: string | undefined;
  const capture = (id: string) => {
    session = id;
  };
  const call = (operation: string, fields = {}, extra = {}) =>
    service.run(settings, { operation, fields, ...extra }, session, capture);
  return {
    service,
    call,
    fetcher,
    cookie: () => session,
    persisted: () => [...keys.values()].join(' '),
    setCompletionStage: (stage: string) => {
      completionStage = stage;
    },
    setCompletionUrl: (url: string) => {
      completionUrl = url;
    },
    setEvidence: (actions: unknown[]) => {
      evidence = actions;
    },
    entityFields: (fields: string[]) => {
      entityFields = fields;
    },
  };
}

it('binds the isolated dossier form to the current verified owner session and never stores field values', async () => {
  const fixture = setup();
  const dossier = (body: unknown) => fixture.service.dossier(config!, body, fixture.cookie());
  await fixture.call('entry', {}, { referralToken });
  await expect(dossier({ action: 'STATUS' })).rejects.toMatchObject({ status: 409 });
  await fixture.call('requestOtp', { phone: '9999900001' });
  await fixture.call('verifyOtp', { otp: '123456' });
  await fixture.call('lookup', { pan: 'AAAFA1234A' });
  await fixture.call('start', details);
  await expect(fixture.call('SAVE_OWN_DIN', { din: '12345678' })).rejects.toMatchObject({ status: 400 });
  await expect(dossier({ action: 'STATUS', draftId: draft.id })).rejects.toMatchObject({ status: 400 });
  await expect(dossier({ action: 'STATUS' })).resolves.toEqual({
    version: 5,
    history: 'bank_and_gst',
    execution: 'registered_entity',
    own_din: 'DIN',
  });
  await expect(dossier({ action: 'SAVE_OWN_DIN', version: 4, fields: { din: '12345678' } })).rejects.toMatchObject({
    status: 409,
  });
  expect(JSON.parse(fixture.fetcher.mock.calls.slice(-1)[0][1].body).variables.action).toBe('STATUS');
  await expect(dossier({ action: 'SAVE_OWN_DIN', version: 5, fields: { din: '12345678' } })).resolves.toMatchObject({
    own_din: null,
    version: 6,
  });
  const [url, options] = fixture.fetcher.mock.calls.slice(-1)[0];
  expect(String(url)).toBe('https://gateway.example.test/v2/dealer/dossier');
  expect(options.headers).toMatchObject({ cookie: expect.stringMatching(/^authorization=/) });
  expect(JSON.parse(options.body)).toEqual({
    variables: { action: 'SAVE_OWN_DIN', referralToken, draftId: draft.id, version: 5, fields: { din: '12345678' } },
  });
  expect(fixture.persisted()).not.toContain('12345678');
  expect(
    sanitizeOAuthRequest({
      url: '/api/dealer-onboarding/dossier',
      body: { fields: { bank_account_number: '12345678' } },
    }).body
  ).toBe('[REDACTED]');
});

it('uses only current server-authorized dealer completion actions and versions', async () => {
  const fixture = setup();
  await fixture.call('entry', {}, { referralToken });
  await expect(fixture.call('agreementStatus')).rejects.toMatchObject({ status: 409 });
  await fixture.call('requestOtp', { phone: '9999900001' });
  await fixture.call('verifyOtp', { otp: '123456' });
  await fixture.call('lookup', { pan: 'AAAFA1234A' });
  await fixture.call('start', details);
  await expect(fixture.call('agreementStatus')).resolves.toEqual({
    state: 'dealerCompletion',
    stage: 'bank_verification_required',
    actions: ['verifyBank'],
  });
  await expect(fixture.call('freezeAgreement', { version: 5 })).rejects.toMatchObject({ status: 400 });
  await expect(fixture.call('freezeAgreement')).rejects.toMatchObject({ status: 409 });
  await fixture.call('verifyBank');
  const updates = fixture.fetcher.mock.calls
    .map(([, request]) => JSON.parse(request.body))
    .filter((call) => call.query.includes('dealerOwnerCompletion') && call.variables.action !== 'STATUS');
  expect(updates.map((call) => call.variables)).toEqual([
    { draftId: draft.id, referralToken, action: 'VERIFY_BANK', version: 5 },
  ]);
  fixture.setCompletionStage('submitted');
  await expect(fixture.call('verifyBank')).rejects.toMatchObject({ status: 409 });
});

it('signs only the owner case at the current version with the configured exact HTTPS origin', async () => {
  const scope = (organizationId: string) =>
    parseDealerParticipantConfig(JSON.stringify({ ...config, ...signing, organizationId }));
  const pending = async (fixture: ReturnType<typeof setup>) => {
    await fixture.call('entry', {}, { referralToken });
    await expect(fixture.call('signOwnerAgreement')).rejects.toMatchObject({ status: 409 });
    await fixture.call('requestOtp', { phone: '9999900001' });
    await fixture.call('verifyOtp', { otp: '123456' });
    await fixture.call('lookup', { pan: 'AAAFA1234A' });
    await fixture.call('start', details);
    fixture.setCompletionStage('signing_pending');
  };
  const status = { state: 'dealerCompletion', stage: 'signing_pending', actions: ['refreshSignatures'] };
  for (const missing of [undefined, scope('40')]) {
    const fixture = setup(parseDealerOnboardingConfig(JSON.stringify(config), missing));
    await pending(fixture);
    await expect(fixture.call('agreementStatus')).resolves.toEqual(status);
    await expect(fixture.call('signOwnerAgreement')).rejects.toMatchObject({ status: 409 });
  }
  const fixture = setup(parseDealerOnboardingConfig(JSON.stringify(config), scope('39')));
  await pending(fixture);
  const available = { ...status, actions: [...status.actions, 'signOwnerAgreement'] };
  await expect(fixture.call('agreementStatus')).resolves.toEqual(available);
  await expect(fixture.call('signOwnerAgreement', { version: 5, signerId: '4' })).rejects.toMatchObject({
    status: 400,
  });
  await expect(fixture.call('signOwnerAgreement')).resolves.toEqual({ ...available, signingUrl });
  expect(fixture.persisted()).not.toContain(signingUrl);
  const calls = fixture.fetcher.mock.calls;
  const [, request] = calls[calls.length - 1];
  expect(JSON.parse(request.body).variables).toEqual({ draftId: draft.id, referralToken, action: 'SIGN', version: 5 });
  fixture.setCompletionUrl('https://sign.example.test.bad.example/own');
  await expect(fixture.call('signOwnerAgreement')).rejects.toMatchObject({ status: 503 });
});

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
  await expect(call('start', { ...details, gstin: '07AAAPA1234A1Z1' })).rejects.toMatchObject({ status: 400 });
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
  expect(requests.find((r) => r.query.includes('dealerIntakeStatus')).variables).toEqual({ draftId: draft.id });
  expect(requests.filter((r) => r.query.includes('dealerPanLookup'))).toHaveLength(1);
  for (const call of requests.filter((r) => /dealerPanLookup|dealerIntakeStart|dealerIntakeStatus/.test(r.query))) {
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

it('exposes and executes only the currently available server-selected entity action', async () => {
  const fixture = setup();
  await fixture.call('entry', {}, { referralToken });
  await fixture.call('requestOtp', { phone: '9999900001' });
  await fixture.call('verifyOtp', { otp: '123456' });
  await fixture.call('lookup', { pan: 'AAAFA1234A' });
  fixture.entityFields(['premises', 'llpin']);
  const action = { name: 'saveEntityDetails', fields: ['premises', 'llpin'] };
  await expect(fixture.call('start', details)).resolves.toMatchObject({ actions: [action] });
  await expect(fixture.call('saveEntityDetails', { premises: 'owned' })).rejects.toMatchObject({ status: 400 });
  await expect(fixture.call('saveEntityDetails', { premises: 'owned', llpin: 'ABC-1234' })).resolves.toMatchObject({
    actions: [action],
  });
  fixture.entityFields([]);
  await expect(fixture.call('saveEntityDetails', { premises: 'owned', llpin: 'ABC-1234' })).rejects.toMatchObject({
    status: 409,
  });
  const writes = fixture.fetcher.mock.calls
    .map(([, request]) => JSON.parse(request.body))
    .filter((x) => x.query.includes('dealerEntityDetailsSave'));
  expect(writes).toHaveLength(1);
  expect(writes[0].variables).toEqual({
    draftId: draft.id,
    fields: { premises: 'owned', llpin: 'ABC-1234' },
  });
});

it('removes dealer PAN, contact details and invite tokens from application traces only on the exact route', () => {
  const body = { operation: 'lookup', fields: { pan: 'AAAFA1234A', email: 'private@example.test' } };
  expect(sanitizeOAuthRequest({ url: '/api/dealer-onboarding', body, rawBody: JSON.stringify(body) })).toMatchObject({
    body: '[REDACTED]',
    rawBody: '[REDACTED]',
  });
  expect(isApplicantOnboardingRequest('/api/dealer-onboarding-preview')).toBe(false);
});

it('attaches only projected evidence under the verified cookie and server-selected version', async () => {
  const fixture = setup();
  const pdf = Buffer.from('%PDF-1.4 synthetic statement');
  const bank = { code: 'bank_statement', label: 'Bank statements', mode: 'pdf', count: 0 };
  const request = { code: 'bank_statement', file: pdf };
  await expect(fixture.service.upload(config, async () => request, undefined)).rejects.toMatchObject({ status: 409 });
  await fixture.call('entry', {}, { referralToken });
  await fixture.call('requestOtp', { phone: '9999900001' });
  await fixture.call('verifyOtp', { otp: '123456' });
  await fixture.call('lookup', { pan: 'AAAFA1234A' });
  await fixture.call('start', details);
  await expect(fixture.service.upload(config, async () => request, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  fixture.setEvidence([{ ...bank, storageKey: 'private' }]);
  await expect(fixture.call('status')).resolves.toMatchObject({
    actions: [{ name: 'attachDocument', documents: [bank] }],
  });
  await expect(
    fixture.service.upload(config, async () => ({ ...request, version: 99 }), fixture.cookie())
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    fixture.service.upload(config, async () => ({ ...request, file: Buffer.from('junk') }), fixture.cookie())
  ).rejects.toMatchObject({ status: 400 });
  await expect(fixture.service.upload(config, async () => request, fixture.cookie())).resolves.toMatchObject({
    state: 'draft',
  });
  const [url, options] = fixture.fetcher.mock.calls.find(([, value]) => value.body instanceof FormData);
  expect(String(url)).toBe('https://gateway.example.test/v2/dealer/document');
  expect(options.headers.cookie).toMatch(/^authorization=header\..+; device=/);
  expect(options.headers['api-secret']).toBeUndefined();
  expect(JSON.parse(options.body.get('metadata'))).toEqual({
    code: bank.code,
    version: 3,
    draft_id: draft.id,
  });
  expect(await options.body.get('file').text()).toBe(pdf.toString());
});

it('shares a participant link only from the verified owner draft without browser parent or actor', async () => {
  const { call, fetcher } = setup();
  await call('entry', {}, { referralToken });
  await expect(call('inviteParticipant', { mobile: '9999900002' })).rejects.toMatchObject({ status: 409 });
  await call('requestOtp', { phone: '9999900001' });
  await call('verifyOtp', { otp: '123456' });
  await call('lookup', { pan: 'AAAFA1234A' });
  await call('start', details);
  await expect(call('inviteParticipant', { mobile: '9999900002', draftId: 'foreign' })).rejects.toMatchObject({
    status: 400,
  });
  await expect(call('inviteParticipant', { mobile: '9999900002' })).resolves.toEqual({
    state: 'participantInvite',
    invitationId: draft.id,
    referralToken,
  });
  const sent = fetcher.mock.calls
    .map(([, { body }]) => JSON.parse(body))
    .find(({ query }) => query.includes('dealerOwnerParticipant'));
  expect(sent.variables).toEqual({
    action: 'INVITE',
    draftId: draft.id,
    referralToken,
    fields: { mobile: '9999900002' },
  });
});

const ownerScope = {
  ...config!,
  kycOrigin: 'https://issuer.example.test',
};

async function ownerSession() {
  const owner = setup();
  await owner.call('entry', {}, { referralToken });
  await owner.call('requestOtp', { phone: '9999900001' });
  await owner.call('verifyOtp', { otp: '123456' });
  await owner.call('lookup', { pan: 'AAAFA1234A' });
  await owner.call('start', details);
  return owner;
}

const ownerKyc = (value: unknown) => Response.json({ data: { dealerOwnerKyc: value } });

it('authorizes the owner KYC route only with an explicitly pinned TLS origin and saved session', async () => {
  const { service } = setup();
  await expect(service.ownerKyc(config!, { action: 'STATUS' }, undefined)).rejects.toMatchObject({ status: 404 });
  await expect(service.ownerKyc(ownerScope, { action: 'STATUS' }, undefined)).rejects.toMatchObject({ status: 409 });
  const owner = await ownerSession();
  const calls = owner.fetcher.mock.calls.length;
  await expect(
    owner.service.ownerKyc(ownerScope, { action: 'START', personId: '99' }, owner.cookie())
  ).rejects.toMatchObject({ status: 400 });
  expect(owner.fetcher).toHaveBeenCalledTimes(calls);
});

it('pins the current case and stage version and keeps DigiLocker private from app query telemetry', async () => {
  const { service, cookie, fetcher } = await ownerSession();
  fetcher.mockResolvedValueOnce(ownerKyc({ status: 'pending', actions: ['START', 'SYNC'], version: 3 }));
  fetcher.mockResolvedValueOnce(
    ownerKyc({
      status: 'pending',
      redirectUrl: 'https://issuer.example.test/own',
      attempt: 'private',
    })
  );
  await expect(service.ownerKyc(ownerScope, { action: 'START' }, cookie())).resolves.toEqual({
    status: 'pending',
    redirectUrl: 'https://issuer.example.test/own',
  });
  const latest = JSON.parse(fetcher.mock.calls[fetcher.mock.calls.length - 1][1].body);
  expect(latest.variables).toEqual({ action: 'START', draftId: draft.id, referralToken, version: 3 });
  fetcher.mockResolvedValueOnce(ownerKyc({ status: 'pending', actions: ['START'], version: 3 }));
  fetcher.mockResolvedValueOnce(ownerKyc({ status: 'pending', redirectUrl: 'https://other.example.test/own' }));
  await expect(service.ownerKyc(ownerScope, { action: 'START' }, cookie())).rejects.toMatchObject({ status: 503 });
  for (const path of ['/api/dealer-onboarding/identity', '/api/dealer-onboarding/identity/selfie']) {
    expect(isApplicantOnboardingRequest(path)).toBe(true);
  }
});

it('bounds owner selfie transport and refuses even to parse it until the exact case permits it', async () => {
  const { service, cookie, fetcher } = await ownerSession();
  const file = Buffer.from([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]);
  const read = jest.fn(async () => file);
  fetcher.mockResolvedValueOnce(ownerKyc({ status: 'pending', actions: ['START', 'SYNC'], version: 3 }));
  await expect(service.uploadOwnerSelfie(ownerScope, read, cookie())).rejects.toMatchObject({ status: 409 });
  expect(read).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(ownerKyc({ status: 'verified', actions: ['SELFIE'], version: 3 }));
  fetcher.mockResolvedValueOnce(ownerKyc({ status: 'verified', private: 'discarded' }));
  await expect(service.uploadOwnerSelfie(ownerScope, read, cookie())).resolves.toEqual({ status: 'verified' });
  const latest = JSON.parse(fetcher.mock.calls[fetcher.mock.calls.length - 1][1].body);
  expect(latest.variables).toEqual({
    action: 'SELFIE',
    referralToken,
    draftId: draft.id,
    version: 3,
    selfie: 'data:image/jpeg;base64,/9j/AP/Z',
  });
});

import { createHash, createHmac } from 'node:crypto';
import { ApplicantSessions } from '../../../../src/modules/applicant-session/store';
import {
  parseVnAdmissionConfig,
  VN_ADMISSION_DOCUMENT_PATH,
  vnAdmissionHeaders,
} from '../../../../src/modules/dealer-onboarding/admission';
/** @group platform */
import { DealerOnboarding, parseDealerOnboardingConfig } from '../../../../src/modules/dealer-onboarding/relay';
import { parseDealerParticipantConfig } from '../../../../src/modules/dealer-onboarding/participant';
import {
  isApplicantOnboardingRequest,
  sanitizeOAuthRequest,
  sanitizeOAuthUrl,
  sanitizeTraceObject,
} from '../../../../src/otel/sanitize';

const config = parseDealerOnboardingConfig(
  JSON.stringify({
    origin: 'https://app.example.test',
    organizationId: '39',
    furyUrl: 'https://gateway.example.test/v2/graphql',
    lspSecret: 'synthetic-service-credential',
  })
);
const signedScope = {
  origin: 'https://app.example.test',
  organizationId: '39',
  namespace: 'signed-admission' as const,
  sessionKey: 'synthetic-signed-session-key',
};
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

it('admits a VN applicant after the broker verifies the same eligible guest and tenant', async () => {
  const fixture = setup();
  const vn = { ...config!, vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' } };
  const broker = {
    start: jest.fn().mockResolvedValue('https://auth.example.test/oidc/auth'),
    callback: jest.fn(),
  };
  await expect(
    fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie)
  ).resolves.toEqual({ authorizeUrl: 'https://auth.example.test/oidc/auth' });
  const guest = fixture.cookie()!;
  expect(broker.start).toHaveBeenCalledWith(guest, guest);
  const reply = { state: 'A'.repeat(43), code: 'code' };
  await expect(fixture.service.finishVn(vn, broker, reply, 'B'.repeat(43), fixture.setCookie)).rejects.toThrow();
  expect(broker.callback).not.toHaveBeenCalled();
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '55',
    email: 'dealer@example.test',
  });
  await expect(fixture.service.finishVn(vn, broker, reply, guest, fixture.setCookie)).rejects.toThrow();
  expect(fixture.cookie()).toBe(guest);
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await expect(fixture.service.finishVn(vn, broker, reply, guest, fixture.setCookie)).resolves.toBeUndefined();
  expect(fixture.cookie()).not.toBe(guest);
  await expect(fixture.service.statusVoltcred(vn, {}, fixture.cookie())).resolves.toEqual({ state: 'pan' });
  const foreign = {
    ...config!,
    voltcred: { actorOrganizationId: '39', destinyOrigin: 'http://destiny', brokerSecret: 'fake' },
  };
  await expect(fixture.service.statusVoltcred(foreign, {}, fixture.cookie())).resolves.toEqual({ state: 'invite' });
  await expect(fixture.service.lookupVoltcred(foreign, { pan: 'AAACA1234F' }, fixture.cookie())).rejects.toMatchObject({
    status: 401,
  });
  await expect(fixture.service.lookupVoltcred(vn, { pan: 'AAACA1234F' }, fixture.cookie())).resolves.toEqual({
    state: 'details',
    category: 'company',
  });
  await expect(
    fixture.service.openVoltcred(
      vn,
      { businessName: 'Synthetic Dealer', applicantName: 'Verified Owner' },
      fixture.cookie()
    )
  ).resolves.toEqual({ state: 'draft', draft: { id: draft.id, version: 1, stage: 'bank' } });
  const [url, request] = fixture.fetcher.mock.calls.at(-1)!;
  expect(url).toBe('http://destiny/v1/channel-partners/intakes');
  expect(request.headers).toMatchObject({ 'x-gct-org-id': '39', 'x-gct-user-id': '21' });
  expect(JSON.parse(request.body as string).input).toMatchObject({ referral_token: referralToken });
  const owner = { ...vn, ownerHmacKey: 'x'.repeat(32), kycOrigin: 'https://kyc.example.test' };
  const current = {
    draft_id: draft.id,
    organization_id: '39',
    version: 4,
    can_write: true,
    intake_stage: 'additional_documents',
  };
  const fields = {
    legal_name: 'Synthetic Dealer Ltd',
    registered_address: '12 Example Road',
    additional_address: '',
    signatory_name: 'Verified Owner',
    signatory_designation: 'Director',
    bank_account_holder: 'Synthetic Dealer Ltd',
    bank_name: 'Example Bank',
    bank_account_number: '123456789012',
    confirm_account_number: '123456789012',
    bank_ifsc: 'ABCD0123456',
    approved_outlets: 'One outlet',
  };
  fixture.fetcher.mockImplementationOnce(async () => Response.json(current));
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ version: 4, execution: 'registered_entity', execution_readiness: 'pending', private: 'hidden' })
  );
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ version: 5, execution: null, execution_readiness: 'saved', private: 'hidden' })
  );
  await expect(
    fixture.service.executionVn(owner, { action: 'SAVE_EXECUTION', fields }, fixture.cookie())
  ).resolves.toEqual({ execution: null, execution_readiness: 'saved' });
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body)).toEqual({
    input: { action: 'SAVE_EXECUTION', version: 4, fields, referral_token: referralToken },
  });
  for (const invalid of [
    { version: 4, execution: null },
    { version: 4, execution: null, execution_readiness: 'pending' },
    { version: 4, execution: 'registered_entity', execution_readiness: 'saved' },
  ]) {
    fixture.fetcher.mockImplementationOnce(async () => Response.json(current));
    fixture.fetcher.mockImplementationOnce(async () => Response.json(invalid));
    await expect(fixture.service.executionVn(owner, { action: 'STATUS' }, fixture.cookie())).rejects.toMatchObject({
      status: 503,
    });
  }
  await expect(fixture.service.reviewVoltcred(owner, { action: 'STATUS' }, fixture.cookie())).rejects.toMatchObject({
    status: 503,
  });
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ ...current, intake_stage: 'review' }));
  await expect(fixture.service.executionVn(owner, { action: 'STATUS' }, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    fixture.service.executionVn(
      owner,
      { action: 'SAVE_EXECUTION', fields: { ...fields, extra: 'invalid' } },
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 400 });
});

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
      if (args[0].includes('CONTINUATION_ARM')) {
        if (keys.get(args[2]) !== args[4] || keys.has(args[3])) return 0;
        keys.set(args[2], 'armed');
        keys.set(args[3], args[5]);
        return 1;
      }
      if (args[0].includes('CONTINUATION_CONSUME')) {
        const receipt = keys.get(args[2]);
        if (!receipt || JSON.parse(receipt).guest !== args[3]) return null;
        keys.delete(args[2]);
        return receipt;
      }
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
    if (new URL(_url).pathname === '/v1/channel-partners/referrals/eligibility')
      return Response.json({ organization_id: '39', eligible: true });
    if (request.body instanceof FormData) return Response.json({ attached: true });
    if (new URL(_url).pathname === `/v1/channel-partners/intakes/${draft.id}`)
      return Response.json({
        draft_id: draft.id,
        organization_id: '39',
        version: 1,
        can_write: true,
        intake_stage: 'bank',
      });
    if (new URL(_url).pathname === '/v1/channel-partners/financial-data')
      return Response.json({
        id: 'e88edd28-b86e-4ca8-ad22-2625ccdf90af',
        integration: 'saafe',
        status: 'pending',
        gateway_url: 'https://consent.example.test/start',
      });
    if (new URL(_url).pathname.startsWith('/v1/channel-partners/financial-data/'))
      return Response.json({ id: 'e88edd28-b86e-4ca8-ad22-2625ccdf90af', integration: 'saafe', status: 'pending' });
    if (new URL(_url).pathname === '/v1/channel-partners/intakes/lookup') {
      return Response.json({ status: 'new', entity: 'company' });
    }
    if (new URL(_url).pathname === '/v1/channel-partners/intakes') {
      return Response.json({
        draft_id: draft.id,
        version: 1,
        organization_id: 39,
        intake_stage: 'bank',
        dossier: 'private',
      });
    }
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
    if (query.includes('dealerGstAa')) {
      const requestId = 'e88edd28-b86e-4ca8-ad22-2625ccdf90af';
      const choice = { key: 'a'.repeat(64), maskedGstin: '07XXXXXXXXXX1Z1', transactions: ['private'] };
      const result = {
        START: { status: 'pending', requestId, consentUrl: 'https://consent.example.test/start', accounts: [] },
        CHECK: { status: 'completed', requestId, accounts: [choice] },
        ATTACH: { status: 'attached', accounts: [] },
      }[variables.action];
      return Response.json({ data: { dealerGstAa: result } });
    }
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
    setCookie: capture,
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

it('finishes VoltCred email verification only in the originating guest and scopes PAN lookup to the referral tenant', async () => {
  const fixture = setup();
  const voltcred = {
    actorOrganizationId: '55',
    brokerSecret: 'synthetic-broker-secret-for-dealer-tests',
    destinyOrigin: 'http://destiny.lending.svc.cluster.local',
  };
  const scope = { ...config!, voltcred };
  const pan = 'AAACA1234A';
  const guest = await fixture.service.startVoltcred(
    scope,
    { referral_token: referralToken },
    undefined,
    fixture.setCookie
  );
  const guestId = fixture.cookie();
  const state = new URL(guest.authorizeUrl).searchParams.get('state')!;
  await expect(fixture.service.statusVoltcred(scope, {}, guestId)).resolves.toEqual({ state: 'invite' });
  await expect(fixture.service.lookupVoltcred(scope, { pan }, guestId)).rejects.toMatchObject({ status: 401 });
  await expect(fixture.call('requestOtp', { phone: '9999900001' })).rejects.toMatchObject({ status: 409 });
  const device = 'fixture-device';
  const payload = {
    user_id: '21',
    org_id: '55',
    app: 'voltcred',
    email: 'dealer@example.test',
    device,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const token = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  const { code } = await fixture.service.receiveVoltcred(scope, { state, token, device, user_id: '21' });
  await expect(fixture.service.finishVoltcred(scope, { code }, 'A'.repeat(43), fixture.setCookie)).rejects.toThrow();
  await expect(fixture.service.finishVoltcred(scope, { code }, guestId, fixture.setCookie)).resolves.toEqual({
    state: 'pan',
  });
  expect(fixture.cookie()).not.toBe(guestId);
  expect(fixture.persisted()).not.toContain(token);
  await expect(fixture.service.finishVoltcred(scope, { code }, guestId, fixture.setCookie)).rejects.toThrow();
  await expect(fixture.service.statusVoltcred(scope, {}, fixture.cookie())).resolves.toEqual({ state: 'pan' });
  await expect(
    fixture.service.lookupVoltcred(scope, { pan, organization_id: '55' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 400 });
  await expect(fixture.service.lookupVoltcred(scope, { pan }, fixture.cookie())).resolves.toEqual({
    state: 'details',
    category: 'company',
  });
  expect(fixture.fetcher).toHaveBeenLastCalledWith(
    `${voltcred.destinyOrigin}/v1/channel-partners/intakes/lookup`,
    expect.objectContaining({
      headers: { 'Content-Type': 'application/json', 'x-gct-org-id': '39', 'x-gct-user-id': '21' },
      body: JSON.stringify({ input: { pan, referral_token: referralToken } }),
    })
  );
  await expect(
    fixture.service.openVoltcred(
      scope,
      { businessName: 'Synthetic Dealer', applicantName: 'Verified Owner', email: 'other@example.test' },
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 400 });
  const fields = { businessName: 'Synthetic Dealer', applicantName: 'Verified Owner' };
  await expect(fixture.service.openVoltcred(scope, fields, fixture.cookie())).resolves.toEqual({
    state: 'draft',
    draft: { id: draft.id, version: 1, stage: 'bank' },
  });
  expect(fixture.fetcher).toHaveBeenLastCalledWith(
    `${voltcred.destinyOrigin}/v1/channel-partners/intakes`,
    expect.objectContaining({
      body: JSON.stringify({
        input: {
          referral_token: referralToken,
          dossier: {
            details: { pan, partner_name: 'Synthetic Dealer', email: 'dealer@example.test' },
            people: [
              {
                id: 'person1',
                user_id: '21',
                name: 'Verified Owner',
                role: 'Director',
                kyc_contact: 'dealer@example.test',
              },
            ],
          },
        },
      }),
    })
  );
  const reviewDraft = {
    draft_id: draft.id,
    organization_id: '39',
    version: 4,
    can_write: true,
    intake_stage: 'additional_documents',
  };
  fixture.fetcher.mockImplementationOnce(async () => Response.json(reviewDraft));
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ stage: 'evidence_ready', version: 4, actions: ['PREPARE'] })
  );
  await expect(fixture.service.reviewVoltcred(scope, { action: 'STATUS' }, fixture.cookie())).resolves.toEqual({
    stage: 'evidence_ready',
    action: 'PREPARE',
  });
  expect(JSON.parse(fixture.fetcher.mock.calls.slice(-1)[0][1].body)).toEqual({
    input: { action: 'STATUS', referral_token: referralToken },
  });
  fixture.fetcher.mockImplementationOnce(async () => Response.json(reviewDraft));
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ stage: 'evidence_ready', version: 4, actions: ['PREPARE'] })
  );
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ stage: 'ready_to_submit', version: 5, actions: ['SUBMIT'] })
  );
  await expect(fixture.service.reviewVoltcred(scope, { action: 'PREPARE' }, fixture.cookie())).resolves.toEqual({
    stage: 'ready_to_submit',
    action: 'SUBMIT',
  });
  expect(JSON.parse(fixture.fetcher.mock.calls.slice(-1)[0][1].body)).toEqual({
    input: { action: 'PREPARE', referral_token: referralToken, version: 4 },
  });
  fixture.fetcher.mockImplementationOnce(async () => Response.json(reviewDraft));
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ stage: 'ready_to_submit', version: 4, actions: ['SUBMIT'] })
  );
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ stage: 'submitted', version: 5, actions: [] }));
  await expect(fixture.service.reviewVoltcred(scope, { action: 'SUBMIT' }, fixture.cookie())).resolves.toEqual({
    stage: 'submitted',
    action: null,
  });
  expect(JSON.parse(fixture.fetcher.mock.calls.slice(-1)[0][1].body)).toEqual({
    input: { action: 'SUBMIT', referral_token: referralToken, version: 4 },
  });
  fixture.fetcher.mockImplementationOnce(async () => Response.json(reviewDraft));
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ stage: 'evidence_ready', version: 5, actions: ['PREPARE'] })
  );
  await expect(fixture.service.reviewVoltcred(scope, { action: 'PREPARE' }, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  fixture.fetcher.mockImplementationOnce(async () => Response.json(reviewDraft));
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ stage: 'evidence_ready', version: 4, actions: ['PREPARE'] })
  );
  fixture.fetcher.mockImplementationOnce(async () => Response.json({}, { status: 409 }));
  await expect(fixture.service.reviewVoltcred(scope, { action: 'PREPARE' }, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ ...reviewDraft, intake_stage: 'people' }));
  await expect(fixture.service.reviewVoltcred(scope, { action: 'SUBMIT' }, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  await expect(fixture.service.reviewVoltcred(scope, { action: 'FREEZE' }, fixture.cookie())).rejects.toMatchObject({
    status: 400,
  });
  const agreementDraft = { ...reviewDraft, intake_stage: 'agreement', agreement: { status: 'prepared' } };
  fixture.fetcher.mockImplementationOnce(async () => Response.json(agreementDraft));
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ stage: 'signing_pending', version: 4, actions: ['REFRESH'] })
  );
  await expect(
    fixture.service.agreementVoltcred(
      { ...scope, ownerHmacKey: 'x'.repeat(32), kycOrigin: signing.kycOrigin, signingOrigin: signing.signingOrigin },
      { action: 'STATUS' },
      fixture.cookie()
    )
  ).resolves.toEqual({ stage: 'signing_pending', action: 'REFRESH', canSign: true, signed: false });
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ ...agreementDraft, intake_stage: 'review' }));
  await expect(
    fixture.service.agreementVoltcred(
      { ...scope, ownerHmacKey: 'x'.repeat(32), kycOrigin: signing.kycOrigin, signingOrigin: signing.signingOrigin },
      { action: 'SIGN' },
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 409 });
  fixture.fetcher.mockImplementationOnce(async () => Response.json(agreementDraft));
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ stage: 'signing_pending', version: 4, actions: ['REFRESH'] })
  );
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ status: 'requested', url: signingUrl }));
  await expect(
    fixture.service.agreementVoltcred(
      { ...scope, ownerHmacKey: 'x'.repeat(32), kycOrigin: signing.kycOrigin, signingOrigin: signing.signingOrigin },
      { action: 'SIGN' },
      fixture.cookie()
    )
  ).resolves.toEqual({ status: 'requested', url: signingUrl });
  expect(JSON.parse(fixture.fetcher.mock.calls.slice(-1)[0][1].body)).toEqual({
    input: { version: 4, referral_token: referralToken },
  });
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ ...agreementDraft, agreement: { status: 'expired' } })
  );
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ stage: 'signing_pending', version: 4, actions: ['REFRESH'] })
  );
  await expect(
    fixture.service.agreementVoltcred(
      { ...scope, ownerHmacKey: 'x'.repeat(32), kycOrigin: signing.kycOrigin, signingOrigin: signing.signingOrigin },
      { action: 'SIGN' },
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 409 });
  const peopleDraft = {
    draft_id: draft.id,
    organization_id: '39',
    version: 1,
    can_write: true,
    intake_stage: 'people',
    dossier: {
      details: { firm_type: 'llp' },
      people: [
        {
          id: 'person1',
          user_id: '21',
          name: 'Verified Owner',
          role: 'Director',
          din: '12345678',
          kyc_contact: 'private@example.test',
        },
        { id: '25', user_id: '22', name: 'Other Person', role: 'Director', din: '87654321' },
        { id: 'person_invited', name: '' },
      ],
      kyc: {
        person1: { status: 'verified', selfie_verified: true },
        '25': { status: 'pending', selfie_verified: false },
        person_invited: { status: 'not_started' },
      },
    },
  };
  fixture.fetcher.mockImplementationOnce(async () => Response.json(peopleDraft));
  await expect(fixture.service.peopleStatusVoltcred(scope, {}, fixture.cookie())).resolves.toEqual({
    people: [
      { name: 'Verified Owner', role: 'Director', needs_din: true, kyc_complete: true, selfie_complete: true },
      { name: 'Other Person', role: 'Director', needs_din: true, kyc_complete: false, selfie_complete: false },
      { name: 'Pending invitation', role: 'Participant', needs_din: true, kyc_complete: false, selfie_complete: false },
    ],
  });
  await expect(
    fixture.service.peopleStatusVoltcred(scope, { draft_id: draft.id }, fixture.cookie())
  ).rejects.toMatchObject({ status: 400 });
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ ...peopleDraft, can_write: false }));
  await expect(fixture.service.peopleStatusVoltcred(scope, {}, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ ...peopleDraft, intake_stage: 'bank' }));
  await expect(fixture.service.peopleStatusVoltcred(scope, {}, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ ...peopleDraft, dossier: { ...peopleDraft.dossier, people: [{ id: 'person1', name: null }] } })
  );
  await expect(fixture.service.peopleStatusVoltcred(scope, {}, fixture.cookie())).rejects.toMatchObject({
    status: 503,
  });
  const ownerScope = {
    ...scope,
    ownerHmacKey: 'synthetic-owner-email-signing-secret-123',
    kycOrigin: 'https://kyc.example.test',
  };
  const ownerStatus = { person_id: 'person1', status: 'not_started', actions: ['START'], version: 1 };
  fixture.fetcher.mockImplementationOnce(async () => Response.json(peopleDraft));
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ version: 1, own_din: 'DIN', history: 'private' }));
  fixture.fetcher.mockImplementationOnce(async () => Response.json(ownerStatus));
  await expect(
    fixture.service.publicOwnerVoltcred(ownerScope, { action: 'STATUS' }, fixture.cookie())
  ).resolves.toEqual({ status: 'not_started', actions: ['START', 'SAVE_DIN'], needsDin: true });
  const signed = fixture.fetcher.mock.calls.slice(-1)[0];
  expect(signed[1].headers['x-gct-owner-email']).toBe('dealer@example.test');
  const signedPath = `/v1/channel-partners/intakes/${draft.id}/email-owner/kyc/status`;
  const issuedAt = signed[1].headers['x-gct-owner-issued-at'];
  expect(signed[1].headers['x-gct-owner-signature']).toBe(
    createHmac('sha256', ownerScope.ownerHmacKey)
      .update(
        JSON.stringify([
          'destiny-owner-email-v1',
          'POST',
          signedPath,
          '39',
          '21',
          draft.id,
          'dealer@example.test',
          issuedAt,
        ])
      )
      .digest('hex')
  );
  expect(signed[1].body).toBe(JSON.stringify({ input: { referral_token: referralToken } }));
  await expect(
    fixture.service.publicOwnerVoltcred(ownerScope, { action: 'START', person_id: '25' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 400 });
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ ...peopleDraft, can_write: false }));
  await expect(
    fixture.service.publicOwnerVoltcred(ownerScope, { action: 'STATUS' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 409 });
  fixture.fetcher.mockImplementationOnce(async () => Response.json(peopleDraft));
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ version: 2, own_din: null }));
  fixture.fetcher.mockImplementationOnce(async () => Response.json(ownerStatus));
  await expect(
    fixture.service.publicOwnerVoltcred(ownerScope, { action: 'START' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 409 });
  fixture.fetcher.mockImplementationOnce(async () => Response.json(peopleDraft));
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ version: 1, own_din: null }));
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ ...ownerStatus, status: 'verified', actions: ['SELFIE'] })
  );
  fixture.fetcher.mockImplementationOnce(async () => Response.json({ selfie_verified: true }));
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ ...peopleDraft, version: 2, intake_stage: 'premises_photo' })
  );
  await expect(
    fixture.service.publicOwnerSelfieVoltcred(
      ownerScope,
      async () => Buffer.from('/9j/AP/Z', 'base64'),
      fixture.cookie()
    )
  ).resolves.toEqual({ status: 'verified', actions: [], needsDin: false });
  expect(fixture.fetcher).toHaveBeenCalledWith(
    `${voltcred.destinyOrigin}/v1/channel-partners/intakes/${draft.id}/email-owner/people/person1/kyc/selfie`,
    expect.objectContaining({
      body: JSON.stringify({
        input: { version: 1, selfie: 'data:image/jpeg;base64,/9j/AP/Z', referral_token: referralToken },
      }),
    })
  );
  const evidenceDraft = {
    draft_id: draft.id,
    organization_id: '39',
    version: 2,
    can_write: true,
    intake_stage: 'additional_documents',
    requested_document_codes: ['utility_bill'],
    document_actions: [
      { code: 'utility_bill', label: 'Latest electricity bill', mode: 'upload', count: 0, private: 'secret' },
    ],
    dossier: { documents: { utility_bill: [{ file_id: 'secret' }] } },
  };
  fixture.fetcher.mockImplementationOnce(async () => Response.json(evidenceDraft));
  await expect(fixture.service.evidenceStatusVoltcred(scope, {}, fixture.cookie())).resolves.toEqual({
    stage: 'additional_documents',
    requested_document_codes: ['utility_bill'],
    document_actions: [{ code: 'utility_bill', label: 'Latest electricity bill', mode: 'upload', count: 0 }],
  });
  await expect(
    fixture.service.evidenceStatusVoltcred(scope, { draft_id: draft.id }, fixture.cookie())
  ).rejects.toMatchObject({ status: 400 });
  for (const invalid of [
    { ...evidenceDraft, can_write: false },
    { ...evidenceDraft, intake_stage: 'people' },
  ]) {
    fixture.fetcher.mockImplementationOnce(async () => Response.json(invalid));
    await expect(fixture.service.evidenceStatusVoltcred(scope, {}, fixture.cookie())).rejects.toMatchObject({
      status: 409,
    });
  }
  for (const invalid of [
    { ...evidenceDraft, requested_document_codes: ['private'] },
    { ...evidenceDraft, document_actions: [{ code: 'utility_bill', label: 'private', mode: 'upload', count: 0 }] },
    {
      ...evidenceDraft,
      document_actions: [
        { code: 'business_premises_photo', label: 'Geotagged business premises photo', mode: 'camera', count: 0 },
      ],
    },
    {
      ...evidenceDraft,
      document_actions: [{ code: 'utility_bill', label: 'Latest electricity bill', mode: 'upload', count: -1 }],
    },
  ]) {
    fixture.fetcher.mockImplementationOnce(async () => Response.json(invalid));
    await expect(fixture.service.evidenceStatusVoltcred(scope, {}, fixture.cookie())).rejects.toMatchObject({
      status: 503,
    });
  }
  for (const [stage, code, label, mode] of [
    ['premises_photo', 'business_premises_photo', 'Geotagged business premises photo', 'camera'],
    ['electricity_bill', 'utility_bill', 'Latest electricity bill', 'upload'],
    ['additional_documents', 'additional_documents', 'Additional documents', 'upload'],
  ]) {
    fixture.fetcher.mockImplementationOnce(async () =>
      Response.json({
        ...evidenceDraft,
        intake_stage: stage,
        requested_document_codes: undefined,
        document_actions: [{ code, label, mode, count: 1 }],
      })
    );
    await expect(fixture.service.evidenceStatusVoltcred(scope, {}, fixture.cookie())).resolves.toEqual({
      stage,
      requested_document_codes: [],
      document_actions: [{ code, label, mode, count: 1 }],
    });
  }
  const bankScope = { ...scope, bankConsentOrigin: 'https://consent.example.test' };
  const baseFetch = fixture.fetcher.getMockImplementation()!;
  let lost = true;
  fixture.fetcher.mockImplementation(async (url, request) => {
    if (new URL(url).pathname === '/v1/channel-partners/financial-data' && lost) {
      lost = false;
      throw new Error('lost response');
    }
    return baseFetch(url, request);
  });
  await expect(
    fixture.service.startFinancialVoltcred('bank', bankScope, { mobile: '9999900001' }, fixture.cookie())
  ).rejects.toThrow();
  const lostBody = fixture.fetcher.mock.calls.at(-1)![1].body;
  const start = await fixture.service.startFinancialVoltcred(
    'bank',
    bankScope,
    { mobile: '9999900001' },
    fixture.cookie()
  );
  expect(fixture.fetcher.mock.calls.at(-1)![1].body).toBe(lostBody);
  expect(start).toEqual({ status: 'pending', consentUrl: 'https://consent.example.test/start' });
  const first = fixture.fetcher.mock.calls.at(-1)![1].body;
  await fixture.service.startFinancialVoltcred('bank', bankScope, { mobile: '9999900001' }, fixture.cookie());
  expect(fixture.fetcher.mock.calls.at(-1)![1].body).toBe(first);
  await expect(
    fixture.service.startFinancialVoltcred('bank', bankScope, { mobile: '9999900002' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 409 });
  await expect(fixture.service.statusFinancialVoltcred('bank', bankScope, {}, fixture.cookie())).resolves.toEqual({
    status: 'pending',
  });
  expect(fixture.fetcher.mock.calls.at(-1)![0]).toContain(`?draft_id=${draft.id}&purpose=bank`);
  await expect(
    fixture.service.startFinancialVoltcred(
      'bank',
      bankScope,
      { mobile: '9999900001', draft_id: draft.id },
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 400 });
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ draft_id: draft.id, organization_id: '39', version: 1, can_write: false, intake_stage: 'bank' })
  );
  await expect(fixture.service.statusFinancialVoltcred('bank', bankScope, {}, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ draft_id: draft.id, organization_id: '39', version: 1, can_write: true, intake_stage: 'gst' })
  );
  await expect(fixture.service.statusFinancialVoltcred('bank', bankScope, {}, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ draft_id: draft.id, organization_id: '39', version: 1, can_write: true, intake_stage: 'bank' })
  );
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({
      id: 'e88edd28-b86e-4ca8-ad22-2625ccdf90af',
      integration: 'saafe',
      status: 'pending',
      gateway_url: 'https://evil.example.test/',
    })
  );
  await expect(fixture.service.statusFinancialVoltcred('bank', bankScope, {}, fixture.cookie())).rejects.toMatchObject({
    status: 503,
  });

  let bankAttached = false;
  const currentDraft = { draft_id: draft.id, organization_id: 39, version: 2, intake_stage: 'gst', can_write: true };
  fixture.fetcher.mockImplementation(async (url, request) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/sync'))
      return Response.json({ id: 'e88edd28-b86e-4ca8-ad22-2625ccdf90af', integration: 'saafe', status: 'completed' });
    if (path.endsWith('/bank-options'))
      return Response.json({
        accounts: [{ linked_account_ref: 'private-ref', masked_account_number: 'XXXX1234', raw: 'private' }],
      });
    if (path.endsWith('/intakes/' + draft.id + '/financial-data')) {
      bankAttached = true;
      throw new Error('bank attachment response lost');
    }
    if (bankAttached && path.endsWith('/intakes/' + draft.id)) return Response.json(currentDraft);
    return baseFetch(url, request);
  });
  await expect(fixture.service.syncFinancialVoltcred('bank', bankScope, {}, fixture.cookie())).resolves.toEqual({
    status: 'completed',
  });
  const options = await fixture.service.optionsFinancialVoltcred('bank', bankScope, {}, fixture.cookie());
  expect(options.accounts).toHaveLength(1);
  expect(options.accounts[0]).toMatchObject({ maskedAccountNumber: 'XXXX1234' });
  expect(JSON.stringify(options)).not.toContain('private');
  await expect(
    fixture.service.attachFinancialVoltcred('bank', bankScope, { key: 'forged' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    fixture.service.attachFinancialVoltcred('bank', bankScope, { key: options.accounts[0].key }, fixture.cookie())
  ).rejects.toThrow('bank attachment response lost');
  const attach = fixture.fetcher.mock.calls.at(-1)!;
  expect(JSON.parse(attach[1].body)).toEqual({
    input: {
      version: 1,
      purpose: 'bank',
      request_id: 'e88edd28-b86e-4ca8-ad22-2625ccdf90af',
      linked_account_ref: 'private-ref',
    },
  });
  await expect(fixture.service.statusVoltcred(scope, {}, fixture.cookie())).resolves.toEqual({
    state: 'resume',
    draft: { id: draft.id, version: 2, stage: 'gst' },
  });
  expect(fixture.fetcher).toHaveBeenLastCalledWith(
    `${voltcred.destinyOrigin}/v1/channel-partners/intakes/${draft.id}`,
    expect.objectContaining({ method: 'GET', headers: { 'x-gct-org-id': '39', 'x-gct-user-id': '21' } })
  );
  const gstDraft = { draft_id: draft.id, organization_id: '39', version: 2, intake_stage: 'gst', can_write: true };
  let lostGst = true;
  fixture.fetcher.mockImplementation(async (url, request) => {
    const path = new URL(url).pathname;
    if (path === '/v1/channel-partners/intakes/' + draft.id) return Response.json(gstDraft);
    if (path === '/v1/channel-partners/financial-data' && lostGst) {
      lostGst = false;
      throw new Error('lost');
    }
    if (path === '/v1/channel-partners/financial-data')
      return Response.json({
        id: 'e88edd28-b86e-4ca8-ad22-2625ccdf90af',
        integration: 'saafe',
        status: 'pending',
        gateway_url: 'https://consent.example.test/start',
      });
    if (path.endsWith('/sync'))
      return Response.json({ id: 'e88edd28-b86e-4ca8-ad22-2625ccdf90af', integration: 'saafe', status: 'completed' });
    if (path.endsWith('/gst-options'))
      return Response.json({
        gst_accounts: [{ linked_account_ref: 'private-gst-ref', masked_gstin: '07XXXXXXXXXX1Z1', raw: 'private' }],
      });
    if (path.endsWith('/intakes/' + draft.id + '/financial-data'))
      return Response.json({ ...gstDraft, version: 3, intake_stage: 'additional_documents' });
    return baseFetch(url, request);
  });
  await expect(
    fixture.service.startFinancialVoltcred('gst', bankScope, { mobile: '9999900002' }, fixture.cookie())
  ).rejects.toThrow();
  const gstLostBody = fixture.fetcher.mock.calls.at(-1)![1].body;
  await expect(
    fixture.service.startFinancialVoltcred('gst', bankScope, { mobile: '9999900002' }, fixture.cookie())
  ).resolves.toEqual({ status: 'pending', consentUrl: 'https://consent.example.test/start' });
  expect(fixture.fetcher.mock.calls.at(-1)![1].body).toBe(gstLostBody);
  expect(JSON.parse(gstLostBody).input).toMatchObject({
    purpose: 'gst',
    request_id: `public-dealer-gst:${draft.id}`,
    mobile: '9999900002',
    draft_id: draft.id,
    version: 2,
  });
  await expect(
    fixture.service.startFinancialVoltcred('gst', bankScope, { mobile: '9999900003' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 409 });
  await expect(fixture.service.syncFinancialVoltcred('gst', bankScope, {}, fixture.cookie())).resolves.toEqual({
    status: 'completed',
  });
  const gstOptions = await fixture.service.optionsFinancialVoltcred('gst', bankScope, {}, fixture.cookie());
  expect(gstOptions.accounts).toEqual([{ key: expect.any(String), maskedGstin: '07XXXXXXXXXX1Z1' }]);
  expect(JSON.stringify(gstOptions)).not.toContain('private');
  await expect(
    fixture.service.attachFinancialVoltcred('gst', bankScope, { key: options.accounts[0].key }, fixture.cookie())
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    fixture.service.attachFinancialVoltcred('gst', bankScope, { key: gstOptions.accounts[0].key }, fixture.cookie())
  ).resolves.toEqual({ draft: { id: draft.id, version: 3, stage: 'additional_documents' } });
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body).input).toEqual({
    version: 2,
    purpose: 'gst',
    request_id: 'e88edd28-b86e-4ca8-ad22-2625ccdf90af',
    linked_account_ref: 'private-gst-ref',
  });
  expect(fixture.persisted()).not.toContain('9999900001');
});

it('uploads only the offered evidence for the verified VoltCred draft and resumes from the native receipt', async () => {
  const fixture = setup();
  const voltcred = {
    actorOrganizationId: '55',
    brokerSecret: 'synthetic-broker-secret-for-dealer-tests',
    destinyOrigin: 'http://destiny.lending.svc.cluster.local',
  };
  const scope = { ...config!, voltcred };
  const guest = await fixture.service.startVoltcred(
    scope,
    { referral_token: referralToken },
    undefined,
    fixture.setCookie
  );
  const guestId = fixture.cookie();
  const state = new URL(guest.authorizeUrl).searchParams.get('state')!;
  const device = 'fixture-device';
  const claims = {
    user_id: '21',
    org_id: '55',
    app: 'voltcred',
    email: 'dealer@example.test',
    device,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const { code } = await fixture.service.receiveVoltcred(scope, { state, token, device, user_id: '21' });
  await fixture.service.finishVoltcred(scope, { code }, guestId, fixture.setCookie);
  await fixture.service.lookupVoltcred(scope, { pan: 'AAACA1234A' }, fixture.cookie());
  await fixture.service.openVoltcred(
    scope,
    { businessName: 'Synthetic Dealer', applicantName: 'Verified Owner' },
    fixture.cookie()
  );

  let attachment: { url: string; body: FormData; headers: unknown } | undefined;
  fixture.fetcher.mockImplementation(async (url, request) => {
    if (url.endsWith('/documents/business_premises_photo')) {
      attachment = { url, body: request.body, headers: request.headers };
      return Response.json({ file_id: 42, version: 4 });
    }
    return Response.json({
      draft_id: draft.id,
      organization_id: 39,
      version: attachment ? 4 : 3,
      can_write: true,
      intake_stage: attachment ? 'electricity_bill' : 'premises_photo',
      max_document_bytes: 10485760,
      document_actions: [
        { code: 'business_premises_photo', label: 'Geotagged business premises photo', mode: 'camera', count: 0 },
      ],
    });
  });
  const location = { latitude: 19, longitude: 73, accuracy: 10, captured_at: new Date().toISOString() };
  const form = { code: 'business_premises_photo', file: Buffer.from([255, 216, 255, 224]), location };
  const unread = jest.fn();
  await expect(fixture.service.uploadVoltcredEvidence(scope, unread, undefined)).rejects.toMatchObject({ status: 401 });
  expect(unread).not.toHaveBeenCalled();
  const upload = (body: unknown) => fixture.service.uploadVoltcredEvidence(scope, async () => body, fixture.cookie());
  await expect(upload({ ...form, draftId: draft.id })).rejects.toMatchObject({ status: 400 });
  await expect(upload({ ...form, code: 'utility_bill' })).rejects.toMatchObject({ status: 409 });
  await expect(
    upload({ ...form, location: { ...location, captured_at: '2020-01-01T00:00:00Z' } })
  ).rejects.toMatchObject({ status: 400 });
  await expect(upload({ ...form, file: Buffer.from('%PDF-') })).rejects.toMatchObject({ status: 400 });
  expect(attachment).toBeUndefined();
  await expect(upload(form)).resolves.toEqual({
    state: 'resume',
    draft: { id: draft.id, version: 4, stage: 'electricity_bill' },
  });
  expect(attachment?.url).toBe(
    `${voltcred.destinyOrigin}/v1/channel-partners/intakes/${draft.id}/documents/business_premises_photo`
  );
  expect(attachment?.headers).toEqual({ 'x-gct-org-id': '39', 'x-gct-user-id': '21' });
  expect(JSON.parse(String(attachment?.body.get('metadata')))).toEqual({ version: 3, location });
  expect(attachment?.body.get('file')).toBeInstanceOf(Blob);
  expect(fixture.persisted()).not.toContain(location.captured_at);
});

it('keeps broker credentials and issued session proof out of request telemetry', () => {
  const url = '/api/dealer-onboarding/voltcred/receive';
  expect(
    sanitizeOAuthRequest({
      id: 1,
      method: 'POST',
      url,
      headers: { authorization: 'synthetic-broker-secret' },
      body: { token: 'synthetic-actor-token' },
      rawBody: 'synthetic-raw-body',
    })
  ).toEqual({ id: 1, method: 'POST', url });
});

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

it('uses the existing applicant session and exact owned case for GST AA consent and attachment', async () => {
  const { call, fetcher, persisted } = setup();
  const choice = { key: 'a'.repeat(64), maskedGstin: '07XXXXXXXXXX1Z1' };
  await expect(call('gstStart')).rejects.toMatchObject({ status: 409 });
  await call('entry', {}, { referralToken });
  await call('requestOtp', { phone: '9999900001' });
  await call('verifyOtp', { otp: '123456' });
  await expect(call('gstStart')).rejects.toMatchObject({ status: 409 });
  await call('lookup', { pan: 'AAAFA1234A' });
  await call('start', details);
  await expect(call('gstStart', { draftId: 'foreign' })).rejects.toMatchObject({ status: 400 });
  await expect(call('gstStart')).resolves.toEqual({
    state: 'gstAa',
    status: 'pending',
    consentUrl: 'https://consent.example.test/start',
    accounts: [],
  });
  await expect(call('gstStatus')).resolves.toEqual({ state: 'gstAa', status: 'completed', accounts: [choice] });
  await expect(call('gstAttach', { account: choice.key })).resolves.toEqual({
    state: 'gstAa',
    status: 'attached',
    accounts: [],
  });
  const calls = fetcher.mock.calls
    .map(([, req]) => JSON.parse(req.body))
    .filter(({ query }) => query.includes('dealerGstAa'));
  expect(calls.map(({ variables }) => variables)).toEqual([
    { draftId: draft.id, action: 'START' },
    { draftId: draft.id, action: 'CHECK', requestId: 'e88edd28-b86e-4ca8-ad22-2625ccdf90af' },
    { draftId: draft.id, action: 'ATTACH', requestId: 'e88edd28-b86e-4ca8-ad22-2625ccdf90af', account: choice.key },
  ]);
  expect(persisted()).not.toMatch(/consent.example.test|07XXXXXXXXXX1Z1|private/);
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

it('logs only the request method and path for the VN dealer callback', () => {
  const path = '/api/dealer-onboarding/vn/callback';
  expect(
    sanitizeOAuthRequest({
      id: 'request',
      method: 'GET',
      url: path + '?code=secret&state=secret',
      headers: { cookie: 'secret' },
      query: { code: 'secret', state: 'secret' },
    })
  ).toEqual({ id: 'request', method: 'GET', url: path });
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

it('uses the verified owner identity action for the saved draft and returns one configured signing URL', async () => {
  const { service, cookie, fetcher } = await ownerSession();
  const scope = { ...ownerScope, signingOrigin: signing.signingOrigin };
  const status = { status: 'verified', actions: ['SIGN'], version: 3 };
  fetcher.mockResolvedValueOnce(ownerKyc(status));
  await expect(service.ownerKyc(ownerScope, { action: 'STATUS' }, cookie())).resolves.toEqual({
    status: 'verified',
    actions: [],
  });
  fetcher.mockResolvedValueOnce(ownerKyc(status));
  await expect(service.ownerKyc(scope, { action: 'STATUS' }, cookie())).resolves.toEqual({
    status: 'verified',
    actions: ['SIGN'],
  });
  await expect(service.ownerKyc(scope, { action: 'SIGN', version: 3 }, cookie())).rejects.toMatchObject({
    status: 400,
  });
  fetcher.mockResolvedValueOnce(ownerKyc(status));
  fetcher.mockResolvedValueOnce(ownerKyc({ status: 'requested', redirectUrl: signingUrl, links: ['private'] }));
  await expect(service.ownerKyc(scope, { action: 'SIGN' }, cookie())).resolves.toEqual({
    status: 'requested',
    redirectUrl: signingUrl,
  });
  const latest = JSON.parse(fetcher.mock.calls[fetcher.mock.calls.length - 1][1].body);
  expect(latest.variables).toEqual({ action: 'SIGN', referralToken, draftId: draft.id, version: 3 });
  fetcher.mockResolvedValueOnce(ownerKyc(status));
  fetcher.mockResolvedValueOnce(ownerKyc({ status: 'requested', redirectUrl: 'https://other.example.test/' }));
  await expect(service.ownerKyc(scope, { action: 'SIGN' }, cookie())).rejects.toMatchObject({ status: 503 });
});

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

it('derives separate Redis session keys for signed and legacy scopes', () => {
  const sessions = new ApplicantSessions({ call: jest.fn() }, 'dealer');
  const id = 'A'.repeat(43);
  const digest = (secret: string) =>
    createHmac('sha256', secret).update(signedScope.origin).update('\0').update(id).digest('hex');
  expect(sessions.key(signedScope, id)).toBe(`dealer-signed-admission:{39}:state:${digest(signedScope.sessionKey)}`);
  expect(sessions.key(config!, id)).toBe(`dealer-onboarding:{39}:state:${digest(config!.lspSecret)}`);
  expect(sessions.key(signedScope, id)).not.toBe(sessions.key(config!, id));
});

it('does not accept a signed admission guest in the legacy VN namespace', async () => {
  const fixture = setup();
  const signed = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
  };
  const legacy = { ...config!, vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' } };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  await fixture.service.startVn(signed, broker, { referral_token: referralToken }, fixture.setCookie);
  await expect(
    fixture.service.finishVn(
      legacy,
      broker,
      { state: 'A'.repeat(43), code: 'code' },
      fixture.cookie(),
      fixture.setCookie
    )
  ).rejects.toThrow();
  expect(broker.callback).not.toHaveBeenCalled();
});

it('pins a verified VN admission request and recovers its receipt on retry', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  const input = { pan: 'AAACA1234F', partner_name: 'Synthetic Dealer' };
  await expect(fixture.service.admitVnAction(vn, input, undefined)).rejects.toMatchObject({ status: 401 });
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  await expect(fixture.service.admitVnAction(vn, input, guest)).rejects.toMatchObject({ status: 401 });
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  await expect(
    fixture.service.admitVnAction(vn, { ...input, organization_id: '42' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 400 });
  fixture.fetcher.mockImplementationOnce(async () => {
    throw new Error('lost response');
  });
  await expect(fixture.service.admitVnAction(vn, input, fixture.cookie())).rejects.toThrow();
  await expect(
    fixture.service.admitVnAction(vn, { ...input, partner_name: 'Changed' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 409 });
  fixture.fetcher.mockImplementationOnce(async () =>
    Response.json({ draft_id: draft.id, partner_id: '123', version: 1, status: 'draft' }, { status: 200 })
  );
  const receipt = await fixture.service.admitVnAction(vn, input, fixture.cookie());
  expect(receipt).toEqual({ state: 'admitted', draftId: draft.id });
  const [url, request] = fixture.fetcher.mock.calls.at(-1)!;
  expect(url).toBe('http://destiny/v1/channel-partners/intakes/admission');
  expect(JSON.parse(request.body as string)).toEqual({ input: { referral_token: referralToken, ...input } });
  expect(request.headers).toMatchObject({
    'x-gct-org-id': '39',
    'x-gct-admission-issuer-org': '39',
    'x-gct-admission-user': '21',
    'x-admission-email': 'dealer@example.test',
  });
  const calls = fixture.fetcher.mock.calls.length;
  await expect(fixture.service.admitVnAction(vn, input, fixture.cookie())).resolves.toEqual(receipt);
  expect(fixture.fetcher).toHaveBeenCalledTimes(calls);
});

it('rejects VN admission configurations that are absent, foreign or malformed', () => {
  const valid = { issuerOrgId: '39', hmacSecret: 's'.repeat(32) };
  expect(parseVnAdmissionConfig(JSON.stringify(valid), '39')).toEqual(valid);
  for (const value of [
    undefined,
    '{}',
    JSON.stringify({ ...valid, issuerOrgId: '40' }),
    JSON.stringify({ ...valid, hmacSecret: 'short' }),
    JSON.stringify({ ...valid, extra: true }),
  ])
    expect(parseVnAdmissionConfig(value, '39')).toBeNull();
});

it('resumes only the verified session admission receipt and projects the status', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  const input = { pan: 'AAACA1234F', partner_name: 'Synthetic Dealer' };
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  await expect(fixture.service.resumeVnAdmission(vn, {}, guest)).rejects.toMatchObject({ status: 401 });
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  const calls = fixture.fetcher.mock.calls.length;
  await expect(fixture.service.resumeVnAdmission(vn, {}, fixture.cookie())).rejects.toMatchObject({ status: 409 });
  await expect(
    fixture.service.resumeVnAdmission(
      { ...vn, admission: { ...vn.admission, issuerOrgId: '40' } },
      {},
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 503 });
  await expect(fixture.service.resumeVnAdmission(vn, { draft_id: draft.id }, fixture.cookie())).rejects.toMatchObject({
    status: 400,
  });
  expect(fixture.fetcher).toHaveBeenCalledTimes(calls);
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({ draft_id: draft.id, partner_id: '123', version: 1, status: 'in_progress' })
  );
  await fixture.service.admitVnAction(vn, input, fixture.cookie());
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({ draft_id: draft.id, partner_id: '123', version: 2, status: 'in_progress', private: 'discard' })
  );
  await expect(fixture.service.resumeVnAdmission(vn, {}, fixture.cookie())).resolves.toEqual({
    draftId: draft.id,
    version: 2,
    status: 'in_progress',
  });
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({
      draft_id: draft.id,
      version: 2,
      status: 'changes_requested',
      intake_stage: 'additional_documents',
      requested_document_codes: ['utility_bill'],
    })
  );
  await expect(fixture.service.resumeVnAdmission(vn, {}, fixture.cookie())).resolves.toEqual({
    draftId: draft.id,
    version: 2,
    status: 'changes_requested',
    intake_stage: 'additional_documents',
    requested_document_codes: ['utility_bill'],
  });
  for (const patch of [
    { intake_stage: 'unknown' },
    { requested_document_codes: ['secret'] },
    { requested_document_codes: ['utility_bill', 'utility_bill'] },
  ]) {
    fixture.fetcher.mockResolvedValueOnce(
      Response.json({ draft_id: draft.id, version: 2, status: 'in_progress', ...patch })
    );
    await expect(fixture.service.resumeVnAdmission(vn, {}, fixture.cookie())).rejects.toMatchObject({ status: 503 });
  }
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 2, status: 'in_progress' }));
  await fixture.service.resumeVnAdmission(vn, {}, fixture.cookie());
  const [url, request] = fixture.fetcher.mock.calls.at(-1)!;
  expect(url).toBe('http://destiny/v1/channel-partners/intakes/admission');
  expect(JSON.parse(request.body as string)).toEqual({
    input: { referral_token: referralToken, action: 'resume', draft_id: draft.id },
  });
  expect(request.headers).toMatchObject({
    'x-gct-org-id': '39',
    'x-gct-admission-issuer-org': '39',
    'x-gct-admission-user': '21',
    'x-admission-email': 'dealer@example.test',
  });
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({
      draft_id: '11111111-1111-1111-1111-111111111111',
      partner_id: '123',
      version: 2,
      status: 'in_progress',
    })
  );
  await expect(fixture.service.resumeVnAdmission(vn, {}, fixture.cookie())).rejects.toMatchObject({ status: 503 });
  const signed = vnAdmissionHeaders(
    {
      organizationId: '39',
      issuerOrgId: '39',
      userId: '21',
      email: 'dealer@example.test',
      referral: referralToken,
      body: request.body,
    },
    vn.admission.hmacSecret,
    request.headers['x-gct-admission-issued-at']
  );
  expect(request.headers['x-admission-signature']).toBe(signed['x-admission-signature']);
  for (const patch of [{ version: 0 }, { status: 'unexpected' }, { draft_id: null }]) {
    fixture.fetcher.mockResolvedValueOnce(
      Response.json({ draft_id: draft.id, partner_id: '123', version: 2, status: 'in_progress', ...patch })
    );
    await expect(fixture.service.resumeVnAdmission(vn, {}, fixture.cookie())).rejects.toMatchObject({ status: 503 });
  }
});

it('binds VN financial actions to the admitted session and pins retries and opaque options', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
    bankConsentOrigin: 'https://consent.example.test',
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 1, status: 'in_progress' }));
  await fixture.service.admitVnAction(vn, { pan: 'AAACA1234F', partner_name: 'Synthetic Dealer' }, fixture.cookie());
  const send = (operation: string, extra: object = {}) =>
    fixture.service.financialVn(vn, { purpose: 'bank', operation, ...extra }, fixture.cookie());
  await expect(send('start', { mobile: '9999900001', draft_id: draft.id })).rejects.toMatchObject({ status: 400 });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 2, status: 'in_progress' }));
  fixture.fetcher.mockRejectedValueOnce(new Error('lost'));
  await expect(send('start', { mobile: '9999900001' })).rejects.toThrow();
  await expect(send('start', { mobile: '9999900002' })).rejects.toMatchObject({ status: 409 });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 2, status: 'in_progress' }));
  const requestId = '99999999-9999-4999-8999-999999999999';
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({
      id: requestId,
      integration: 'saafe',
      status: 'pending',
      gateway_url: 'https://consent.example.test/start',
    })
  );
  await expect(send('start', { mobile: '9999900001' })).resolves.toEqual({
    status: 'pending',
    consentUrl: 'https://consent.example.test/start',
  });
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body)).toEqual({
    input: {
      referral_token: referralToken,
      action: 'financial',
      draft_id: draft.id,
      purpose: 'bank',
      operation: 'start',
      input: { version: 2, request_id: `public-dealer-bank:${draft.id}`, mobile: '9999900001' },
    },
  });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 2, status: 'in_progress' }));
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({ accounts: [{ linked_account_ref: 'private-ref', masked_account_number: 'XXXX1234' }] })
  );
  const choices = await send('options');
  expect(choices.accounts[0].maskedAccountNumber).toBe('XXXX1234');
  expect(JSON.stringify(choices)).not.toContain('private-ref');
  await expect(send('attach', { key: 'x'.repeat(43) })).rejects.toMatchObject({ status: 409 });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 2, status: 'in_progress' }));
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({ id: requestId, status: 'pending', gateway_url: 'https://evil.example.test/start' })
  );
  await expect(send('status')).rejects.toMatchObject({ status: 503 });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 2, status: 'in_progress' }));
  fixture.fetcher.mockRejectedValueOnce(new Error('attachment response lost'));
  await expect(send('attach', { key: choices.accounts[0].key })).rejects.toThrow('attachment response lost');
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body).input.input).toEqual({
    version: 2,
    request_id: requestId,
    linked_account_ref: 'private-ref',
  });
  for (const invalidVersion of [2, 5]) {
    fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 3, status: 'in_progress' }));
    fixture.fetcher.mockResolvedValueOnce(Response.json({ version: invalidVersion }));
    await expect(send('attach', { key: choices.accounts[0].key })).rejects.toMatchObject({ status: 503 });
  }
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 3, status: 'in_progress' }));
  fixture.fetcher.mockResolvedValueOnce(Response.json({ version: 3 }));
  await expect(send('attach', { key: choices.accounts[0].key })).resolves.toEqual({ version: 3 });
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body).input.input).toEqual({
    version: 3,
    request_id: requestId,
    linked_account_ref: 'private-ref',
  });
  await expect(send('status')).rejects.toMatchObject({ status: 409 });
});

it('projects only masked GST options from the signed financial relay', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
    bankConsentOrigin: 'https://consent.example.test',
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  const current = { draft_id: draft.id, version: 1, status: 'in_progress' };
  fixture.fetcher.mockResolvedValueOnce(Response.json(current));
  await fixture.service.admitVnAction(vn, { pan: 'AAACA1234F', partner_name: 'Synthetic Dealer' }, fixture.cookie());
  fixture.fetcher.mockResolvedValueOnce(Response.json(current));
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({ id: '99999999-9999-4999-8999-999999999999', status: 'completed' })
  );
  await fixture.service.financialVn(vn, { purpose: 'gst', operation: 'start', mobile: '9999900001' }, fixture.cookie());
  fixture.fetcher.mockResolvedValueOnce(Response.json(current));
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({ accounts: [{ linked_account_ref: 'private-gst', masked_gstin: '07XXXXXXXXXX1Z1' }] })
  );
  const result = await fixture.service.financialVn(vn, { purpose: 'gst', operation: 'options' }, fixture.cookie());
  expect(result.accounts[0].maskedGstin).toBe('07XXXXXXXXXX1Z1');
  expect(JSON.stringify(result)).not.toContain('private-gst');
  fixture.fetcher.mockResolvedValueOnce(Response.json(current));
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({ accounts: [{ linked_account_ref: 'private-gst', masked_gstin: '07ABCDE1234F1Z1' }] })
  );
  await expect(
    fixture.service.financialVn(vn, { purpose: 'gst', operation: 'options' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 503 });
});

it('restores VN admission form only after verified sign-in and binds open to stored PAN', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  await expect(fixture.service.sessionVn(vn, {}, undefined)).resolves.toEqual({ state: 'invite', admission: true });
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  await expect(fixture.service.lookupVnAdmission(vn, { pan: 'AAACA1234F' }, guest)).rejects.toMatchObject({
    status: 401,
  });
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  await expect(fixture.service.sessionVn(vn, {}, fixture.cookie())).resolves.toEqual({ state: 'pan', admission: true });
  await expect(fixture.service.lookupVnAdmission(vn, { pan: 'AAACA1234F' }, fixture.cookie())).resolves.toEqual({
    state: 'details',
    category: 'company',
    admission: true,
  });
  await expect(fixture.service.sessionVn(vn, {}, fixture.cookie())).resolves.toEqual({
    state: 'details',
    category: 'company',
    admission: true,
  });
  await expect(
    fixture.service.openVnAdmission(
      vn,
      { businessName: 'Dealer', applicantName: 'Applicant', pan: 'AAAPA1234F' },
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 400 });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 1, status: 'in_progress' }));
  await fixture.service.openVnAdmission(vn, { businessName: 'Dealer', applicantName: 'Applicant' }, fixture.cookie());
  const [, request] = fixture.fetcher.mock.calls.at(-1)!;
  expect(JSON.parse(request.body as string).input).toMatchObject({ pan: 'AAACA1234F', partner_name: 'Dealer' });
  await expect(fixture.service.sessionVn(vn, {}, fixture.cookie())).resolves.toEqual({
    state: 'bound',
    admission: true,
  });
});

it('binds VN roster state and saves to the verified admitted draft and live version', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny', viewerUrl: 'https://app.example/view' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 1, status: 'in_progress' }));
  await fixture.service.admitVnAction(vn, { pan: 'AAACA1234F', partner_name: 'Dealer' }, fixture.cookie());
  const slotId = 'person' + 'a'.repeat(32);
  fixture.fetcher.mockResolvedValueOnce(Response.json({ signers: [{ slot_id: slotId, name: 'A' }] }));
  await expect(
    fixture.service.inviteVnSigner(vn, { operation: 'list', version: 3 }, fixture.cookie())
  ).resolves.toEqual({ signers: [{ slot_id: slotId, name: 'A' }] });
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body)).toEqual({
    input: {
      referral_token: referralToken,
      action: 'signer-invite',
      draft_id: draft.id,
      operation: 'list',
      input: { version: 3 },
    },
  });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ url: `https://app.example/view?signing=${referralToken}` }));
  await expect(
    fixture.service.inviteVnSigner(vn, { operation: 'issue', version: 3, slot_id: slotId }, fixture.cookie())
  ).resolves.toEqual({
    url: `https://app.example/view?signing=${referralToken}`,
  });
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({
      url: `https://evil.example/view?signing=${referralToken}`,
    })
  );
  await expect(
    fixture.service.inviteVnSigner(vn, { operation: 'issue', version: 3, slot_id: slotId }, fixture.cookie())
  ).rejects.toThrow();
  await expect(
    fixture.service.inviteVnSigner(
      vn,
      { operation: 'issue', version: 3, slot_id: slotId, draft_id: draft.id },
      fixture.cookie()
    )
  ).rejects.toThrow();
  const safe = {
    version: 3,
    entity: 'company',
    details: { mobile: '9999900001', premises: 'owned', cin: 'CIN', llpin: '' },
    people: [
      {
        slot_id: 'person' + 'a'.repeat(32),
        name: 'A',
        email: 'a@example.test',
        din: '12345678',
      },
    ],
  };
  const projected = {
    ...safe,
    people: safe.people.map(({ email, ...person }) => ({
      ...person,
      hasEmail: true,
    })),
  };
  const resume = {
    draft_id: draft.id,
    version: 3,
    status: 'in_progress',
    intake_stage: 'people',
  };
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(resume))
    .mockResolvedValueOnce(Response.json({ ...safe, private: 'hidden' }));
  await expect(fixture.service.rosterVn(vn, { operation: 'state' }, fixture.cookie())).resolves.toEqual(projected);
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body)).toEqual({
    input: {
      referral_token: referralToken,
      action: 'people',
      draft_id: draft.id,
      operation: 'state',
      input: { version: 3 },
    },
  });
  fixture.fetcher.mockResolvedValueOnce(Response.json(resume));
  await expect(
    fixture.service.rosterVn(
      vn,
      { operation: 'save', version: 2, details: safe.details, people: safe.people },
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 409 });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ ...resume, intake_stage: 'bank' }));
  await expect(fixture.service.rosterVn(vn, { operation: 'state' }, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(resume))
    .mockResolvedValueOnce(Response.json(safe))
    .mockResolvedValueOnce(Response.json({ ...safe, version: 4 }));
  await expect(
    fixture.service.rosterVn(
      vn,
      { operation: 'save', version: 3, details: safe.details, people: safe.people.map((p) => ({ ...p, email: '' })) },
      fixture.cookie()
    )
  ).resolves.toEqual({ ...projected, version: 4 });
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body).input.input).toEqual({
    version: 3,
    details: safe.details,
    people: safe.people,
  });
  const token = 'v3.' + 'a'.repeat(40);
  fixture.fetcher.mockResolvedValueOnce(Response.json(resume)).mockResolvedValueOnce(
    Response.json({
      version: 4,
      url: 'https://app.example/view?participant=' + token,
      expires_at: '2030-01-01T00:00:00Z',
    })
  );
  await expect(
    fixture.service.rosterVn(vn, { operation: 'issue', version: 3, slot_id: safe.people[0].slot_id }, fixture.cookie())
  ).resolves.toMatchObject({ version: 4, url: 'https://app.example/view?participant=' + token });
  fixture.fetcher.mockResolvedValueOnce(Response.json(resume)).mockResolvedValueOnce(
    Response.json({
      version: 4,
      url: 'https://evil.example/view?participant=' + token,
      expires_at: '2030-01-01T00:00:00Z',
    })
  );
  await expect(
    fixture.service.rosterVn(vn, { operation: 'issue', version: 3, slot_id: safe.people[0].slot_id }, fixture.cookie())
  ).rejects.toMatchObject({ status: 503 });
  fixture.fetcher.mockResolvedValueOnce(Response.json(resume)).mockResolvedValueOnce(Response.json({ version: 4 }));
  await expect(
    fixture.service.rosterVn(vn, { operation: 'revoke', version: 3, slot_id: safe.people[0].slot_id }, fixture.cookie())
  ).resolves.toEqual({ version: 4 });
  const oversized = Array.from({ length: 31 }, (_, i) => ({
    ...safe.people[0],
    slot_id: 'person' + i.toString(16).padStart(32, '0'),
  }));
  await expect(
    fixture.service.rosterVn(
      vn,
      { operation: 'save', version: 3, details: safe.details, people: oversized },
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    fixture.service.rosterVn(
      vn,
      { operation: 'save', version: 3, details: safe.details, people: [{ ...safe.people[0], extra: true }] },
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 400 });
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(resume))
    .mockResolvedValueOnce(Response.json({ ...safe, people: oversized }));
  await expect(fixture.service.rosterVn(vn, { operation: 'state' }, fixture.cookie())).rejects.toMatchObject({
    status: 503,
  });
  fixture.fetcher.mockResolvedValueOnce(Response.json(resume)).mockResolvedValueOnce(
    Response.json({
      ...safe,
      details: { ...safe.details, private: 'hidden' },
      people: [{ ...safe.people[0], private: 'hidden' }],
    })
  );
  await expect(fixture.service.rosterVn(vn, { operation: 'state' }, fixture.cookie())).resolves.toEqual(projected);
});

it('rechecks a participant intent and claims only after its verified callback', async () => {
  const timeout = jest.spyOn(AbortSignal, 'timeout');
  const fixture = setup();
  const secret = 's'.repeat(40);
  const jti = 'j'.repeat(43);
  const commitment = 'c'.repeat(64);
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 'a'.repeat(40) },
  };
  const broker = {
    start: jest.fn(),
    startParticipant: jest.fn(async (_continuation, _guest, token, eligibility) => {
      expect(await eligibility(jti, token)).toBe(commitment);
      return 'https://auth.example.test/oidc/auth';
    }),
    callback: jest.fn(),
  };
  fixture.fetcher.mockImplementation(async (url) =>
    url.includes('participant-eligibility')
      ? Response.json({ recipient_commitment: commitment })
      : Response.json({ status: 'claimed' })
  );
  await expect(
    fixture.service.startVnParticipant(
      vn,
      broker,
      'client',
      secret,
      { participant_token: referralToken },
      fixture.setCookie
    )
  ).resolves.toEqual({ authorizeUrl: 'https://auth.example.test/oidc/auth' });
  const guest = fixture.cookie()!;
  const body = { jti, client_id: 'client', organization_id: '39', recipient_commitment: commitment };
  const issued = String(Math.floor(Date.now() / 1000));
  const { participantRecheckSignature } = await import('../../../../src/modules/dealer-onboarding/vn-participant');
  const signature = participantRecheckSignature(secret, '39', issued, JSON.stringify(body));
  await expect(
    fixture.service.recheckVnParticipant(vn, 'client', secret, body, issued, signature, JSON.stringify(body))
  ).resolves.toEqual({ eligible: true });
  await expect(
    fixture.service.recheckVnParticipant(vn, 'client', secret, body, issued, '0'.repeat(64), JSON.stringify(body))
  ).rejects.toThrow();
  const spaced = JSON.stringify(body, null, 2);
  const spacedSignature = participantRecheckSignature(secret, '39', issued, spaced);
  await expect(
    fixture.service.recheckVnParticipant(vn, 'client', secret, body, issued, spacedSignature, spaced)
  ).resolves.toEqual({ eligible: true });
  await expect(
    fixture.service.recheckVnParticipant(vn, 'client', secret, body, issued, signature, spaced)
  ).rejects.toThrow();
  for (const raw of [undefined, null, {}, 123, ' '.repeat(16385)]) {
    await expect(
      fixture.service.recheckVnParticipant(vn, 'client', secret, body, issued, signature, raw as any)
    ).rejects.toThrow();
  }
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'person@example.test',
    participantJti: jti,
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie, {
    clientId: 'client',
    secret,
  });
  const [url, request] = fixture.fetcher.mock.calls.at(-1)!;
  expect(url).toBe('http://destiny/v1/channel-partners/intakes/admission');
  expect(JSON.parse(request.body as string)).toEqual({
    input: { referral_token: referralToken, action: 'person-claim' },
  });
  expect(request.headers['x-gct-admission-user']).toBe('21');
  expect(timeout).toHaveBeenLastCalledWith(5000);
  const claimed = fixture.cookie()!;
  expect(claimed).not.toBe(guest);
  await expect(fixture.service.sessionVn(vn, {}, claimed)).resolves.toEqual({
    state: 'claimed',
    admission: true,
    kycStarted: false,
  });
  await expect(fixture.service.lookupVnAdmission(vn, { pan: 'AAACA1234F' }, claimed)).rejects.toThrow();
  const callsBeforeReview = fixture.fetcher.mock.calls.length;
  await expect(fixture.service.reviewVoltcred(vn, { action: 'STATUS' }, claimed)).rejects.toMatchObject({
    status: 401,
  });
  expect(fixture.fetcher).toHaveBeenCalledTimes(callsBeforeReview);
  const kycScope = { ...vn, kycOrigin: 'https://identity.example.test' };
  const requestId = '67528714-825d-4801-8011-099e4dbe50de';
  await expect(fixture.service.participantKycVn(kycScope, { action: 'SYNC' }, claimed)).rejects.toThrow();
  await expect(
    fixture.service.participantKycVn(kycScope, { action: 'START', consent: false }, claimed)
  ).rejects.toThrow();
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({
      id: requestId,
      status: 'pending',
      gateway_url: 'https://identity.example.test/start',
      private: 'hidden',
    })
  );
  await expect(
    fixture.service.participantKycVn(kycScope, { action: 'START', consent: true }, claimed)
  ).resolves.toEqual({ status: 'pending', gatewayUrl: 'https://identity.example.test/start' });
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body as string)).toEqual({
    input: { referral_token: referralToken, action: 'person-kyc-start', consent: true },
  });
  expect(timeout).toHaveBeenLastCalledWith(45000);
  await expect(fixture.service.sessionVn(vn, {}, claimed)).resolves.toEqual({
    state: 'claimed',
    admission: true,
    kycStarted: true,
  });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ id: requestId, status: 'evidence_received' }));
  await expect(fixture.service.participantKycVn(kycScope, { action: 'SYNC' }, claimed)).resolves.toEqual({
    status: 'evidence_received',
  });
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body as string).input).toEqual({
    referral_token: referralToken,
    action: 'person-kyc-sync',
    request_id: requestId,
  });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xd9]);
  fixture.fetcher.mockResolvedValueOnce(Response.json({ id: requestId, status: 'evidence_received' }));
  fixture.fetcher.mockResolvedValueOnce(Response.json({ selfie_verified: true }));
  await expect(fixture.service.participantSelfieVn(kycScope, async () => jpeg, claimed)).resolves.toEqual({
    selfie_verified: true,
  });
  const [selfieUrl, selfieRequest] = fixture.fetcher.mock.calls.at(-1)!;
  expect(selfieUrl).toBe('http://destiny/v1/channel-partners/intakes/admission-selfie');
  expect(selfieRequest.body).toEqual(jpeg);
  expect(selfieRequest.headers).not.toHaveProperty('x-gct-admission-metadata');
  const metadata = Buffer.from(selfieRequest.headers['x-admission-metadata'], 'base64url').toString();
  expect(JSON.parse(metadata)).toEqual({
    action: 'person-selfie',
    referral_token: referralToken,
    request_id: requestId,
    sha256: createHash('sha256').update(jpeg).digest('hex'),
  });
  expect(selfieRequest.headers['x-admission-signature']).toBe(
    vnAdmissionHeaders(
      {
        organizationId: '39',
        issuerOrgId: '39',
        userId: '21',
        email: 'person@example.test',
        referral: referralToken,
        body: metadata,
      },
      vn.admission.hmacSecret,
      selfieRequest.headers['x-gct-admission-issued-at'],
      '/v1/channel-partners/intakes/admission-selfie'
    )['x-admission-signature']
  );
  fixture.fetcher.mockResolvedValueOnce(Response.json({ id: requestId, status: 'pending' }));
  await expect(fixture.service.participantSelfieVn(kycScope, async () => jpeg, claimed)).rejects.toThrow();
  timeout.mockRestore();
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({ id: requestId, status: 'pending', gateway_url: 'https://evil.example/start' })
  );
  await expect(
    fixture.service.participantKycVn(kycScope, { action: 'START', consent: true }, claimed)
  ).rejects.toThrow();
  fixture.fetcher.mockResolvedValueOnce(
    Response.json({ id: '77528714-825d-4801-8011-099e4dbe50de', status: 'pending' })
  );
  await expect(fixture.service.participantKycVn(kycScope, { action: 'SYNC' }, claimed)).rejects.toThrow();
  await expect(
    fixture.service.participantKycVn(kycScope, { action: 'SYNC', request_id: requestId }, claimed)
  ).rejects.toThrow();
  await expect(fixture.service.rosterVn(vn, { operation: 'state' }, claimed)).rejects.toThrow();
});

it.each([{}, { status: 'pending' }, { status: 'claimed', identity: 'leak' }])(
  'does not rotate a participant session for an invalid claim result %j',
  async (claim) => {
    const fixture = setup();
    const secret = 's'.repeat(40);
    const jti = 'j'.repeat(43);
    const commitment = 'c'.repeat(64);
    const vn = {
      ...signedScope,
      vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
      admission: { issuerOrgId: '39', hmacSecret: 'a'.repeat(40) },
    };
    const broker = {
      start: jest.fn(),
      startParticipant: jest.fn(async (_continuation, _guest, token, eligibility) => {
        await eligibility(jti, token);
        return 'https://auth.example.test/oidc/auth';
      }),
      callback: jest.fn(),
    };
    fixture.fetcher.mockImplementation(async (url) =>
      url.includes('participant-eligibility')
        ? Response.json({ recipient_commitment: commitment })
        : Response.json(claim)
    );
    await fixture.service.startVnParticipant(
      vn,
      broker,
      'client',
      secret,
      { participant_token: referralToken },
      fixture.setCookie
    );
    const guest = fixture.cookie()!;
    broker.callback.mockResolvedValue({
      continuation: guest,
      userId: '21',
      organizationId: '39',
      email: 'person@example.test',
      participantJti: jti,
    });
    await expect(
      fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie, {
        clientId: 'client',
        secret,
      })
    ).rejects.toThrow();
    expect(fixture.cookie()).toBe(guest);
    await expect(fixture.service.sessionVn(vn, {}, guest)).resolves.toEqual({ state: 'invite', admission: true });
  }
);

it('binds delegated evidence to the owner draft and signs the exact bytes and metadata', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 1, status: 'in_progress' }));
  await fixture.service.admitVnAction(vn, { pan: 'AAACA1234F', partner_name: 'Synthetic Dealer' }, fixture.cookie());
  const status = {
    draft_id: draft.id,
    version: 2,
    status: 'changes_requested',
    intake_stage: 'additional_documents',
    requested_document_codes: ['utility_bill'],
  };
  const file = Buffer.from('%PDF-test');
  fixture.fetcher.mockResolvedValueOnce(Response.json(status));
  await expect(
    fixture.service.uploadVnAdmissionDocument(
      vn,
      async () => ({ code: 'additional_documents', file }),
      fixture.cookie()
    )
  ).rejects.toMatchObject({ status: 409 });
  fixture.fetcher.mockResolvedValueOnce(Response.json(status)).mockResolvedValueOnce(Response.json({}));
  await expect(
    fixture.service.uploadVnAdmissionDocument(vn, async () => ({ code: 'utility_bill', file }), fixture.cookie())
  ).resolves.toEqual({ uploaded: true });
  const [url, request] = fixture.fetcher.mock.calls.at(-1)!;
  expect(url).toBe('http://destiny/v1/channel-partners/intakes/admission-document');
  const metadata = request.body.get('metadata');
  expect(JSON.parse(metadata)).toEqual({
    input: {
      action: 'document-upload',
      referral_token: referralToken,
      draft_id: draft.id,
      code: 'utility_bill',
      version: 2,
      location: null,
      sha256: createHash('sha256').update(file).digest('hex'),
    },
  });
  expect(Buffer.from(await request.body.get('file').arrayBuffer())).toEqual(file);
  expect(request.headers['x-admission-signature']).toBe(
    vnAdmissionHeaders(
      {
        organizationId: '39',
        issuerOrgId: '39',
        userId: '21',
        email: 'dealer@example.test',
        referral: referralToken,
        body: metadata,
      },
      vn.admission.hmacSecret,
      request.headers['x-gct-admission-issued-at'],
      VN_ADMISSION_DOCUMENT_PATH
    )['x-admission-signature']
  );
});

it('routes VN review through the signed admitted owner and current case version', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  await expect(fixture.service.reviewVoltcred(vn, { action: 'STATUS' }, guest)).rejects.toMatchObject({ status: 401 });
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 1, status: 'in_progress' }));
  await fixture.service.admitVnAction(vn, { pan: 'AAACA1234F', partner_name: 'Synthetic Dealer' }, fixture.cookie());
  const snapshot = { draft_id: draft.id, version: 4, status: 'in_progress', intake_stage: 'additional_documents' };
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ stage: 'evidence_ready', version: 4, actions: ['PREPARE'] }))
    .mockResolvedValueOnce(Response.json({ stage: 'ready_to_submit', version: 5, actions: ['SUBMIT'] }));
  await expect(fixture.service.reviewVoltcred(vn, { action: 'PREPARE' }, fixture.cookie())).resolves.toEqual({
    stage: 'ready_to_submit',
    action: 'SUBMIT',
  });
  const requests = fixture.fetcher.mock.calls.slice(-3);
  expect(requests.map(([url]) => url)).toEqual(Array(3).fill('http://destiny/v1/channel-partners/intakes/admission'));
  expect(requests.map(([, request]) => JSON.parse(request.body as string).input)).toEqual([
    { referral_token: referralToken, action: 'resume', draft_id: draft.id },
    { referral_token: referralToken, action: 'completion', draft_id: draft.id, operation: 'STATUS', version: 4 },
    { referral_token: referralToken, action: 'completion', draft_id: draft.id, operation: 'PREPARE', version: 4 },
  ]);
  for (const [, request] of requests)
    expect(request.headers['x-admission-signature']).toBe(
      vnAdmissionHeaders(
        {
          organizationId: '39',
          issuerOrgId: '39',
          userId: '21',
          email: 'dealer@example.test',
          referral: referralToken,
          body: request.body,
        },
        vn.admission.hmacSecret,
        request.headers['x-gct-admission-issued-at']
      )['x-admission-signature']
    );
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ stage: 'ready_to_submit', version: 4, actions: ['SUBMIT'] }))
    .mockResolvedValueOnce(Response.json({ stage: 'submitted', version: 5, actions: [] }));
  await expect(fixture.service.reviewVoltcred(vn, { action: 'SUBMIT' }, fixture.cookie())).resolves.toEqual({
    stage: 'submitted',
    action: null,
  });
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body).input).toEqual({
    referral_token: referralToken,
    action: 'completion',
    draft_id: draft.id,
    operation: 'SUBMIT',
    version: 4,
  });
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ stage: 'evidence_ready', version: 5, actions: ['PREPARE'] }));
  await expect(fixture.service.reviewVoltcred(vn, { action: 'PREPARE' }, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ stage: 'review_pending', version: 4, actions: [] }));
  await expect(fixture.service.reviewVoltcred(vn, { action: 'STATUS' }, fixture.cookie())).resolves.toEqual({
    stage: 'review_pending',
    action: null,
  });
  fixture.fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(fixture.service.reviewVoltcred(vn, { action: 'STATUS' }, fixture.cookie())).rejects.toMatchObject({
    status: 403,
  });
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ stage: 'evidence_ready', version: 4, actions: ['SIGN'] }));
  await expect(fixture.service.reviewVoltcred(vn, { action: 'STATUS' }, fixture.cookie())).rejects.toMatchObject({
    status: 503,
  });
});

it('uses the signed bound admission execution snapshot and rejects stale versions', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  await expect(fixture.service.executionVn(vn as any, { action: 'STATUS' }, guest)).rejects.toMatchObject({
    status: 401,
  });
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 1, status: 'in_progress' }));
  await fixture.service.admitVnAction(vn, { pan: 'AAACA1234F', partner_name: 'Synthetic Dealer' }, fixture.cookie());
  const snapshot = { draft_id: draft.id, version: 4, status: 'in_progress', intake_stage: 'additional_documents' };
  const fields = {
    legal_name: 'Dealer',
    registered_address: 'Road',
    additional_address: '',
    signatory_name: 'Person',
    signatory_designation: 'Partner',
    bank_account_holder: 'Dealer',
    bank_name: 'Bank',
    bank_account_number: '123456',
    confirm_account_number: '123456',
    bank_ifsc: 'ABCD0123456',
    approved_outlets: 'One',
  };
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(
      Response.json({ version: 4, execution: 'registered_entity', bank_account_number: 'hidden' })
    );
  await expect(fixture.service.executionVn(vn as any, { action: 'STATUS' }, fixture.cookie())).resolves.toEqual({
    version: 4,
    execution: 'registered_entity',
  });
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ version: 4, execution: 'registered_entity' }))
    .mockResolvedValueOnce(Response.json({ version: 5, execution: null, secret: 'hidden' }));
  await expect(
    fixture.service.executionVn(vn as any, { action: 'SAVE_EXECUTION', version: 4, fields }, fixture.cookie())
  ).resolves.toEqual({ version: 5, execution: null });
  const requests = fixture.fetcher.mock.calls.slice(-3);
  expect(requests.map(([, request]) => JSON.parse(request.body as string).input)).toEqual([
    { referral_token: referralToken, action: 'resume', draft_id: draft.id },
    { referral_token: referralToken, action: 'execution', draft_id: draft.id, operation: 'STATUS', version: 4 },
    { referral_token: referralToken, action: 'execution', draft_id: draft.id, operation: 'SAVE', version: 4, fields },
  ]);
  for (const [, request] of requests)
    expect(request.headers['x-admission-signature']).toBe(
      vnAdmissionHeaders(
        {
          organizationId: '39',
          issuerOrgId: '39',
          userId: '21',
          email: 'dealer@example.test',
          referral: referralToken,
          body: request.body,
        },
        vn.admission.hmacSecret,
        request.headers['x-gct-admission-issued-at']
      )['x-admission-signature']
    );
  fixture.fetcher.mockResolvedValueOnce(Response.json(snapshot));
  await expect(
    fixture.service.executionVn(vn as any, { action: 'SAVE_EXECUTION', version: 3, fields }, fixture.cookie())
  ).rejects.toMatchObject({ status: 409 });
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ version: 5, execution: 'registered_entity' }));
  await expect(fixture.service.executionVn(vn as any, { action: 'STATUS' }, fixture.cookie())).rejects.toMatchObject({
    status: 409,
  });
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ version: 4, execution: 'unknown' }));
  await expect(fixture.service.executionVn(vn as any, { action: 'STATUS' }, fixture.cookie())).rejects.toMatchObject({
    status: 503,
  });
});

it('reports only signed delegated agreement status at the current version', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 's'.repeat(32) },
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  fixture.fetcher.mockResolvedValueOnce(Response.json({ draft_id: draft.id, version: 1, status: 'in_progress' }));
  await fixture.service.admitVnAction(vn, { pan: 'AAACA1234F', partner_name: 'Dealer' }, fixture.cookie());
  const snapshot = { draft_id: draft.id, version: 4, status: 'submitted', intake_stage: 'agreement' };
  for (const [stage, next] of [
    ['bank_verification_required', 'VERIFY_BANK'],
    ['agreement_pending', 'FREEZE'],
    ['signing_pending', null],
    ['review_pending', null],
    ['agreement_unavailable', null],
  ]) {
    fixture.fetcher
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ stage, version: 4, actions: next ? [next] : [] }));
    await expect(fixture.service.agreementVoltcred(vn as any, { action: 'STATUS' }, fixture.cookie())).resolves.toEqual(
      { stage, action: next, canSign: false, signed: false }
    );
    const requests = fixture.fetcher.mock.calls.slice(-2);
    expect(requests.map(([, req]) => JSON.parse(req.body as string).input)).toEqual([
      { referral_token: referralToken, action: 'resume', draft_id: draft.id },
      { referral_token: referralToken, action: 'completion', draft_id: draft.id, operation: 'STATUS', version: 4 },
    ]);
    for (const [, req] of requests)
      expect(req.headers['x-admission-signature']).toBe(
        vnAdmissionHeaders(
          {
            organizationId: '39',
            issuerOrgId: '39',
            userId: '21',
            email: 'dealer@example.test',
            referral: referralToken,
            body: req.body,
          },
          vn.admission.hmacSecret,
          req.headers['x-gct-admission-issued-at']
        )['x-admission-signature']
      );
  }
  for (const action of ['SIGN'])
    await expect(fixture.service.agreementVoltcred(vn as any, { action }, fixture.cookie())).rejects.toMatchObject({
      status: 409,
    });
  for (const forged of [
    { stage: 'agreement_pending', version: 4, actions: ['SIGN'] },
    { stage: 'agreement_pending', version: 4, actions: [], url: 'https://evil.test' },
    { stage: 'agreement_pending', version: 5, actions: [] },
    { stage: 'signing_pending', version: 4, actions: ['SIGN'] },
  ]) {
    fixture.fetcher.mockResolvedValueOnce(Response.json(snapshot)).mockResolvedValueOnce(Response.json(forged));
    await expect(
      fixture.service.agreementVoltcred(vn as any, { action: 'STATUS' }, fixture.cookie())
    ).rejects.toThrow();
  }
  for (const [action, stage, nextStage] of [
    ['VERIFY_BANK', 'bank_verification_required', 'agreement_pending'],
    ['FREEZE', 'agreement_pending', 'signing_pending'],
  ]) {
    fixture.fetcher
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ stage, version: 4, actions: [action] }))
      .mockResolvedValueOnce(
        Response.json({
          stage: nextStage,
          version: action === 'VERIFY_BANK' ? 4 : 5,
          actions: nextStage === 'agreement_pending' ? ['FREEZE'] : [],
        })
      );
    await expect(fixture.service.agreementVoltcred(vn as any, { action }, fixture.cookie())).resolves.toEqual({
      stage: nextStage,
      action: nextStage === 'agreement_pending' ? 'FREEZE' : null,
      canSign: false,
      signed: false,
    });
    expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body as string).input).toEqual({
      referral_token: referralToken,
      action: 'completion',
      draft_id: draft.id,
      operation: action,
      version: 4,
    });
  }
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ stage: 'signing_pending', version: 4, actions: ['REFRESH'] }))
    .mockResolvedValueOnce(Response.json({ stage: 'agreement_signed', version: 5, actions: [] }));
  await expect(fixture.service.agreementVoltcred(vn as any, { action: 'REFRESH' }, fixture.cookie())).resolves.toEqual({
    stage: 'agreement_signed',
    action: null,
    canSign: false,
    signed: true,
  });
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ stage: 'agreement_signed', version: 4, actions: [] }));
  await expect(fixture.service.agreementVoltcred(vn as any, { action: 'STATUS' }, fixture.cookie())).resolves.toEqual({
    stage: 'agreement_signed',
    action: null,
    canSign: false,
    signed: true,
  });
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ stage: 'signing_pending', version: 4, actions: ['REFRESH'] }))
    .mockResolvedValueOnce(Response.json({ stage: 'completed', version: 5, actions: [] }));
  await expect(fixture.service.agreementVoltcred(vn as any, { action: 'REFRESH' }, fixture.cookie())).resolves.toEqual({
    stage: 'completed',
    action: null,
    canSign: false,
    signed: true,
  });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ ...snapshot, status: 'approved', intake_stage: 'completed' }));
  await expect(fixture.service.agreementVoltcred(vn as any, { action: 'STATUS' }, fixture.cookie())).resolves.toEqual({
    stage: 'completed',
    action: null,
    canSign: false,
    signed: true,
  });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ ...snapshot, status: 'approved', intake_stage: 'completed' }));
  await expect(fixture.service.agreementVoltcred(vn as any, { action: 'REFRESH' }, fixture.cookie())).rejects.toThrow();
  fixture.fetcher
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ stage: 'agreement_pending', version: 4, actions: ['FREEZE'] }));
  await expect(
    fixture.service.agreementVoltcred(vn as any, { action: 'VERIFY_BANK' }, fixture.cookie())
  ).rejects.toMatchObject({ status: 409 });
  fixture.fetcher.mockResolvedValueOnce(Response.json({ ...snapshot, intake_stage: 'review' }));
  await expect(fixture.service.agreementVoltcred(vn as any, { action: 'STATUS' }, fixture.cookie())).rejects.toThrow();
});

it('isolates signer callback from owner and participant sessions', async () => {
  const fixture = setup();
  const secret = 's'.repeat(40),
    jti = 'j'.repeat(43);
  const { signerRecipientKey } = await import('../../../../src/modules/dealer-onboarding/vn-signer');
  const { createHmac } = await import('node:crypto');
  const commitment = createHmac('sha256', Buffer.from(signerRecipientKey(secret, '39', 'client', jti), 'hex'))
    .update('signer@example.test')
    .digest('hex');
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 'a'.repeat(40) },
  };
  const broker = {
    start: jest.fn(),
    startSigner: jest.fn(async (_c, _g, token, eligible) => {
      await eligible(jti, token);
      return 'https://auth.example.test/';
    }),
    callback: jest.fn(),
  };
  fixture.fetcher.mockImplementation(async () => Response.json({ recipient_commitment: commitment }));
  await fixture.service.startVnSigner(vn, broker, 'client', secret, { signer_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  const body = {
    jti,
    client_id: 'client',
    organization_id: '39',
    recipient_commitment: commitment,
  };
  const issued = String(Math.floor(Date.now() / 1000));
  const { signerRecheckSignature } = await import('../../../../src/modules/dealer-onboarding/vn-signer');
  await expect(
    fixture.service.recheckVnSigner(
      vn,
      'client',
      secret,
      body,
      issued,
      signerRecheckSignature(secret, '39', issued, JSON.stringify(body)),
      JSON.stringify(body)
    )
  ).resolves.toEqual({ eligible: true });
  await expect(
    fixture.service.recheckVnSigner(vn, 'client', secret, body, issued, '0'.repeat(64), JSON.stringify(body))
  ).rejects.toThrow();
  await expect(
    fixture.service.recheckVnSigner(
      vn,
      'client',
      secret,
      { ...body, extra: true },
      issued,
      signerRecheckSignature(secret, '39', issued, JSON.stringify(body)),
      JSON.stringify(body)
    )
  ).rejects.toThrow();
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'signer@example.test',
    participantJti: jti,
  });
  await expect(
    fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie, {
      clientId: 'client',
      secret,
    })
  ).rejects.toThrow();
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'other@example.test',
    signerJti: jti,
  });
  await expect(
    fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie, {
      clientId: 'client',
      secret,
    })
  ).rejects.toThrow();
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'signer@example.test',
    signerJti: jti,
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie, {
    clientId: 'client',
    secret,
  });
  const signedIn = fixture.cookie()!;
  await expect(fixture.service.sessionVn(vn, {}, signedIn)).resolves.toEqual({
    state: 'signer',
    admission: true,
  });
  await expect(fixture.service.lookupVnAdmission(vn, { pan: 'AAACA1234F' }, signedIn)).rejects.toThrow();
  await expect(fixture.service.inviteVnSigner(vn, { operation: 'list', version: 1 }, signedIn)).rejects.toThrow();
  await expect(
    fixture.service.participantKycVn({ ...vn, kycOrigin: 'https://kyc.example.test' }, { action: 'SYNC' }, signedIn)
  ).rejects.toThrow();
  await expect(fixture.service.agreementVoltcred(vn as any, { action: 'STATUS' }, signedIn)).rejects.toThrow();
  fixture.fetcher.mockResolvedValueOnce(Response.json({ recipient_commitment: 'f'.repeat(64) }));
  await expect(
    fixture.service.signVnSigner({ ...vn, signingOrigin: 'https://sign.example.test' }, 'client', secret, {}, signedIn)
  ).rejects.toThrow();
  fixture.fetcher.mockResolvedValueOnce(Response.json({ recipient_commitment: commitment })).mockResolvedValueOnce(
    Response.json({
      status: 'requested',
      url: 'https://sign.example.test/start',
    })
  );
  await expect(
    fixture.service.signVnSigner({ ...vn, signingOrigin: 'https://sign.example.test' }, 'client', secret, {}, signedIn)
  ).resolves.toEqual({
    status: 'requested',
    url: 'https://sign.example.test/start',
  });
  expect(JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body as string)).toEqual({
    input: { action: 'signer-own-sign', signer_token: referralToken },
  });
  await expect(
    fixture.service.signVnSigner(
      { ...vn, signingOrigin: 'https://sign.example.test' },
      'client',
      secret,
      { signer_token: referralToken },
      signedIn
    )
  ).rejects.toThrow();
});

it('redacts signer invitation URLs and private signer request credentials from telemetry', () => {
  expect(sanitizeOAuthUrl('https://app.example/view?signing=opaque')).toBe('https://app.example/view');
  expect(
    sanitizeTraceObject({
      signer_token: 'secret',
      'x-signer-eligibility-signature': 'secret',
      'x-signer-recheck-signature': 'secret',
    })
  ).toEqual({
    signer_token: '[REDACTED]',
    'x-signer-eligibility-signature': '[REDACTED]',
    'x-signer-recheck-signature': '[REDACTED]',
  });
});

it('uses private Destiny eligibility for signed VN owner start and callback', async () => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 'x'.repeat(32) },
  };
  const broker = { start: jest.fn().mockResolvedValue('https://auth.example.test'), callback: jest.fn() };
  await fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie);
  const guest = fixture.cookie()!;
  broker.callback.mockResolvedValue({
    continuation: guest,
    userId: '21',
    organizationId: '39',
    email: 'dealer@example.test',
  });
  await fixture.service.finishVn(vn, broker, { state: 'A'.repeat(43), code: 'code' }, guest, fixture.setCookie);
  const calls = fixture.fetcher.mock.calls.filter(
    ([url]) => url === 'http://destiny/v1/channel-partners/referrals/eligibility'
  );
  expect(calls).toHaveLength(2);
  for (const [, request] of calls) {
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-gct-org-id': '39' },
      body: JSON.stringify({ referral_token: referralToken }),
    });
    expect(Object.keys(request.headers).sort()).toEqual(['content-type', 'x-gct-org-id']);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  }
  expect(fixture.fetcher.mock.calls.some(([url]) => url === config!.furyUrl)).toBe(false);
});

it.each([
  { organization_id: '40', eligible: true },
  { organization_id: '39', eligible: false },
  { organization_id: 39, eligible: true },
  { organization_id: '39', eligible: true, extra: true },
])('rejects invalid private eligibility %j', async (result) => {
  const fixture = setup();
  const vn = {
    ...signedScope,
    vn: { actorOrganizationId: '39', destinyOrigin: 'http://destiny' },
    admission: { issuerOrgId: '39', hmacSecret: 'x'.repeat(32) },
  };
  fixture.fetcher.mockResolvedValue(Response.json(result));
  const broker = { start: jest.fn(), callback: jest.fn() };
  await expect(
    fixture.service.startVn(vn, broker, { referral_token: referralToken }, fixture.setCookie)
  ).rejects.toMatchObject({ status: 409 });
  expect(broker.start).not.toHaveBeenCalled();
});

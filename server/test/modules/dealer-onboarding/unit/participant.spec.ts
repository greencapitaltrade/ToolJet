/** @group platform */
import { ConfigService } from '@nestjs/config';
import type { Response as ExpressResponse } from 'express';
import type { RedisService } from '@modules/redis/service';
import { DealerOnboardingController } from '../../../../src/modules/dealer-onboarding/controller';
import { DealerParticipant, parseDealerParticipantConfig } from '../../../../src/modules/dealer-onboarding/participant';
import type { ApplicantHttpRequest } from '../../../../src/modules/applicant-session/http';
import { isApplicantOnboardingRequest, sanitizeOAuthRequest } from '../../../../src/otel/sanitize';

jest.mock('@modules/app/ability/guard', () => ({ FeatureAbilityGuard: class {} }));
jest.mock('@modules/app/constants', () => ({ FEATURE_KEY: { DEALER_ONBOARDING: 'dealer-onboarding' } }));
jest.mock('@modules/redis/service', () => ({ RedisService: class {} }));

const referralToken = `v2.${'a'.repeat(45)}`;
const consentId = '006a83f7-03c5-4a10-ba6a-df099ef8f98d';
const scope = {
  origin: 'https://app.example.test',
  organizationId: '39',
  furyUrl: 'https://gateway.example.test/v2/graphql',
  lspSecret: 'synthetic-participant-secret',
  kycOrigin: 'https://identity.example.test',
  signingOrigin: 'https://signing.example.test',
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
        const count = Number(keys.get(args[2])) + 1 || 1;
        keys.set(args[2], String(count));
        return count;
      }
      if (args[0].includes('EXISTS')) {
        if (!keys.has(args[2]) || keys.has(args[3])) return 0;
        keys.set(args[3], args[4]);
        return Number(keys.delete(args[2]));
      }
      return keys.get(args[2]) === args[3] ? Number(keys.delete(args[2])) : 0;
    },
  };
  let owner = true;
  let status = 'accepted';
  let selfieAvailable = false;
  let signUrl = 'https://signing.example.test/synthetic';
  const fetcher = jest.fn(async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string);
    if (query.includes('dealerReferralEligibility'))
      return Response.json({ data: { dealerReferralEligibility: { organizationId: '39', eligible: true } } });
    if (query.includes('sessionCreateV2'))
      return Response.json({ data: { sessionCreateV2: { success: true, status: 'otp_sent' } } });
    if (query.includes('sessionPut')) {
      const claims = {
        device: (init.headers as Record<string, string>).device,
        phone: variables.phone,
        org_id: '39',
        user_id: '21',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
      return Response.json({ data: { sessionPut: { token } } });
    }
    if (query.includes('dealerParticipantClaim'))
      return Response.json({
        data: {
          dealerParticipantClaim: Object.keys(variables.fields).length
            ? { status: 'pending', id: consentId }
            : { status: 'unclaimed' },
        },
      });
    if (query.includes('dealerParticipantAttach')) {
      if (!owner) return Response.json({ errors: [{ message: 'private upstream error' }] });
      return Response.json({
        data: {
          dealerParticipantAttach: {
            status,
            kycStatus: 'verified',
            selfieVerified: !selfieAvailable,
            selfieAvailable,
            agreementPrepared: true,
            draftId: 'private-draft-id',
          },
        },
      });
    }
    if (query.includes('dealerParticipantSelfie'))
      return Response.json({ data: { dealerParticipantSelfie: { verified: true } } });
    if (!query.includes('dealerParticipantAction')) throw new Error('unrecognised fixed operation');
    return Response.json({
      data: { dealerParticipantAction: { status: 'requested', redirectUrl: signUrl, owner: 'private' } },
    });
  }) as jest.MockedFunction<typeof fetch>;
  const service = new DealerParticipant(redis, fetcher);
  let handle: string | undefined;
  const set = (id: string) => {
    handle = id;
  };
  const invoke = (operation: string, fields = {}, extra = {}) =>
    service.run(scope, { operation, fields, ...extra }, handle, set);
  const login = async () => {
    await invoke('entry', {}, { referralToken });
    await invoke('requestOtp', { phone: '9999900001' });
    const guest = handle;
    await expect(invoke('verifyOtp', { otp: '123456' })).resolves.toEqual({ state: 'receipt' });
    expect(handle).not.toBe(guest);
    expect([...keys.keys()].every((key) => key.startsWith('dealer-participant-onboarding:'))).toBe(true);
    await expect(service.run(scope, { operation: 'status', fields: {} }, guest, jest.fn())).resolves.toEqual({
      state: 'invite',
    });
  };
  const requests = () =>
    fetcher.mock.calls.map(([, init]) => ({ ...JSON.parse(init.body as string), headers: init.headers }));
  return {
    invoke,
    login,
    prepareSelfie: () => {
      selfieAvailable = true;
    },
    uploadSelfie: (read: () => Promise<Buffer>) => service.uploadSelfie(scope, read, handle),
    requests,
    denyReceipt: () => {
      owner = false;
    },
    withdraw: () => {
      status = 'withdrawn';
    },
    invalidSigningOrigin: () => {
      signUrl = 'https://different.example.test/synthetic';
    },
  };
}

it('requires the participant OTP before looking up a referral-bound receipt and only forwards the bound ID', async () => {
  const { invoke, login, requests } = setup();
  await expect(invoke('attach', { consentId })).rejects.toMatchObject({ status: 409 });
  await expect(invoke('entry', { consentId }, { referralToken })).rejects.toMatchObject({ status: 400 });
  expect(requests()).toHaveLength(0);
  await login();
  expect(requests().some(({ query }) => query.includes('dealerParticipantAttach'))).toBe(false);
  await expect(invoke('attach', { consentId, draftId: 'forged' })).rejects.toMatchObject({ status: 400 });
  await expect(invoke('attach', { consentId })).resolves.toEqual({
    state: 'participant',
    status: 'accepted',
    kycStatus: 'verified',
    selfieVerified: true,
    agreementPrepared: true,
    actions: ['syncKyc', 'sign', 'withdraw'],
  });
  await expect(invoke('sign', { consentId })).rejects.toMatchObject({ status: 400 });
  await expect(invoke('sign')).resolves.toEqual({
    state: 'action',
    status: 'requested',
    redirectUrl: 'https://signing.example.test/synthetic',
  });
  const calls = requests().filter(({ query }) => query.includes('dealerParticipant'));
  expect(calls.map(({ variables }) => variables)).toEqual([
    { referralToken, consentId },
    { referralToken, consentId },
    { action: 'SIGN', consentId },
  ]);
  for (const call of calls) {
    expect(call.headers.cookie).toMatch(/^authorization=header\..+; device=/);
    expect(call.headers['api-secret']).toBeUndefined();
  }
});

it('rejects a foreign, revoked, or swapped receipt and unconfigured provider destinations', async () => {
  const { invoke, login, denyReceipt, withdraw, invalidSigningOrigin, requests } = setup();
  await login();
  await invoke('attach', { consentId });
  const substitute = 'b62cbf35-1ff2-44ce-bd21-77a8f400a9bf';
  await expect(invoke('attach', { consentId: substitute })).rejects.toMatchObject({ status: 409 });
  invalidSigningOrigin();
  await expect(invoke('sign')).rejects.toMatchObject({ status: 503 });
  withdraw();
  await expect(invoke('sign')).rejects.toMatchObject({ status: 409 });
  denyReceipt();
  await expect(invoke('status')).resolves.toEqual({ state: 'receipt' });
  expect(requests().filter(({ query }) => query.includes('dealerParticipantAction'))).toHaveLength(1);
  expect(parseDealerParticipantConfig(JSON.stringify(scope))).toEqual(scope);
  expect(
    parseDealerParticipantConfig(JSON.stringify({ ...scope, kycOrigin: 'https://identity.example.test/path' }))
  ).toBeNull();
  expect(parseDealerParticipantConfig(undefined)).toBeNull();
});

it('keeps participant credentials, cookies and telemetry separate from the dealer owner route', async () => {
  const ownerCookie = 'x'.repeat(43);
  const request = {
    get: (name: string) => (name === 'origin' ? scope.origin : undefined),
    is: (media: string) => media === 'application/json',
    cookies: { '__Host-tj-dealer-onboarding': ownerCookie },
    body: { operation: 'status', fields: {} },
  } as unknown as ApplicantHttpRequest;
  const makeResponse = () => ({
    set: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    cookie: jest.fn().mockReturnThis(),
  });
  const redis = { call: jest.fn() };
  const makeController = (environment: Record<string, string>) =>
    new DealerOnboardingController(new ConfigService(environment), {
      getClient: () => redis,
    } as unknown as RedisService);
  const disabled = makeResponse();
  await makeController({ TOOLJET_DEALER_ONBOARDING: '{}' }).handleParticipant(
    request,
    disabled as unknown as ExpressResponse
  );
  expect(disabled.status).toHaveBeenCalledWith(404);
  const enabled = makeResponse();
  await makeController({ TOOLJET_DEALER_PARTICIPANT: JSON.stringify(scope) }).handleParticipant(
    request,
    enabled as unknown as ExpressResponse
  );
  expect(enabled.status).toHaveBeenCalledWith(200);
  expect(enabled.json).toHaveBeenCalledWith({ state: 'invite' });
  expect(redis.call).not.toHaveBeenCalled();
  const url = '/api/dealer-onboarding/participant';
  expect(isApplicantOnboardingRequest(url)).toBe(true);
  expect(sanitizeOAuthRequest({ url, body: { consentId }, rawBody: JSON.stringify({ consentId }) })).toMatchObject({
    body: '[REDACTED]',
    rawBody: '[REDACTED]',
  });
  const uploadUrl = `${url}/selfie`;
  expect(
    sanitizeOAuthRequest({ url: uploadUrl, body: Buffer.from('synthetic selfie'), rawBody: 'synthetic selfie' })
  ).toMatchObject({ body: '[REDACTED]', rawBody: '[REDACTED]' });
});

it('checks a handoff only after independent OTP and keeps its recovered receipt server-side', async () => {
  const { invoke, requests } = setup();
  const invitationId = 'b62cbf35-1ff2-44ce-bd21-77a8f400a9bf';
  await invoke('entry', { invitationId }, { referralToken });
  await expect(invoke('claim', { consent: true })).rejects.toMatchObject({ status: 409 });
  await invoke('requestOtp', { phone: '9999900001' });
  expect(requests().some(({ query }) => query.includes('dealerParticipantClaim'))).toBe(false);
  await expect(invoke('verifyOtp', { otp: '123456' })).resolves.toEqual({ state: 'participantEntry' });
  await expect(invoke('status')).resolves.toEqual({ state: 'participantDetails' });
  await expect(invoke('attach', { consentId })).rejects.toMatchObject({ status: 409 });
  await expect(
    invoke('claim', { consent: true, name: 'Synthetic user', role: 'Director', kyc_contact: 'person@example.test' })
  ).resolves.toMatchObject({ state: 'participant' });
  expect(
    requests()
      .filter(({ query }) => query.includes('dealerParticipantClaim'))
      .slice(-1)[0].variables
  ).toMatchObject({ referralToken, invitationId });
});

it('requires an approved, fresh participant receipt before reading and forwarding only one bounded JPEG', async () => {
  const { invoke, login, requests, withdraw, prepareSelfie, uploadSelfie } = setup();
  const jpeg = Buffer.from([255, 216, 255, 0, 255, 217]);
  const read = jest.fn(async () => jpeg);
  await expect(uploadSelfie(read)).rejects.toMatchObject({ status: 409 });
  await login();
  await expect(uploadSelfie(read)).rejects.toMatchObject({ status: 409 });
  await invoke('attach', { consentId });
  await expect(uploadSelfie(read)).rejects.toMatchObject({ status: 409 });
  expect(read).not.toHaveBeenCalled();
  prepareSelfie();
  await expect(invoke('status')).resolves.toMatchObject({ actions: ['syncKyc', 'selfie', 'withdraw'] });
  await expect(uploadSelfie(async () => Buffer.alloc(96 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
  await expect(uploadSelfie(async () => Buffer.from('not-jpeg'))).rejects.toMatchObject({ status: 422 });
  await expect(uploadSelfie(read)).resolves.toEqual({ state: 'action', status: 'verified' });
  const calls = requests().filter(({ query }) => query.includes('dealerParticipantSelfie'));
  expect(calls).toHaveLength(1);
  expect(calls[0].variables).toEqual({
    consentId,
    referralToken,
    selfie: 'data:image/jpeg;base64,/9j/AP/Z',
  });
  expect(calls[0].headers.cookie).toMatch(/^authorization=header\..+; device=/);
  expect(calls[0].headers['api-secret']).toBeUndefined();
  withdraw();
  await expect(uploadSelfie(read)).rejects.toMatchObject({ status: 409 });
  expect(read).toHaveBeenCalledTimes(1);
});

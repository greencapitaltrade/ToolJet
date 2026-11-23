/** @group platform */
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { BorrowerOnboardingController } from '../../../../src/modules/borrower-onboarding/controller';
import type { RedisService } from '@modules/redis/service';

jest.mock('@modules/app/ability/guard', () => ({ FeatureAbilityGuard: class {} }));
jest.mock('@modules/app/constants', () => ({ FEATURE_KEY: { BORROWER_ONBOARDING: 'borrower-onboarding' } }));
jest.mock('@modules/redis/service', () => ({ RedisService: class {} }));

const origin = 'https://app.example.test';
const settings = JSON.stringify({
  origin,
  organizationId: '39',
  furyUrl: 'https://gateway.example.test/v2/graphql',
  lspSecret: 'fixture-private-credential',
  returnUrl: origin + '/applications/example/documentation',
  providerOrigins: ['https://provider.example.test'],
});

function fixture(config: string | undefined = settings) {
  const redis = {
    call: jest.fn().mockImplementation(async (operation) => (operation === 'EVAL' ? 1 : 'OK')),
  };
  const next = new BorrowerOnboardingController(
    new ConfigService(config ? { TOOLJET_BORROWER_ONBOARDING: config } : {}),
    { getClient: () => redis } as unknown as RedisService
  );
  function invoke(headers: Record<string, string> = {}, body: Record<string, unknown> = {}, upload = false) {
    const request = {
      get: (name: string) => (name === 'origin' ? (headers[name] ?? origin) : headers[name]),
      is: (type: string) => headers['content-type'] === type,
      body: { operation: 'entry', fields: {}, ...body },
      rawBody: headers.rawBody,
    };
    const response = {
      set: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      cookie: jest.fn().mockReturnThis(),
    };
    const handler = upload ? next.upload.bind(next) : next.handle.bind(next);
    return { response, done: handler(request as unknown as Request, response as unknown as Response) };
  }
  return { invoke, redis };
}

afterEach(() => jest.restoreAllMocks());

it('rejects exact configured route boundary failures before reaching Redis', async () => {
  const { invoke, redis } = fixture();
  for (const [headers, status] of [
    [{ origin: '', 'content-type': 'application/json' }, 403],
    [{ origin: 'https://another.example.test', 'content-type': 'application/json' }, 403],
    [{ origin, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }, 403],
    [{ origin, 'content-type': 'text/plain' }, 415],
    [{ origin, 'content-type': 'application/json', 'content-length': '16385' }, 413],
    [{ origin, 'content-type': 'application/json', rawBody: 'x'.repeat(16385) }, 413],
  ] as const) {
    const { response, done } = invoke(headers);
    await done;
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith({ error: 'Borrower onboarding request unavailable' });
  }
  expect(redis.call).not.toHaveBeenCalled();
  const disabled = fixture('invalid').invoke();
  await disabled.done;
  expect(disabled.response.status).toHaveBeenCalledWith(404);
});

it('requires the exact browser origin, multipart and a verified session for document uploads', async () => {
  const { invoke, redis } = fixture();
  for (const [headers, status] of [
    [{ origin: 'https://another.example.test', 'content-type': 'multipart/form-data' }, 403],
    [{ origin, 'content-type': 'application/json' }, 415],
    [{ origin, 'content-type': 'multipart/form-data' }, 409],
  ] as const) {
    const { response, done } = invoke(headers, {}, true);
    await done;
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith({ error: 'Borrower onboarding request unavailable' });
  }
  expect(redis.call).not.toHaveBeenCalled();
});

it('issues only an opaque host-only session cookie on an eligible exact-origin entry', async () => {
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json({ data: { borrowerReferralEligibility: { organizationId: '39', productId: 12 } } })
    );
  const { invoke } = fixture();
  const { response, done } = invoke(
    { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    { referralToken: 'v3.' + 'a'.repeat(60) }
  );
  await done;
  expect(response.cookie).toHaveBeenCalledWith(
    '__Host-tj-borrower-onboarding',
    expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600000 }
  );
  expect(response.set).toHaveBeenCalledWith({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  expect(response.json).toHaveBeenCalledWith({ state: 'phone' });
});

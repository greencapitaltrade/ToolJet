import {
  dealerVoltcredAuthorizeUrl,
  parseDealerVoltcredBridge,
  parseTrustedVoltcredReceipt,
} from '../../../../src/modules/dealer-onboarding/voltcred-bridge';

const state = Buffer.alloc(32, 1).toString('base64url');
const brokerSecret = 'synthetic-voltcred-broker-secret-fixture';
const values = {
  actorOrganizationId: '55',
  brokerSecret,
  destinyOrigin: 'http://destiny.lending.svc.cluster.local',
};
const incoming = {
  state,
  token: 'header.fixture.signature',
  device: 'fixture-device',
  user_id: '333',
};

test('fixes authorization to the VoltCred path and sends only an opaque state', () => {
  const url = new URL(dealerVoltcredAuthorizeUrl(state));
  expect(`${url.origin}${url.pathname}`).toBe('https://flash.voltcred.com/auth/dealer-onboarding/authorize');
  expect([...url.searchParams]).toEqual([['state', state]]);
  expect(() => dealerVoltcredAuthorizeUrl('urn:referral:fixture')).toThrow();
});

test('requires both an explicit actor organization and a dedicated broker secret', () => {
  expect(parseDealerVoltcredBridge(JSON.stringify(values))).toEqual(values);
  for (const input of [
    { ...values, path: 'https://foreign.example' },
    { ...values, actorOrganizationId: '9223372036854775808' },
    { ...values, actorOrganizationId: 55 },
    { ...values, brokerSecret: 'short' },
    { ...values, destinyOrigin: 'https://public.example.test' },
    { ...values, destinyOrigin: `${values.destinyOrigin}/another-route` },
  ])
    expect(parseDealerVoltcredBridge(JSON.stringify(input))).toBeNull();
  expect(parseDealerVoltcredBridge(undefined)).toBeNull();
});

test('accepts an exact receipt only from the authenticated broker', () => {
  expect(parseTrustedVoltcredReceipt(values, `Bearer ${brokerSecret}`, incoming)).toEqual(incoming);
  for (const credential of [undefined, 'Bearer untrusted', `Basic ${brokerSecret}`]) {
    expect(parseTrustedVoltcredReceipt(values, credential, incoming)).toBeNull();
  }
  for (const body of [
    { ...incoming, applicant_email: 'fixture@example.test' },
    { ...incoming, state: 'referral' },
    { ...incoming, token: 'invalid' },
    { ...incoming, device: 'a; authorization=other' },
    { ...incoming, user_id: 333 },
  ])
    expect(parseTrustedVoltcredReceipt(values, `Bearer ${brokerSecret}`, body)).toBeNull();
});

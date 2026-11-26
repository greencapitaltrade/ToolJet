import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDealerOidcBroker } from '../../../../src/modules/dealer-onboarding/oidc-factory.ts';
const settings = {
  issuer: 'https://login.example/oidc',
  clientId: 'client',
  clientSecret: 'c'.repeat(32),
  organizationId: '55',
  redirectUri: 'https://app.example/callback',
  viewerUrl: 'https://app.example/view',
  thorOrigin: 'http://thor:8080',
  destinyOrigin: 'http://destiny:8080',
};
const env = () => ({
  TOOLJET_DEALER_VN_OIDC: JSON.stringify(settings),
  THOR_VN_DEALER_ENROLLMENT_SECRET: 's'.repeat(40),
});
const metadata = () => ({
  issuer: settings.issuer,
  authorization_endpoint: settings.issuer + '/auth',
  token_endpoint: settings.issuer + '/token',
  jwks_uri: settings.issuer + '/jwks',
});
const harness = () => {
  const calls = [];
  let resolve;
  const deps = {
    redis: {
      call: async (...args) => {
        calls.push(args);
        return 'OK';
      },
    },
    requestJson: async (url, options) => {
      calls.push([url, options]);
      return url.includes('well-known') ? metadata() : { sub: '42', organization_id: '55' };
    },
    createClient: (m, c) => {
      calls.push([m, c]);
      return {
        authorizationUrl: (p) => {
          resolve = p;
          return 'https://login.example/auth';
        },
        callback: async () => ({
          claims: () => ({ iss: settings.issuer, sub: '42', email_verified: true, email: 'x@example.com' }),
        }),
      };
    },
  };
  return { calls, deps };
};
test('constructs real broker with pinned metadata and registered subject lookup', async () => {
  const h = harness();
  const { broker, config } = await createDealerOidcBroker(env(), h.deps);
  assert.equal(config.organizationId, '55');
  const guest = 'a'.repeat(43);
  await broker.start('continue', guest);
  const set = h.calls.find((x) => x[0] === 'SET');
  const stateRecord = JSON.parse(set[2]);
  h.deps.redis.call = async (...args) => (args[0] === 'EVAL' ? JSON.stringify(stateRecord) : 'OK');
  await broker.callback({ state: 'b'.repeat(43), code: 'code' }, guest);
  const request = h.calls.find((x) => typeof x[0] === 'string' && x[0].includes('/oidc-subject/'));
  assert.equal(request[0], 'http://thor:8080/v1/users/oidc-subject/42');
  assert.equal(request[1].headers['x-gct-oidc-issuer'], settings.issuer);
  assert.equal(request[1].headers['x-gct-oidc-client-id'], settings.clientId);
});
test('rejects endpoint substitution and unsafe configuration', async () => {
  const h = harness();
  h.deps.requestJson = async () => ({ ...metadata(), token_endpoint: 'https://evil.example/token' });
  await assert.rejects(createDealerOidcBroker(env(), h.deps));
  for (const patch of [
    { issuer: 'https://login.example/oidc/' },
    { organizationId: '055' },
    { thorOrigin: 'http://user:pass@thor:8080' },
    { redirectUri: 'http://app.example/callback' },
  ]) {
    const e = env();
    e.TOOLJET_DEALER_VN_OIDC = JSON.stringify({ ...settings, ...patch });
    await assert.rejects(createDealerOidcBroker(e, harness().deps));
  }
});

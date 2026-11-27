import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { DealerOidcBroker } from '../../../../src/modules/dealer-onboarding/oidc-broker.ts';

const config = { issuer: 'https://thor.example/oidc', clientId: 'dealer-client', organizationId: '55', redirectUri: 'https://tooljet.example/callback', intentSecret: 'x'.repeat(40) };
const pending = new Map();
const store = { async put(k,v) { pending.set(k,v); }, async take(k) { const v = pending.get(k); pending.delete(k); return v; } };
const claims = { iss: config.issuer, sub: '333', email: 'dealer@example.test', email_verified: true };
let checks;
const client = { authorizationUrl: (p) => `https://thor.example/oidc/auth?${new URLSearchParams(p)}`, async callback(uri, params, options) { checks = {uri,params,options}; return { claims: () => claims }; } };
const resolve = async () => ({ sub: '333', organization_id: '55' });
const make = (resolver = resolve) => new DealerOidcBroker(config, store, client, resolver);

test('start signs a short-lived intent bound to PKCE state without leaking the referral', async () => {
 const broker = make(); const url = new URL(await broker.start('continuation'));
 const state = url.searchParams.get('state'); const intent = url.searchParams.get('enrollment_intent');
 const [payload, signature] = intent.split('.'); const data = JSON.parse(Buffer.from(payload, 'base64url'));
 assert.equal(signature, createHmac('sha256', config.intentSecret).update(payload).digest('base64url'));
 assert.equal(data.state_hash, createHash('sha256').update(state).digest('base64url'));
 assert.equal(data.purpose, 'vn_dealer_enrollment'); assert.equal(data.client_id, config.clientId);
 assert.ok(data.exp - data.iat <= 600); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
 assert.equal(url.searchParams.get('prompt'), 'login'); assert.ok(!url.href.includes('continuation'));
});

test('callback validates using OIDC client checks, resolves only authenticated subject, and consumes state', async () => {
 const broker = make(); const url = new URL(await broker.start('continuation')); const state = url.searchParams.get('state');
 assert.deepEqual(await broker.callback({ state, code: 'auth-code' }), { continuation: 'continuation', userId: '333', organizationId: '55', email: claims.email });
 assert.equal(checks.options.state, state); assert.ok(checks.options.nonce); assert.ok(checks.options.code_verifier);
 await assert.rejects(broker.callback({ state, code: 'auth-code' }));
});

test('rejects unverified email, wrong issuer and subject organization', async () => {
 for (const change of [{email_verified:false}, {iss:'https://other.example/oidc'}, {sub:'0'}]) {
  const broker = make(); const state = new URL(await broker.start('c')).searchParams.get('state');
  const old = {...claims}; Object.assign(claims, change); await assert.rejects(broker.callback({state, code:'code'})); Object.assign(claims, old);
 }
 const broker = make(async () => ({sub:'333', organization_id:'56'})); const state = new URL(await broker.start('c')).searchParams.get('state');
 await assert.rejects(broker.callback({state, code:'code'}));
});

test('Redis state is expiring, scoped, and consumed atomically', async () => {
 const { DealerOidcRedisStore } = await import('../../../../src/modules/dealer-onboarding/oidc-broker.ts');
 const calls = []; const redis = { async call(...args) { calls.push(args); return args[0] === 'SET' ? 'OK' : JSON.stringify({continuation:'c', nonce:'n', verifier:'v'}); } };
 const store = new DealerOidcRedisStore(redis, '55', 's'.repeat(40)); const state = 'a'.repeat(43);
 await store.put(state, {continuation:'c', nonce:'n', verifier:'v'}); await store.take(state);
 assert.equal(calls[0][0], 'SET'); assert.deepEqual(calls[0].slice(-3), ['EX','600','NX']);
 assert.equal(calls[1][0], 'EVAL'); assert.match(calls[1][1], /DEL/); assert.equal(calls[0][1], calls[1][3]);
 assert.ok(!calls[0][1].includes(state));
});

test('discovery endpoints stay under the configured issuer origin and path', async () => {
 const { dealerOidcEndpointAllowed } = await import('../../../../src/modules/dealer-onboarding/oidc-broker.ts');
 const issuer = 'https://thor.example/oidc';
 for (const endpoint of ['https://thor.example/oidc/auth', 'https://thor.example/oidc/token', 'https://thor.example/oidc/jwks'])
  assert.equal(dealerOidcEndpointAllowed(issuer, endpoint), true);
 for (const endpoint of ['https://evil.example/oidc/token', 'https://thor.example/oidc-evil/token', 'https://thor.example/oidc/../token', 'http://thor.example/oidc/token', 'https://user@thor.example/oidc/token', 'https://thor.example/oidc/token#fragment'])
  assert.equal(dealerOidcEndpointAllowed(issuer, endpoint), false);
 for (const endpoint of [undefined, null, 42, {}, { toString: () => 'https://thor.example/oidc/token' }])
  assert.equal(dealerOidcEndpointAllowed(issuer, endpoint), false);
});

test('passes the authorization response issuer to the native relying party for validation', async () => {
 const { Issuer } = await import('openid-client');
 const provider = new Issuer({ issuer: config.issuer, authorization_endpoint: `${config.issuer}/auth`, authorization_response_iss_parameter_supported: true });
 const nativeClient = new provider.Client({ client_id: config.clientId });
 nativeClient.grant = async () => { throw new Error('exchange reached'); };
 for (const issuer of ['https://wrong.example/oidc', undefined]) {
  const broker = new DealerOidcBroker(config, store, nativeClient, resolve);
  const state = new URL(await broker.start('c')).searchParams.get('state');
  await assert.rejects(broker.callback({ state, code: 'code', ...(issuer ? { iss: issuer } : {}) }), /issuer|iss/i);
 }
 const broker = new DealerOidcBroker(config, store, nativeClient, resolve);
 const state = new URL(await broker.start('c')).searchParams.get('state');
 await assert.rejects(broker.callback({ state, code: 'code', iss: config.issuer }), /exchange reached/);
 const optional = new Issuer({ issuer: config.issuer, authorization_endpoint: `${config.issuer}/auth` });
 const optionalClient = new optional.Client({ client_id: config.clientId });
 optionalClient.grant = nativeClient.grant;
 const optionalBroker = new DealerOidcBroker(config, store, optionalClient, resolve);
 const optionalState = new URL(await optionalBroker.start('c')).searchParams.get('state');
 await assert.rejects(optionalBroker.callback({ state: optionalState, code: 'code' }), /exchange reached/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { DealerOidcBroker } from '../../../../src/modules/dealer-onboarding/oidc-broker.ts';

const config = {
  issuer: 'https://thor.example/oidc',
  clientId: 'dealer-client',
  organizationId: '55',
  redirectUri: 'https://tooljet.example/callback',
  intentSecret: 'x'.repeat(40),
};
const guest = 'g'.repeat(43);
const pending = new Map();
const store = {
  async put(k, v) {
    pending.set(k, v);
  },
  async take(k, guestHash) {
    const v = pending.get(k);
    if (v?.guest !== guestHash) return null;
    pending.delete(k);
    return v;
  },
};
const claims = { iss: config.issuer, sub: '333', email: 'dealer@example.test', email_verified: true };
let checks;
const client = {
  authorizationUrl: (p) => `https://thor.example/oidc/auth?${new URLSearchParams(p)}`,
  async callback(uri, params, options) {
    checks = { uri, params, options };
    return { claims: () => claims };
  },
};
const resolve = async () => ({ sub: '333', organization_id: '55' });
const make = (resolver = resolve) => new DealerOidcBroker(config, store, client, resolver);

test('start signs a short-lived intent bound to PKCE state without leaking the referral', async () => {
  const broker = make();
  const url = new URL(await broker.start('continuation', guest));
  const state = url.searchParams.get('state');
  const intent = url.searchParams.get('enrollment_intent');
  const [payload, signature] = intent.split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(signature, createHmac('sha256', config.intentSecret).update(payload).digest('base64url'));
  assert.equal(data.state_hash, createHash('sha256').update(state).digest('base64url'));
  assert.equal(data.purpose, 'vn_dealer_enrollment');
  assert.equal(data.client_id, config.clientId);
  assert.deepEqual(Object.keys(data).sort(), ['client_id', 'exp', 'iat', 'jti', 'purpose', 'state_hash', 'v']);
  assert.ok(data.exp - data.iat <= 600);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('prompt'), 'login');
  assert.ok(!url.href.includes('continuation'));
});

test('callback validates using OIDC client checks, resolves only authenticated subject, and consumes state', async () => {
  const broker = make();
  const url = new URL(await broker.start('continuation', guest));
  const state = url.searchParams.get('state');
  assert.deepEqual(await broker.callback({ state, code: 'auth-code' }, guest), {
    continuation: 'continuation',
    userId: '333',
    organizationId: '55',
    email: claims.email,
  });
  assert.equal(checks.options.state, state);
  assert.ok(checks.options.nonce);
  assert.ok(checks.options.code_verifier);
  await assert.rejects(broker.callback({ state, code: 'auth-code' }, guest));
});

test('rejects unverified email, wrong issuer and subject organization', async () => {
  for (const change of [{ email_verified: false }, { iss: 'https://other.example/oidc' }, { sub: '0' }]) {
    const broker = make();
    const state = new URL(await broker.start('c', guest)).searchParams.get('state');
    const old = { ...claims };
    Object.assign(claims, change);
    await assert.rejects(broker.callback({ state, code: 'code' }, guest));
    Object.assign(claims, old);
  }
  const broker = make(async () => ({ sub: '333', organization_id: '56' }));
  const state = new URL(await broker.start('c', guest)).searchParams.get('state');
  await assert.rejects(broker.callback({ state, code: 'code' }, guest));
});

test('Redis state is expiring, scoped, and consumed atomically', async () => {
  const { DealerOidcRedisStore } = await import('../../../../src/modules/dealer-onboarding/oidc-broker.ts');
  const calls = [];
  const redis = {
    async call(...args) {
      calls.push(args);
      return args[0] === 'SET' ? 'OK' : JSON.stringify({ continuation: 'c', nonce: 'n', verifier: 'v', guest: 'g' });
    },
  };
  const store = new DealerOidcRedisStore(redis, '55', 's'.repeat(40));
  const state = 'a'.repeat(43);
  await store.put(state, { continuation: 'c', nonce: 'n', verifier: 'v', guest: 'g' });
  await store.take(state, 'g');
  assert.equal(calls[0][0], 'SET');
  assert.deepEqual(calls[0].slice(-3), ['EX', '600', 'NX']);
  assert.equal(calls[1][0], 'EVAL');
  assert.match(calls[1][1], /DEL/);
  assert.equal(calls[0][1], calls[1][3]);
  assert.ok(!calls[0][1].includes(state));
});

test('wrong guest cannot consume pending state, even with valid state and code', async () => {
  const records = new Map();
  const boundStore = {
    async put(k, v) {
      records.set(k, v);
    },
    async take(k, guest) {
      const v = records.get(k);
      if (v?.guest !== guest) return null;
      records.delete(k);
      return v;
    },
  };
  const broker = new DealerOidcBroker(config, boundStore, client, resolve);
  const state = new URL(await broker.start('continuation', guest)).searchParams.get('state');
  await assert.rejects(broker.callback({ state, code: 'code' }, 'h'.repeat(43)));
  assert.equal((await broker.callback({ state, code: 'code' }, guest)).userId, '333');
});

test('participant intent carries the eligibility commitment without exposing the token', async () => {
  const broker = make();
  let request;
  const url = new URL(
    await broker.startParticipant('continuation', guest, 'opaque-participant-token', async (jti, token) => {
      request = { jti, token };
      return 'a'.repeat(64);
    })
  );
  const [encoded, signature] = url.searchParams.get('enrollment_intent').split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url'));
  assert.deepEqual(Object.keys(payload).sort(), [
    'client_id',
    'exp',
    'iat',
    'issuer',
    'jti',
    'purpose',
    'recipient_commitment',
    'state_hash',
    'v',
  ]);
  assert.equal(signature, createHmac('sha256', config.intentSecret).update(encoded).digest('base64url'));
  assert.equal(payload.issuer, config.issuer);
  assert.equal(payload.purpose, 'vn_delegated_person_enrollment');
  assert.equal(payload.jti, request.jti);
  assert.equal(payload.recipient_commitment, 'a'.repeat(64));
  assert.equal(request.token, 'opaque-participant-token');
  assert.ok(!url.href.includes('opaque-participant-token'));
  await assert.rejects(broker.startParticipant('continuation', guest, 'token', async () => 'invalid'));
});

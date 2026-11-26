import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DealerViewerLogin } from '../../../../src/modules/dealer-onboarding/viewer-login.ts';

const scope = { origin: 'https://tooljet.example', organizationId: '185', lspSecret: 'x'.repeat(64) };
const referral = `${'a'.repeat(50)}`;
function fixture() {
  const records = new Map(); let n = 0; let pending;
  const sessions = {
    async start(_scope, state) { const id = String(++n).padStart(43, 'a'); records.set(id, state); return { id, key: id }; },
    key(_scope, id) { return records.has(id) ? id : undefined; },
    async get(key) { return records.get(key); },
    async rotate(_scope, key, state) { if (!records.has(key)) throw Error(); records.delete(key); return this.start(_scope, state); },
  };
  const broker = { async start(continuation) { pending = continuation; return 'https://thor.example/auth?state=' + 's'.repeat(43); },
    async callback() { return { continuation: pending, userId: '9', organizationId: '185', email: 'a@b.test' }; } };
  const calls = [];
  const fetcher = async (url, init) => { calls.push([url, init]); return Response.json({ organization_id: '185', eligible: true }); };
  return { login: new DealerViewerLogin(scope, 'http://destiny.default.svc.cluster.local', sessions, broker, fetcher), records, calls };
}
test('eligible referral is stored server-side and callback rotates into verified viewer', async () => {
  const { login, records, calls } = fixture();
  const start = await login.start(referral);
  assert.equal(calls[0][0], 'http://destiny.default.svc.cluster.local/v1/channel-partners/referrals/eligibility');
  assert.deepEqual(calls[0][1].headers, { 'content-type': 'application/json', 'x-gct-org-id': '185' });
  assert.deepEqual(JSON.parse(calls[0][1].body), { referral_token: referral });
  assert.equal(records.get(start.id).referral, referral);
  const completed = await login.callback({ state: 's'.repeat(43), code: 'code' }, start.id, 's'.repeat(43));
  assert.equal(records.has(start.id), false);
  assert.deepEqual(records.get(completed.id), { referral, userId: '9', organizationId: '185', email: 'a@b.test', emailVerified: true });
});
test('callback rejects state from a different browser before consuming broker state', async () => {
  const { login } = fixture(); const start = await login.start(referral);
  await assert.rejects(login.callback({ state: 's'.repeat(43), code: 'code' }, start.id, 't'.repeat(43)));
});
test('rejects an ineligible or cross-tenant referral before authorization', async () => {
  const { login } = fixture();
  await assert.rejects(login.start('bad'));
  const deny = new DealerViewerLogin(scope, 'http://destiny.default.svc.cluster.local', {}, {}, async () => Response.json({ organization_id: '186', eligible: true }));
  await assert.rejects(deny.start(referral));
});
test('requires the initiating guest and rejects a replay after rotation', async () => {
  const { login } = fixture(); const start = await login.start(referral);
  await assert.rejects(login.callback({ state: start.state, code: 'code' }, undefined, start.state));
  await login.callback({ state: start.state, code: 'code' }, start.id, start.state);
  await assert.rejects(login.callback({ state: start.state, code: 'code' }, start.id, start.state));
});
test('does not create viewer for a different organization', async () => {
  const sessions = { async start() { return { id: 'a'.repeat(43), key: 'key' }; }, key() { return 'key'; },
    async get() { return { referral }; }, async rotate() { assert.fail('must not rotate'); } };
  const broker = { async callback() { return { continuation: 'a'.repeat(43), userId: '9', organizationId: '186', email: 'a@b.test' }; } };
  const login = new DealerViewerLogin(scope, 'http://destiny.default.svc.cluster.local', sessions, broker);
  await assert.rejects(login.callback({ state: 's'.repeat(43), code: 'code' }, 'a'.repeat(43), 's'.repeat(43)));
});

test('director selector stays in the protected session through the existing broker', async () => {
  const { login, records } = fixture();
  const personToken = `${'b'.repeat(50)}`;
  const start = await login.start(referral, personToken);
  assert.equal(records.get(start.id).personToken, personToken);
  const completed = await login.callback({ state: start.state, code: 'code' }, start.id, start.state);
  assert.equal(records.get(completed.id).personToken, personToken);
  await assert.rejects(login.start(referral, 'bad'));
});

test('accepts configured tenants while rejecting cross-tenant referrals and actors', async () => {
  for (const organizationId of ['731', '942']) {
    const tenantScope = { ...scope, organizationId };
    const sessions = { async start(_scope, state) { this.state = state; return { id: 'a'.repeat(43), key: 'key' }; }, key() { return 'key'; }, async get() { return this.state; }, async rotate(_scope, _key, state) { this.state = state; return { id: 'b'.repeat(43) }; } };
    const broker = { async start() { return 'https://thor.example/auth?state=' + 's'.repeat(43); }, async callback() { return { continuation: 'a'.repeat(43), userId: '9', organizationId, email: 'a@b.test' }; } };
    const login = new DealerViewerLogin(tenantScope, 'http://destiny.default.svc.cluster.local', sessions, broker, async () => Response.json({ organization_id: organizationId, eligible: true }));
    const start = await login.start(referral);
    await login.callback({ state: start.state, code: 'code' }, start.id, start.state);
    assert.equal(sessions.state.organizationId, organizationId);
    const other = organizationId === '731' ? '942' : '731';
    const denied = new DealerViewerLogin(tenantScope, 'http://destiny.default.svc.cluster.local', sessions, broker, async () => Response.json({ organization_id: other, eligible: true }));
    await assert.rejects(denied.start(referral));
    broker.callback = async () => ({ continuation: 'a'.repeat(43), userId: '9', organizationId: other, email: 'a@b.test' });
    await assert.rejects(login.callback({ state: start.state, code: 'code' }, start.id, start.state));
  }
});
test('accepts bounded unversioned tokens and rejects prefixed or malformed tokens', async () => {
  const { login } = fixture();
  for (const token of ['a'.repeat(39), 'a'.repeat(1021)]) await login.start(token);
  for (const token of ['a'.repeat(38), 'a'.repeat(1022), `v3.${'a'.repeat(40)}`, `${'a'.repeat(39)}=`]) await assert.rejects(login.start(token));
});

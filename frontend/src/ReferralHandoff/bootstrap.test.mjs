import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const source = await readFile(new URL('./bootstrap.js', import.meta.url), 'utf8');
const { captureReferralHandoff, getReferralHandoff } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const token = `v3.${'a'.repeat(39)}`;
function browser(path) {
  const data = new Map();
  const location = new URL(`https://example.test${path}`);
  const win = { location, sessionStorage: { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }, history: { state: null, replaceState: (_s,_t,u) => { const next = new URL(u); location.href = next.href; } } };
  return win;
}
test('captures one query value, strips it and retains unrelated URL components', () => {
  const w = browser(`/applications/app/dealer-intake?version=qa&tooljet_referral=1&onboarding=${token}#section`);
  captureReferralHandoff(w, 1000);
  assert.equal(w.location.search, '?version=qa'); assert.equal(w.location.hash, '#section');
  assert.deepEqual(getReferralHandoff(w, 1001), { status: 'accepted', token });
  w.location.pathname = '/applications/other/dealer-intake';
  assert.equal(getReferralHandoff(w, 1001).status, 'missing');
});
test('rejects duplicates including query and fragment, and clears previous state', () => {
  const w = browser(`/applications/app/dealer-intake?tooljet_referral=1&onboarding=${token}`); captureReferralHandoff(w, 1000);
  w.location.href = `https://example.test/applications/app/dealer-intake?tooljet_referral=1&onboarding=${token}#onboarding=${token}&keep=yes`;
  captureReferralHandoff(w, 1001);
  assert.equal(getReferralHandoff(w, 1002).status, 'invalid');
  assert.equal(w.location.search, ''); assert.equal(w.location.hash, '#keep=yes');
});
test('rejects malformed, fragment-only, and expired values', () => {
  for (const suffix of ['?tooljet_referral=1&onboarding=bad', `?tooljet_referral=1#onboarding=${token}`]) {
    const w = browser(`/applications/app/dealer-intake${suffix}`); captureReferralHandoff(w, 1000);
    assert.equal(getReferralHandoff(w, 1001).status, 'invalid');
  }
  const w = browser(`/applications/app/dealer-intake?tooljet_referral=1&onboarding=${token}`); captureReferralHandoff(w, 1000);
  assert.equal(getReferralHandoff(w, 1000 + 15 * 60 * 1000 + 1).status, 'invalid');
});
test('leaves unrelated paths and URLs untouched', () => {
  const w = browser(`/login?tooljet_referral=1&onboarding=${token}#callback`); const href = w.location.href;
  captureReferralHandoff(w, 1000); assert.equal(w.location.href, href);
});
test('clear requires the accepted token and current bound path', async () => {
  const { clearReferralHandoff } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const w = browser(`/applications/app/dealer-intake?tooljet_referral=1&onboarding=${token}`); captureReferralHandoff(w, 1000);
  assert.equal(clearReferralHandoff('wrong', w, 1001), false);
  w.location.pathname = '/applications/other';
  assert.equal(clearReferralHandoff(token, w, 1001), false);
  w.location.pathname = '/applications/app/dealer-intake';
  assert.equal(clearReferralHandoff(token, w, 1001), true);
  assert.equal(getReferralHandoff(w, 1001).status, 'missing');
});

test('unmarked onboarding URL remains untouched but invalidates an earlier handoff on the same path', () => {
  const w = browser(`/applications/app/dealer-intake?tooljet_referral=1&onboarding=${token}`); captureReferralHandoff(w, 1000);
  w.location.href = `https://example.test/applications/app/dealer-intake?onboarding=legacy#onboarding=old`;
  const href = w.location.href; captureReferralHandoff(w, 1001);
  assert.equal(w.location.href, href); assert.deepEqual(getReferralHandoff(w, 1002), { status: 'invalid' });
});
test('rejects invalid or ambiguous markers and removes both sensitive parameters', () => {
  for (const marker of ['tooljet_referral=0', 'tooljet_referral=1&tooljet_referral=1', 'tooljet_referral=1#tooljet_referral=1']) {
    const w = browser(`/applications/app/dealer-intake?onboarding=${token}&${marker}`); captureReferralHandoff(w, 1000);
    assert.equal(getReferralHandoff(w, 1001).status, 'invalid');
    assert.equal(w.location.searchParams.has('tooljet_referral'), false); assert.equal(w.location.searchParams.has('onboarding'), false);
  }
});

test('unavailable and corrupt storage fail closed for the current viewer path', () => {
  const w = browser(`/applications/app/dealer-intake?onboarding=legacy`);
  w.sessionStorage.getItem = () => { throw new Error('unavailable'); };
  captureReferralHandoff(w, 1000);
  assert.deepEqual(getReferralHandoff(w, 1001), { status: 'invalid' });
  const corrupt = browser('/applications/app/dealer-intake');
  corrupt.sessionStorage.setItem('tj_referral_handoff', '{bad');
  assert.deepEqual(getReferralHandoff(corrupt, 1001), { status: 'invalid' });
});
test('history replacement failure fails closed', () => {
  const w = browser(`/applications/app/dealer-intake?tooljet_referral=1&onboarding=${token}`);
  w.history.replaceState = () => { throw new Error('unavailable'); };
  assert.doesNotThrow(() => captureReferralHandoff(w, 1000));
  assert.deepEqual(getReferralHandoff(w, 1001), { status: 'invalid' });
});

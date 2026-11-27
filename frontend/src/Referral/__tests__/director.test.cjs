const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureToolJetReferral } = require('../bootstrap');
const referral = `${'a'.repeat(50)}`;
const personToken = `${'b'.repeat(50)}`;
test('leaves unmarked borrower onboarding in query and fragment for its reader', () => {
  for (const suffix of [`?onboarding=${referral}&keep=1`, `#onboarding=${referral}&keep=1`]) {
    const href = `https://example.test/applications/borrower${suffix}`;
    let replaced = false;
    const win = { location: { href }, history: { state: null, replaceState() { replaced = true; } } };
    captureToolJetReferral(win);
    assert.deepEqual(win.getToolJetReferralHandoff(), { status: 'missing' });
    assert.equal(replaced, false);
    assert.equal(win.location.href, href);
  }
});
test('rejects and scrubs dealer markers or selectors in a fragment', () => {
  for (const key of ['tooljet_referral', 'person_kyc']) {
    let scrubbed;
    const win = { location: { href: `https://example.test/applications/dealer?onboarding=${referral}#${key}=bad&keep=1` }, history: { state: null, replaceState(_state, _title, url) { scrubbed = url; } } };
    captureToolJetReferral(win);
    assert.deepEqual(win.getToolJetReferralHandoff(), { status: 'invalid' });
    assert.equal(scrubbed, 'https://example.test/applications/dealer#keep=1');
  }
});
test('captures native director link in memory and scrubs both selectors', () => {
  let scrubbed;
  const win = { location: { href: `https://example.test/applications/dealer?onboarding=${referral}&person_kyc=${personToken}&keep=1` }, history: { state: null, replaceState(_state, _title, url) { scrubbed = url; } } };
  captureToolJetReferral(win);
  assert.deepEqual(win.getToolJetReferralHandoff(), { status: 'accepted', token: referral, personToken });
  assert.equal(scrubbed, 'https://example.test/applications/dealer?keep=1');
  assert.equal(win.clearToolJetReferralHandoff(referral), true);
  assert.deepEqual(win.getToolJetReferralHandoff(), { status: 'missing' });
});
test('rejects duplicated director selectors and scrubs fragments', () => {
  let scrubbed;
  const win = { location: { href: `https://example.test/applications/dealer?onboarding=${referral}&person_kyc=${personToken}&person_kyc=${personToken}#person_kyc=bad` }, history: { state: null, replaceState(_state, _title, url) { scrubbed = url; } } };
  captureToolJetReferral(win);
  assert.deepEqual(win.getToolJetReferralHandoff(), { status: 'invalid' });
  assert.equal(scrubbed, 'https://example.test/applications/dealer');
});
test('rejects versioned or malformed native selectors and scrubs them', () => {
  for (const token of [`v3.${referral}`, 'a'.repeat(38), 'a'.repeat(1022), `${referral}=`]) {
    let scrubbed;
    const win = { location: { href: `https://example.test/applications/dealer?onboarding=${referral}&person_kyc=${encodeURIComponent(token)}` }, history: { state: null, replaceState(_state, _title, url) { scrubbed = url; } } };
    captureToolJetReferral(win);
    assert.deepEqual(win.getToolJetReferralHandoff(), { status: 'invalid' });
    assert.equal(scrubbed, 'https://example.test/applications/dealer');
  }
});

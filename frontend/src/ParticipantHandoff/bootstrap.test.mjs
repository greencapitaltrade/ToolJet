import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8');
const { captureParticipantHandoff, getParticipantHandoff, clearParticipantHandoff } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);
const token = 'v3.' + 'A'.repeat(40);
function browser(query) {
  const data = new Map();
  const w = {
    location: new URL('https://example.test/applications/dealer' + query),
    sessionStorage: {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    },
    history: {
      state: null,
      replaceState(_s, _t, u) {
        w.location = new URL(u);
      },
    },
  };
  return w;
}
test('captures participant once, scrubs before other work, and clears only matching token', () => {
  const w = browser('?keep=1&participant=' + token);
  captureParticipantHandoff(w, 1000);
  assert.equal(w.location.search, '?keep=1');
  assert.deepEqual(getParticipantHandoff(w, 1001), { status: 'accepted', token });
  assert.equal(clearParticipantHandoff('wrong', w, 1001), false);
  assert.equal(clearParticipantHandoff(token, w, 1001), true);
  assert.equal(getParticipantHandoff(w, 1001).status, 'missing');
});
test('scrubs and rejects duplicate, malformed, mixed and fragment invitations', () => {
  for (const suffix of [
    '?participant=' + token + '&participant=' + token,
    '?participant=bad',
    '?participant=' + token + '&tooljet_referral=1&onboarding=' + token,
    '#participant=' + token,
  ]) {
    const w = browser(suffix);
    captureParticipantHandoff(w, 1000);
    assert.equal(getParticipantHandoff(w, 1001).status, 'invalid');
    assert.equal(w.location.href.includes('participant='), false);
  }
});
test('expired invitations fail closed', () => {
  const w = browser('?participant=' + token);
  captureParticipantHandoff(w, 1000);
  assert.equal(getParticipantHandoff(w, 1000 + 900001).status, 'invalid');
});

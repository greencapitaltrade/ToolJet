import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8');
const { captureSignerHandoff, getSignerHandoff, clearSignerHandoff } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);
const token = 'v3.' + 'A'.repeat(40);
function browser(suffix) {
  const data = new Map();
  const w = {
    location: new URL('https://example.test/applications/dealer' + suffix),
    sessionStorage: {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    },
    history: {
      state: null,
      replaceState(_s, _t, u) { w.location = new URL(u); },
    },
  };
  return w;
}

test('captures and scrubs the signer token, binds it to the path, and clears only a matching token', () => {
  const w = browser('?keep=1&signing=' + token);
  captureSignerHandoff(w, 1000);
  assert.equal(w.location.search, '?keep=1');
  assert.deepEqual(getSignerHandoff(w, 1001), { status: 'accepted', token });
  w.location = new URL('https://example.test/applications/other');
  assert.equal(getSignerHandoff(w, 1001).status, 'missing');
  w.location = new URL('https://example.test/applications/dealer');
  assert.equal(clearSignerHandoff('wrong', w, 1001), false);
  assert.equal(clearSignerHandoff(token, w, 1001), true);
  assert.equal(getSignerHandoff(w, 1001).status, 'missing');
});

test('rejects and scrubs duplicate, malformed, mixed and fragment invitations', () => {
  for (const suffix of [
    '?signing=' + token + '&signing=' + token,
    '?signing=bad',
    '?signing=' + token + '&participant=' + token,
    '?signing=' + token + '&tooljet_referral=1&onboarding=' + token,
    '#signing=' + token,
  ]) {
    const w = browser(suffix);
    captureSignerHandoff(w, 1000);
    assert.equal(getSignerHandoff(w, 1001).status, 'invalid');
    assert.equal(w.location.href.includes('signing='), false);
  }
});

test('expired invitations fail closed and non-viewer paths are ignored', () => {
  const w = browser('?signing=' + token);
  captureSignerHandoff(w, 1000);
  assert.equal(getSignerHandoff(w, 1000 + 900000).status, 'invalid');
  const login = browser('');
  login.location = new URL('https://example.test/login?signing=' + token);
  captureSignerHandoff(login, 1000);
  assert.equal(getSignerHandoff(login, 1001).status, 'missing');
  assert.equal(login.location.search, '?signing=' + token);
});

test('the initial coordinator rejects signer invitations mixed with other roles', async () => {
  const src = new URL('../', import.meta.url);
  const dataUrl = (path) => `data:text/javascript;base64,${Buffer.from(fs.readFileSync(new URL(path, src))).toString('base64')}`;
  let coordinator = fs.readFileSync(new URL('handoff-bootstrap.js', src), 'utf8');
  for (const path of ['./McpOAuth/bootstrap', './SignerHandoff/bootstrap', './ParticipantHandoff/bootstrap', './ReferralHandoff/bootstrap']) {
    coordinator = coordinator.replace(`'${path}'`, `'${dataUrl(path + '.js')}'`);
  }
  const entry = fs.readFileSync(new URL('index.jsx', src), 'utf8');
  assert.match(entry, /^import ['"]\.\/handoff-bootstrap['"];?/);
  for (const suffix of [
    '?signing=' + token + '&participant=' + token,
    '?signing=' + token + '&tooljet_referral=1&onboarding=' + token,
  ]) {
    const w = browser(suffix);
    globalThis.window = w;
    try {
      await import(`data:text/javascript;base64,${Buffer.from(coordinator + '\n//' + suffix).toString('base64')}`);
      assert.equal(w.getToolJetSignerHandoff().status, 'invalid');
      assert.equal(w.location.href.includes('signing='), false);
    } finally {
      delete globalThis.window;
    }
  }
});

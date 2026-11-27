const { captureToolJetReferral } = require('../bootstrap');

const token = `${'a'.repeat(39)}`;
const browser = (url, replaceState) => ({
  location: { href: url },
  history: { state: { existing: true }, replaceState: replaceState || jest.fn() },
});

test('captures and scrubs a valid application referral in memory', () => {
  const win = browser(`https://example.test/applications/dealer?keep=yes&tooljet_referral=1&onboarding=${token}#view=1`);
  captureToolJetReferral(win);
  expect(win.getToolJetReferralHandoff()).toEqual({ status: 'accepted', token });
  expect(win.history.replaceState).toHaveBeenCalledWith(win.history.state, '', 'https://example.test/applications/dealer?keep=yes#view=1');
  expect(win.clearToolJetReferralHandoff('wrong')).toBe(false);
  expect(win.clearToolJetReferralHandoff(token)).toBe(true);
  expect(win.getToolJetReferralHandoff()).toEqual({ status: 'missing' });
});

test.each([
  `tooljet_referral=1&tooljet_referral=1&onboarding=${token}`,
  `tooljet_referral=1&onboarding=${token}&onboarding=${token}`,
  `tooljet_referral=0&onboarding=${token}`,
  'tooljet_referral=1&onboarding=bad',
])('rejects and scrubs malformed referral %s', (query) => {
  const win = browser(`https://example.test/applications/dealer?${query}#keep=1`);
  captureToolJetReferral(win);
  expect(win.getToolJetReferralHandoff()).toEqual({ status: 'invalid' });
  expect(win.history.replaceState).toHaveBeenCalledWith(win.history.state, '', 'https://example.test/applications/dealer#keep=1');
});

test('leaves unrelated and login routes untouched', () => {
  for (const path of ['/other', '/applications/dealer/login']) {
    const win = browser(`https://example.test${path}?tooljet_referral=1&onboarding=${token}`);
    captureToolJetReferral(win);
    expect(win.getToolJetReferralHandoff()).toEqual({ status: 'missing' });
    expect(win.history.replaceState).not.toHaveBeenCalled();
  }
});

test('fails closed when the address cannot be scrubbed', () => {
  const win = browser(`https://example.test/applications/dealer?tooljet_referral=1&onboarding=${token}`, () => { throw new Error('blocked'); });
  captureToolJetReferral(win);
  expect(win.getToolJetReferralHandoff()).toEqual({ status: 'invalid' });
});

test('rejects and scrubs referral values in the fragment', () => {
  const win = browser(`https://example.test/applications/dealer?tooljet_referral=1&onboarding=${token}#onboarding=bad&keep=1`);
  captureToolJetReferral(win);
  expect(win.getToolJetReferralHandoff()).toEqual({ status: 'invalid' });
  expect(win.history.replaceState).toHaveBeenCalledWith(win.history.state, '', 'https://example.test/applications/dealer#keep=1');
});

// Capture before URL consumers run; the handoff is retained only in page memory.
const captureToolJetReferral = (win) => {
  const url = new URL(win.location.href);
  let handoff = { status: 'missing' };
  win.getToolJetReferralHandoff = () => ({ ...handoff });
  win.clearToolJetReferralHandoff = (token) => {
    if (handoff.status !== 'accepted' || handoff.token !== token) return false;
    handoff = { status: 'missing' };
    return true;
  };

  if (!/(?:^|\/)applications\/[^/]+(?:\/[^/]+)*\/?$/.test(url.pathname) || /\/login\/?$/.test(url.pathname)) return;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const markers = url.searchParams.getAll('tooljet_referral');
  const values = url.searchParams.getAll('onboarding');
  const persons = url.searchParams.getAll('person_kyc');
  if (!markers.length && !persons.length && !fragment.has('tooljet_referral') && !fragment.has('person_kyc')) return;

  const valid = ((markers.length === 1 && markers[0] === '1' && persons.length === 0) ||
    (markers.length === 0 && persons.length === 1 && /^[A-Za-z0-9_-]{39,1021}$/.test(persons[0]))) && values.length === 1 &&
    /^[A-Za-z0-9_-]{39,1021}$/.test(values[0]) &&
    !fragment.has('onboarding') && !fragment.has('tooljet_referral') && !fragment.has('person_kyc');
  handoff = valid ? { status: 'accepted', token: values[0], ...(persons.length ? { personToken: persons[0] } : {}) } : { status: 'invalid' };
  url.searchParams.delete('person_kyc');
  fragment.delete('person_kyc');
  url.searchParams.delete('onboarding');
  url.searchParams.delete('tooljet_referral');
  fragment.delete('onboarding');
  fragment.delete('tooljet_referral');
  url.hash = fragment.toString();
  try {
    win.history.replaceState(win.history.state, '', url.href);
  } catch {
    handoff = { status: 'invalid' };
  }
};

module.exports = { captureToolJetReferral };

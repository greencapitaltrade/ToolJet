const KEY = 'tj_referral_handoff';
const LIFETIME_MS = 15 * 60 * 1000;
const failedPaths = new WeakMap();
const TOKEN = /^v3[.][A-Za-z0-9_-]{39,1021}$/;

// Only viewer URLs participate. In particular, don't interpret OAuth callback fragments.
const isViewerPath = (path) => /(?:^|\/)applications\/[^/]+(?:\/[^/]+)*\/?$/.test(path) && !/\/login\/?$/.test(path);

export function captureReferralHandoff(win = window, now = Date.now()) {
  const url = new URL(win.location.href);
  if (!isViewerPath(url.pathname)) return;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const markers = url.searchParams.getAll('tooljet_referral');
  if (!markers.length) {
    if (url.searchParams.has('onboarding') || fragment.has('onboarding')) {
      try {
        const value = JSON.parse(win.sessionStorage.getItem(KEY) || 'null');
        if (value && value.path === url.pathname) {
          win.sessionStorage.setItem(KEY, JSON.stringify({ path: url.pathname, status: 'invalid' }));
        }
      } catch {
        failedPaths.set(win, url.pathname);
      }
    }
    return;
  }
  const fragmentMarkers = fragment.getAll('tooljet_referral');
  const queryValues = url.searchParams.getAll('onboarding');
  const fragmentValues = fragment.getAll('onboarding');

  const accepted = markers.length === 1 && markers[0] === '1' && fragmentMarkers.length === 0 && queryValues.length === 1 && fragmentValues.length === 0 && TOKEN.test(queryValues[0]);
  // Clear old state even if a new link is malformed or storage is unavailable.
  failedPaths.set(win, url.pathname);
  try {
    win.sessionStorage.removeItem(KEY);
    win.sessionStorage.setItem(KEY, JSON.stringify({
      path: url.pathname,
      expires: now + LIFETIME_MS,
      status: accepted ? 'accepted' : 'invalid',
      ...(accepted ? { token: queryValues[0] } : {}),
    }));
    failedPaths.delete(win);
  } catch {
    // Unavailable tab storage means the invitation cannot be resumed safely.
  }
  url.searchParams.delete('onboarding');
  url.searchParams.delete('tooljet_referral');
  if (fragmentValues.length || fragmentMarkers.length) {
    fragment.delete('tooljet_referral');
    fragment.delete('onboarding');
    url.hash = fragment.toString();
  }
  try {
    win.history.replaceState(win.history.state, '', url);
  } catch {
    failedPaths.set(win, url.pathname);
    try {
      win.sessionStorage.setItem(KEY, JSON.stringify({ path: url.pathname, status: 'invalid' }));
    } catch {
      // The in-memory marker still blocks this document.
    }
  }
}

export function getReferralHandoff(win = window, now = Date.now()) {
  if (failedPaths.get(win) === win.location.pathname) return { status: 'invalid' };
  try {
    const raw = win.sessionStorage.getItem(KEY);
    if (raw === null) return { status: 'missing' };
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || typeof value.path !== 'string') return { status: 'invalid' };
    if (value.path !== win.location.pathname) return { status: 'missing' };
    if (!Number.isFinite(value.expires) || value.expires <= now || value.expires > now + LIFETIME_MS) {
      // Retain only a non-secret invalid marker so the app cannot resume an old draft.
      win.sessionStorage.setItem(KEY, JSON.stringify({ path: value.path, status: 'invalid' }));
      return { status: 'invalid' };
    }
    if (value.status === 'invalid') return { status: 'invalid' };
    if (value.status === 'accepted' && TOKEN.test(value.token || '')) return { status: 'accepted', token: value.token };
  } catch {
    // Malformed or unavailable storage cannot safely resume a previous draft.
    return { status: 'invalid' };
  }
  return { status: 'invalid' };
}

export function clearReferralHandoff(token, win = window, now = Date.now()) {
  const value = getReferralHandoff(win, now);
  if (value.status !== 'accepted' || value.token !== token) return false;
  try {
    win.sessionStorage.removeItem(KEY);
    return true;
  } catch {
    failedPaths.set(win, win.location.pathname);
    return false;
  }
}

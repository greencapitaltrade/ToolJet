const KEY = 'tj_signer_handoff';
const LIFETIME_MS = 15 * 60 * 1000;
const TOKEN = /^v3[.][A-Za-z0-9_-]{39,1021}$/;
const failedPaths = new WeakMap();
const isViewerPath = (path) => /(?:^|\/)applications\/[^/]+(?:\/[^/]+)*\/?$/.test(path) && !/\/login\/?$/.test(path);

export function captureSignerHandoff(win = window, now = Date.now()) {
  const url = new URL(win.location.href);
  if (!isViewerPath(url.pathname)) return;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const values = url.searchParams.getAll('signing');
  const fragments = fragment.getAll('signing');
  if (!values.length && !fragments.length) return;
  const accepted =
    values.length === 1 &&
    !fragments.length &&
    TOKEN.test(values[0]) &&
    !url.searchParams.has('participant') && !fragment.has('participant') &&
    !url.searchParams.has('onboarding') &&
    !url.searchParams.has('tooljet_referral') &&
    !fragment.has('onboarding') &&
    !fragment.has('tooljet_referral');
  failedPaths.set(win, url.pathname);
  try {
    win.sessionStorage.removeItem(KEY);
    win.sessionStorage.setItem(
      KEY,
      JSON.stringify({
        path: url.pathname,
        expires: now + LIFETIME_MS,
        status: accepted ? 'accepted' : 'invalid',
        ...(accepted && { token: values[0] }),
      })
    );
    failedPaths.delete(win);
  } catch {
    /* Fail closed when storage is unavailable. */
  }
  url.searchParams.delete('signing');
  if (fragments.length) {
    fragment.delete('signing');
    url.hash = fragment.toString();
  }
  try {
    win.history.replaceState(win.history.state, '', url);
  } catch {
    failedPaths.set(win, url.pathname);
    try {
      win.sessionStorage.removeItem(KEY);
    } catch {}
  }
}
export function getSignerHandoff(win = window, now = Date.now()) {
  if (failedPaths.get(win) === win.location.pathname) return { status: 'invalid' };
  try {
    const raw = win.sessionStorage.getItem(KEY);
    if (raw === null) return { status: 'missing' };
    const value = JSON.parse(raw);
    if (!value || typeof value.path !== 'string') return { status: 'invalid' };
    if (value.path !== win.location.pathname) return { status: 'missing' };
    if (!Number.isFinite(value.expires) || value.expires <= now || value.expires > now + LIFETIME_MS) {
      win.sessionStorage.setItem(KEY, JSON.stringify({ path: value.path, status: 'invalid' }));
      return { status: 'invalid' };
    }
    if (value.status === 'accepted' && TOKEN.test(value.token || '')) return { status: 'accepted', token: value.token };
  } catch {
    return { status: 'invalid' };
  }
  return { status: 'invalid' };
}
export function clearSignerHandoff(token, win = window, now = Date.now()) {
  const value = getSignerHandoff(win, now);
  if (value.status !== 'accepted' || value.token !== token) return false;
  try {
    win.sessionStorage.removeItem(KEY);
    return true;
  } catch {
    failedPaths.set(win, win.location.pathname);
    return false;
  }
}

import { getSubpath } from '@/_helpers/routes';

export function isConfiguredOidcEnabled(organizationId) {
  const workspaceId = window.public_config?.CONFIGURED_OIDC_WORKSPACE_ID;
  return Boolean(workspaceId && (!organizationId || organizationId === workspaceId));
}

export function startConfiguredOidc(redirectTo) {
  const root = getSubpath() ?? '';
  const url = new URL(`${root}/api/oauth/oidc/start`, window.public_config?.TOOLJET_HOST || window.location.origin);
  if (redirectTo?.startsWith('/applications/')) {
    url.searchParams.set('returnTo', `${root}${redirectTo}`);
  } else if (root && redirectTo?.startsWith(`${root}/applications/`)) {
    url.searchParams.set('returnTo', redirectTo);
  }
  window.location.assign(url);
}

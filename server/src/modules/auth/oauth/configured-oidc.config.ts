import { validate as isUuid } from 'uuid';

export type OidcIdentity = { issuer: string; sub: string; clientId: string };

export type ConfiguredOidcSettings = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  workspaceId: string;
  origin: string;
  subpath: string;
  redirectUri: string;
};

type ConnectorSettings = Pick<ConfiguredOidcSettings, 'issuer' | 'clientId' | 'clientSecret' | 'workspaceId'>;

export function isHttpsUrl(value?: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function readManagedConnector(value: string, env: NodeJS.ProcessEnv): ConnectorSettings | null {
  try {
    const mapping: unknown = JSON.parse(value);
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return null;
    const entries = Object.entries(mapping);
    // Keep the existing single-workspace start and callback contract in this rollout.
    if (entries.length !== 1) return null;
    const [[workspaceId, entry]] = entries;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 3) return null;
    const { issuer, clientId, clientSecretEnv } = entry as Record<string, unknown>;
    if (
      typeof issuer !== 'string' ||
      typeof clientId !== 'string' ||
      typeof clientSecretEnv !== 'string' ||
      !/^TOOLJET_OIDC_CLIENT_SECRET(?:_[A-Z0-9_]+)?$/.test(clientSecretEnv)
    ) {
      return null;
    }
    return { issuer, clientId, workspaceId, clientSecret: env[clientSecretEnv] };
  } catch {
    return null;
  }
}

export function getConfiguredOidcSettings(env = process.env): ConfiguredOidcSettings | null {
  const {
    TOOLJET_EDITION = 'ce',
    TOOLJET_OIDC_ISSUER: legacyIssuer,
    TOOLJET_OIDC_CLIENT_ID: legacyClientId,
    TOOLJET_OIDC_CLIENT_SECRET: legacyClientSecret,
    TOOLJET_OIDC_WORKSPACE_ID: legacyWorkspaceId,
    TOOLJET_OIDC_CONNECTORS: mapping,
    TOOLJET_HOST: host,
    SUB_PATH: rawSubpath = '',
  } = env;

  if (TOOLJET_EDITION.toLowerCase() !== 'ce') return null;
  const connector =
    mapping === undefined
      ? {
          issuer: legacyIssuer,
          clientId: legacyClientId,
          clientSecret: legacyClientSecret,
          workspaceId: legacyWorkspaceId,
        }
      : readManagedConnector(mapping, env);
  if (!connector) return null;

  const { issuer, clientId, clientSecret, workspaceId } = connector;
  if (
    mapping !== undefined &&
    (legacyIssuer !== undefined || legacyClientId !== undefined || legacyWorkspaceId !== undefined) &&
    (issuer !== legacyIssuer ||
      clientId !== legacyClientId ||
      clientSecret !== legacyClientSecret ||
      workspaceId.toLowerCase() !== legacyWorkspaceId?.toLowerCase())
  ) {
    return null;
  }

  if (
    !isHttpsUrl(issuer) ||
    new URL(issuer).search ||
    !clientId ||
    !clientSecret ||
    !isUuid(workspaceId) ||
    !isHttpsUrl(host)
  ) {
    return null;
  }
  const base = new URL(host);
  if (base.pathname !== '/' || base.search || (rawSubpath && !/^\/(?:[\w-]+\/)*$/.test(rawSubpath))) {
    return null;
  }
  const subpath = rawSubpath.replace(/\/$/, '');
  return {
    issuer,
    clientId,
    clientSecret,
    workspaceId: workspaceId.toLowerCase(),
    origin: base.origin,
    subpath,
    redirectUri: `${base.origin}${subpath}/api/oauth/oidc/callback`,
  };
}

export function assertConfiguredOidcSettings(env = process.env): void {
  if (
    (env.TOOLJET_EDITION ?? 'ce').toLowerCase() === 'ce' &&
    env.TOOLJET_OIDC_CONNECTORS !== undefined &&
    !getConfiguredOidcSettings(env)
  ) {
    throw new Error('Invalid TOOLJET_OIDC_CONNECTORS configuration');
  }
}

export function oidcReturnPath(value: unknown, settings: ConfiguredOidcSettings): string {
  const fallback = `${settings.subpath}/`;
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\')) return fallback;
  if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fallback;

  try {
    const url = new URL(value, settings.origin);
    if (url.origin === settings.origin && url.pathname.startsWith(`${settings.subpath}/applications/`)) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

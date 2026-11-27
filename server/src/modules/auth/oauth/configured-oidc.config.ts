import { validate as isUuid } from 'uuid';

export type OidcIdentity = { issuer: string; sub: string; clientId: string; revision?: string };

export type ConfiguredOidcSettings = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  workspaceId: string;
  origin: string;
  subpath: string;
  redirectUri: string;
};

type OidcLocation = Pick<ConfiguredOidcSettings, 'origin' | 'subpath' | 'redirectUri'>;

export function isHttpsUrl(value?: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function isCommunityEdition(env: NodeJS.ProcessEnv) {
  return (env.TOOLJET_EDITION ?? 'ce').toLowerCase() === 'ce';
}

export function getConfiguredOidcLocation(env = process.env): OidcLocation | null {
  const { TOOLJET_HOST: host, SUB_PATH: rawSubpath = '' } = env;
  if (!isHttpsUrl(host)) return null;
  const base = new URL(host);
  if (base.pathname !== '/' || base.search || (rawSubpath && !/^\/(?:[\w-]+\/)*$/.test(rawSubpath))) return null;
  const subpath = rawSubpath.replace(/\/$/, '');
  return {
    origin: base.origin,
    subpath,
    redirectUri: `${base.origin}${subpath}/api/oauth/oidc/callback`,
  };
}

// The existing deployment-wide registration is the default only for the legacy launch URL.
export function getConfiguredOidcSettings(env = process.env): ConfiguredOidcSettings | null {
  const {
    TOOLJET_OIDC_ISSUER: issuer,
    TOOLJET_OIDC_CLIENT_ID: clientId,
    TOOLJET_OIDC_CLIENT_SECRET: clientSecret,
    TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
  } = env;
  const location = getConfiguredOidcLocation(env);
  if (
    !isCommunityEdition(env) ||
    !location ||
    !isHttpsUrl(issuer) ||
    new URL(issuer).search ||
    !clientId ||
    !clientSecret ||
    !isUuid(workspaceId)
  ) {
    return null;
  }
  return { issuer, clientId, clientSecret, workspaceId: workspaceId.toLowerCase(), ...location };
}

export function getManagedOidcRegistrations(env = process.env): Map<string, ConfiguredOidcSettings> {
  const registrations = new Map<string, ConfiguredOidcSettings>();
  if (!isCommunityEdition(env) || env.TOOLJET_OIDC_CONNECTORS === undefined) return registrations;

  const legacy = getConfiguredOidcSettings(env);
  const location = getConfiguredOidcLocation(env);
  const usedClients = new Set(legacy ? [JSON.stringify([legacy.issuer, legacy.clientId])] : []);
  const invalid = () => new Error('Invalid TOOLJET_OIDC_CONNECTORS configuration');
  let mapping: unknown;
  try {
    mapping = JSON.parse(env.TOOLJET_OIDC_CONNECTORS);
  } catch {
    throw invalid();
  }
  if (!location || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw invalid();

  for (const [key, entry] of Object.entries(mapping)) {
    if (
      !isUuid(key) ||
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 3
    ) {
      throw invalid();
    }
    const workspaceId = key.toLowerCase();
    const { issuer, clientId, clientSecretEnv } = entry as Record<string, unknown>;
    if (
      typeof issuer !== 'string' ||
      !isHttpsUrl(issuer) ||
      new URL(issuer).search ||
      typeof clientId !== 'string' ||
      !clientId.trim() ||
      typeof clientSecretEnv !== 'string' ||
      !/^TOOLJET_OIDC_CLIENT_SECRET(?:_[A-Z0-9_]+)?$/.test(clientSecretEnv) ||
      !env[clientSecretEnv] ||
      registrations.has(workspaceId)
    ) {
      throw invalid();
    }
    const clientSecret = env[clientSecretEnv];
    const client = JSON.stringify([issuer, clientId]);
    if (legacy?.workspaceId === workspaceId) {
      if (issuer !== legacy.issuer || clientId !== legacy.clientId || clientSecret !== legacy.clientSecret)
        throw invalid();
    } else if (usedClients.has(client)) {
      throw invalid();
    }
    usedClients.add(client);
    registrations.set(workspaceId, { issuer, clientId, clientSecret, workspaceId, ...location });
  }
  return registrations;
}

export function oidcReturnPath(value: unknown, settings: OidcLocation): string {
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

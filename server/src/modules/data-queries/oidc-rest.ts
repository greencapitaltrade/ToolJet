import { privateServiceOrigin } from '@helpers/private-service-origin';
import { DataSource } from '@entities/data_source.entity';
import type { User } from '@entities/user.entity';
import type { AbilityService } from '@modules/ability/interfaces/IService';
import { MODULES } from '@modules/app/constants/modules';
import { getConfiguredOidcSettings } from '@modules/auth/oauth/configured-oidc.config';
import { OidcActorUser, resolveThorActor, ThorActorError } from '@modules/auth/oauth/configured-oidc-workspace';
import type { SessionUtilService } from '@modules/session/util.service';
import { ForbiddenException } from '@nestjs/common';
import { QueryError } from '@tooljet/plugins';
import { FeatureAbilityFactory as DataSourceFeatureAbilityFactory } from './ability/data-source';
import { FEATURE_KEY } from './constants';
import { dealerViewerHeaders } from './dealer-viewer';

export const OIDC_REST_SOURCES_ENV = 'TOOLJET_OIDC_REST_SOURCES';
export const OIDC_THOR_ORIGIN_ENV = 'TOOLJET_OIDC_THOR_ORIGIN';

type RestOptions = { url?: string; method?: string; headers?: [string, unknown][]; auth_type?: string };

const safePathSegment = /^[\w.~:-]+$/;
const parameterSegment = /^\{\{parameters\.[\w]+\}\}$/;
const protectedHeaders = new Set([
  'host',
  ':authority',
  'forwarded',
  'x-forwarded-host',
  'x-gct-user-id',
  'x-gct-org-id',
]);
const configuredSourceError = () =>
  new QueryError('Unable to use the configured REST connection.', '', { status: 503 });
const restMethods = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options']);

/** Returns an origin selected by the instance administrator from the persisted connection ID. */
export function getOidcRestSourceOrigin(dataSourceId: string): string | undefined {
  const value = process.env[OIDC_REST_SOURCES_ENV];
  if (!value) return;

  let sources: Record<string, unknown>;
  try {
    sources = JSON.parse(value);
  } catch {
    throw configuredSourceError();
  }
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw configuredSourceError();
  if (!Object.prototype.hasOwnProperty.call(sources, dataSourceId)) return;
  const source = sources[dataSourceId];
  const origin = typeof source === 'string' && privateServiceOrigin(source);
  if (!origin) throw configuredSourceError();
  return origin;
}

/** Linking a protected connection must use the same native ability as creating a query on it. */
export async function assertCanUseOidcRestSource(
  user: User,
  source?: Pick<DataSource, 'id' | 'kind'>,
  abilityService?: AbilityService
): Promise<void> {
  if (source?.kind !== 'restapi' || !getOidcRestSourceOrigin(source.id)) return;
  if (!abilityService) throw configuredSourceError();
  const ability = await new DataSourceFeatureAbilityFactory(abilityService).createAbility(
    user,
    { moduleName: MODULES.DATA_QUERY, features: [FEATURE_KEY.CREATE] },
    [{ resourceType: MODULES.GLOBAL_DATA_SOURCE }],
    { tj_resource_id: source.id }
  );
  if (!ability.can(FEATURE_KEY.CREATE, DataSource)) {
    throw new ForbiddenException('You do not have access to use this data source.');
  }
}

function matchesSavedPath(saved?: string, resolved?: string): boolean {
  if (saved === '/' && resolved === '/') return true;
  if (!saved?.startsWith('/') || !resolved?.startsWith('/')) return false;

  const savedPath = saved.slice(1).split('/');
  const resolvedPath = resolved.slice(1).split('/');
  return (
    savedPath.length === resolvedPath.length &&
    resolvedPath.every(
      (segment, index) =>
        safePathSegment.test(segment) &&
        segment !== '.' &&
        segment !== '..' &&
        (savedPath[index] === segment || parameterSegment.test(savedPath[index]))
    )
  );
}

function forwardedHeaders(headers: RestOptions['headers'] = []) {
  if (!Array.isArray(headers)) return [];
  return headers.filter(
    (row) => Array.isArray(row) && typeof row[0] === 'string' && !protectedHeaders.has(row[0].trim().toLowerCase())
  );
}

export async function prepareOidcRestQuery(
  origin: string,
  saved: RestOptions,
  parsed: RestOptions,
  source: RestOptions,
  user: OidcActorUser | undefined,
  sessions?: SessionUtilService,
  viewerActor?: { userId: string; organizationId: string }
): Promise<{ sourceOptions: RestOptions; queryOptions: RestOptions }> {
  const settings = getConfiguredOidcSettings();
  const thorOrigin = privateServiceOrigin(process.env[OIDC_THOR_ORIGIN_ENV]);
  if ((!viewerActor && (!settings || !thorOrigin || !sessions)) || privateServiceOrigin(source.url) !== origin) {
    throw configuredSourceError();
  }

  if (!restMethods.has(saved.method) || parsed.method !== saved.method || !matchesSavedPath(saved.url, parsed.url)) {
    throw new QueryError('Invalid REST query path or method.', '', { status: 400 });
  }
  if (!user && !viewerActor) throw new QueryError('Sign in to use this connection.', '', { status: 401 });
  if (source.auth_type === 'oauth' || source.auth_type === 'oauth2') throw configuredSourceError();

  try {
    const { userId, organizationId } = viewerActor ?? await resolveThorActor(sessions, user, { ...settings, thorOrigin });
    return {
      sourceOptions: {
        ...source,
        url: origin,
        headers: [...forwardedHeaders(viewerActor ? dealerViewerHeaders(source.headers) : source.headers), ['x-gct-user-id', userId], ['x-gct-org-id', organizationId]],
      },
      queryOptions: { ...parsed, headers: forwardedHeaders(viewerActor ? dealerViewerHeaders(parsed.headers) : parsed.headers) },
    };
  } catch (error) {
    if (error instanceof ThorActorError && error.status === 401) {
      throw new QueryError('Sign in to use this connection.', '', { status: 401 });
    }
    throw configuredSourceError();
  }
}

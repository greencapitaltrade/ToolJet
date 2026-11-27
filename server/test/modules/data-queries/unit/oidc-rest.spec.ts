import { SessionUtilService } from '@modules/session/util.service';
import { AbilityService } from '@modules/ability/interfaces/IService';
import { MODULES } from '@modules/app/constants/modules';
import { User } from '@entities/user.entity';
import {
  assertCanUseOidcRestSource,
  getOidcRestSourceOrigin,
  prepareOidcRestQuery,
} from '@modules/data-queries/oidc-rest';

/** @group platform */
describe('Native REST queries with verified OIDC identity', () => {
  const id = '0ebf2496-c9db-4d99-afec-da53c0f88135';
  const user = { id: 'tooljet-user', sessionId: 'native-session', organizationId: id };
  const origin = 'http://api.namespace.svc.cluster.local:3000';
  const thor = 'http://identity.namespace.svc.cluster.local:3000';
  const issuer = 'https://login.example.test/oidc';
  const userId = '9007199254740993';
  const orgId = '9007199254740994';
  const saved = { method: 'post', url: '/v1/records/{{parameters.recordId}}/run' };
  const parsed = {
    method: 'post',
    url: '/v1/records/123/run',
    headers: [
      [' X-GCT-Org-Id ', 'forged-tenant'],
      ['HOST', 'elsewhere.example.test'],
      ['Content-Type', 'application/json'],
    ] as [string, string][],
  };
  const source = {
    url: `${origin}/`,
    headers: [
      ['X-Gct-User-Id', 'configured-value'],
      ['api-secret', 'synthetic-service-key'],
    ] as [string, string][],
  };
  const getOidcActor = jest.fn();
  const sessions = { getOidcActor } as unknown as SessionUtilService;

  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      TOOLJET_EDITION: 'ce',
      TOOLJET_HOST: 'https://workspace.example.test',
      TOOLJET_OIDC_CLIENT_ID: 'test-client',
      TOOLJET_OIDC_CLIENT_SECRET: 'test-only',
      TOOLJET_OIDC_ISSUER: issuer,
      TOOLJET_OIDC_WORKSPACE_ID: id,
      TOOLJET_OIDC_CONNECTORS: undefined,
      TOOLJET_OIDC_REST_SOURCES: JSON.stringify({ [id]: origin }),
      TOOLJET_OIDC_THOR_ORIGIN: thor,
    });
    getOidcActor.mockReset().mockResolvedValue({ issuer, clientId: 'test-client', sub: userId });
    jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ sub: userId, organization_id: orgId }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('opts in an exact persisted connection using server configuration', () => {
    expect(getOidcRestSourceOrigin(id)).toBe(origin);
    expect(getOidcRestSourceOrigin('other-source')).toBeUndefined();
    expect(getOidcRestSourceOrigin('constructor')).toBeUndefined();
  });

  it('uses the native source grant to bind an OIDC connection during authoring', async () => {
    const resourceActionsPermission = jest.fn();
    const ability = { resourceActionsPermission } as unknown as AbilityService;
    const currentUser = user as User;
    const persistedSource = { id, kind: 'restapi' } as const;
    const grant = (usableDataSourcesId: string[]) => ({ [MODULES.GLOBAL_DATA_SOURCE]: { usableDataSourcesId } });
    resourceActionsPermission.mockResolvedValue(grant(['another-source']));
    await expect(assertCanUseOidcRestSource(currentUser, persistedSource, ability)).rejects.toMatchObject({
      status: 403,
    });

    resourceActionsPermission.mockResolvedValue(grant([id]));
    await expect(assertCanUseOidcRestSource(currentUser, persistedSource, ability)).resolves.toBeUndefined();

    resourceActionsPermission.mockClear();
    await assertCanUseOidcRestSource(currentUser, { id: 'ordinary-source', kind: 'restapi' }, ability);
    expect(resourceActionsPermission).not.toHaveBeenCalled();
  });

  it('stamps canonical decimal actor identifiers and preserves native service credentials', async () => {
    const result = await prepareOidcRestQuery(origin, saved, parsed, source, user, sessions);

    expect(result.sourceOptions).toMatchObject({
      url: origin,
      headers: [
        ['api-secret', 'synthetic-service-key'],
        ['x-gct-user-id', userId],
        ['x-gct-org-id', orgId],
      ],
    });
    expect(result.queryOptions).toEqual({ ...parsed, headers: [['Content-Type', 'application/json']] });
    expect(getOidcActor).toHaveBeenCalledWith(user);
    expect(fetch).toHaveBeenCalledWith(
      `${thor}/v1/users/oidc-subject/${userId}`,
      expect.objectContaining({
        redirect: 'error',
        headers: { 'x-gct-oidc-issuer': issuer, 'x-gct-oidc-client-id': 'test-client' },
      })
    );
  });

  it('selects the current workspace registration without accepting a different session client', async () => {
    const managedWorkspace = '94db67ea-e2e7-47ba-9d92-95cab041e726';
    const managedUser = { ...user, organizationId: managedWorkspace };
    process.env.TOOLJET_OIDC_CONNECTORS = JSON.stringify({
      [managedWorkspace]: {
        issuer,
        clientId: 'managed-client',
        clientSecretEnv: 'TOOLJET_OIDC_CLIENT_SECRET',
      },
    });

    await expect(prepareOidcRestQuery(origin, saved, parsed, source, managedUser, sessions)).rejects.toMatchObject({
      data: { status: 401 },
    });
    expect(fetch).not.toHaveBeenCalled();

    getOidcActor.mockResolvedValueOnce({ issuer, clientId: 'managed-client', sub: userId });
    await prepareOidcRestQuery(origin, saved, parsed, source, managedUser, sessions);
    expect(fetch).toHaveBeenCalledWith(
      `${thor}/v1/users/oidc-subject/${userId}`,
      expect.objectContaining({
        headers: { 'x-gct-oidc-issuer': issuer, 'x-gct-oidc-client-id': 'managed-client' },
      })
    );
  });

  it.each([
    '/v1/records/../run',
    '/v1/records/%2e%2e/run',
    '/v1/records/42%2fextra/run',
    '/v1/records/42?new=operation/run',
    '/v1/records/42/other',
    '//elsewhere.example.test/v1/records/42/run',
  ])('rejects resolved paths that can change the saved route %s', async (url) => {
    await expect(prepareOidcRestQuery(origin, saved, { ...parsed, url }, source, user, sessions)).rejects.toMatchObject(
      { data: { status: 400 } }
    );
    expect(getOidcActor).not.toHaveBeenCalled();
  });

  it('rejects a changed source origin or a method supplied by the query caller', async () => {
    await expect(
      prepareOidcRestQuery(origin, saved, parsed, { ...source, url: 'https://other.example.test' }, user, sessions)
    ).rejects.toMatchObject({ data: { status: 503 } });
    await expect(
      prepareOidcRestQuery(origin, saved, { ...parsed, method: 'put' }, source, user, sessions)
    ).rejects.toMatchObject({ data: { status: 400 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never substitutes the workspace ID for an unauthenticated viewer or rejected Thor subject', async () => {
    await expect(prepareOidcRestQuery(origin, saved, parsed, source, undefined, sessions)).rejects.toMatchObject({
      data: { status: 401 },
    });
    expect(fetch).not.toHaveBeenCalled();
    jest.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
    await expect(prepareOidcRestQuery(origin, saved, parsed, source, user, sessions)).rejects.toMatchObject({
      data: { status: 401 },
    });
  });
});

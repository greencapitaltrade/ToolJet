import { getDBConnection } from '@helpers/database.helper';
import {
  describeWorkspaceOidc,
  resolveWorkspaceOidc,
  setWorkspaceOidc,
  WorkspaceOidcMode,
  workspaceOidcReturnPath,
} from '@modules/auth/oauth/configured-oidc.workspace-settings';

jest.mock('@helpers/database.helper', () => ({ getDBConnection: jest.fn() }));

/** @group platform */
describe('Workspace Login managed OIDC settings', () => {
  const legacyWorkspace = '6b5aa378-072f-4022-977e-0066545ee3c6';
  const managedWorkspace = '94db67ea-e2e7-47ba-9d92-95cab041e726';
  const unknownWorkspace = '3bca5c4c-c2ab-4187-86e9-8ac41d2e745e';
  const issuer = 'https://accounts.example.test/oidc';
  const revision = '4b4f1d37-aa80-4edb-a4f3-783764dfa381';
  const connection = { query: jest.fn() };
  const entry = (clientId: string) => ({ issuer, clientId, clientSecretEnv: 'TOOLJET_OIDC_CLIENT_SECRET' });
  const stored = (client_id: string, enabled: boolean) => ({ issuer, client_id, enabled, revision });

  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      TOOLJET_EDITION: 'ce',
      TOOLJET_HOST: 'https://tools.example.test',
      TOOLJET_OIDC_WORKSPACE_ID: legacyWorkspace,
      TOOLJET_OIDC_ISSUER: issuer,
      TOOLJET_OIDC_CLIENT_ID: 'legacy',
      TOOLJET_OIDC_CLIENT_SECRET: 'fixture-only',
      TOOLJET_OIDC_WORKSPACE_SETTINGS_ENABLED: undefined,
      TOOLJET_OIDC_CONNECTORS: JSON.stringify({
        [legacyWorkspace]: entry('legacy'),
        [managedWorkspace]: entry('managed'),
      }),
    });
    connection.query.mockReset();
    jest.mocked(getDBConnection).mockReturnValue(connection as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps the legacy default and a newly provisioned workspace off until explicitly enabled', async () => {
    connection.query.mockResolvedValue([]);
    await expect(resolveWorkspaceOidc()).resolves.toMatchObject({ workspaceId: legacyWorkspace, clientId: 'legacy' });
    await expect(resolveWorkspaceOidc(managedWorkspace)).resolves.toBeNull();
    await expect(resolveWorkspaceOidc(unknownWorkspace)).resolves.toBeNull();
    expect(connection.query).toHaveBeenCalledTimes(2);
  });

  it('rejects a disabled or stale binding and scopes saved app returns to the resolved workspace', async () => {
    connection.query
      .mockResolvedValueOnce([stored('managed', false)])
      .mockResolvedValueOnce([stored('previous-client', true)])
      .mockResolvedValueOnce([stored('managed', true)])
      .mockResolvedValueOnce([{ found: false }])
      .mockResolvedValueOnce([{ found: true }]);
    await expect(resolveWorkspaceOidc(managedWorkspace)).resolves.toBeNull();
    await expect(resolveWorkspaceOidc(managedWorkspace)).resolves.toBeNull();
    const active = await resolveWorkspaceOidc(managedWorkspace);
    expect(active).toMatchObject({ workspaceId: managedWorkspace, clientId: 'managed', revision });
    await expect(workspaceOidcReturnPath('/applications/unrelated', active)).resolves.toBe('/');
    await expect(workspaceOidcReturnPath('/applications/managed-app?tab=2#overview', active)).resolves.toBe(
      '/applications/managed-app?tab=2#overview'
    );
    expect(connection.query).toHaveBeenLastCalledWith(expect.stringContaining('organization_id = $1'), [
      managedWorkspace,
      'managed-app',
    ]);
  });

  it('returns public registration metadata and refuses mutations until the rollout gate is open', async () => {
    connection.query.mockResolvedValue([]);
    const result = await describeWorkspaceOidc(managedWorkspace);
    expect(result).toMatchObject({ enabled: false, usingDeploymentDefault: true, canEdit: false });
    expect(result).not.toHaveProperty('clientSecret');
    await expect(setWorkspaceOidc(managedWorkspace, WorkspaceOidcMode.ENABLED)).rejects.toMatchObject({ status: 503 });
    await expect(setWorkspaceOidc(unknownWorkspace, WorkspaceOidcMode.ENABLED)).rejects.toMatchObject({ status: 404 });
    expect(connection.query).toHaveBeenCalledTimes(1);
  });

  it('restores the legacy configuration with a single write to that workspace', async () => {
    process.env.TOOLJET_OIDC_WORKSPACE_SETTINGS_ENABLED = 'true';
    connection.query.mockResolvedValueOnce([stored('legacy', false)]).mockResolvedValue([]);
    await expect(resolveWorkspaceOidc()).resolves.toBeNull();
    await expect(setWorkspaceOidc(legacyWorkspace, WorkspaceOidcMode.DEFAULT)).resolves.toMatchObject({
      enabled: true,
      usingDeploymentDefault: true,
    });
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      'DELETE FROM configured_oidc_workspace_settings WHERE workspace_id = $1',
      [legacyWorkspace]
    );
  });

  it('honors an explicit legacy disable if the managed registration is absent', async () => {
    delete process.env.TOOLJET_OIDC_CONNECTORS;
    connection.query.mockResolvedValue([stored('legacy', false)]);
    await expect(resolveWorkspaceOidc()).resolves.toBeNull();
  });
});

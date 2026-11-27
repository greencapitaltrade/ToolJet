import { getConfiguredOidcSettings, getManagedOidcRegistrations } from '@modules/auth/oauth/configured-oidc.config';

/** @group platform */
describe('Configured workspace OIDC registrations', () => {
  const workspaceId = '6b5aa378-072f-4022-977e-0066545ee3c6';
  const otherWorkspaceId = '94db67ea-e2e7-47ba-9d92-95cab041e726';
  const credential = 'TOOLJET_OIDC_CLIENT_SECRET';
  const connector = { issuer: 'https://accounts.example.test/oidc', clientId: 'staff', clientSecretEnv: credential };
  const managed = { ...connector, clientId: 'other-staff', clientSecretEnv: `${credential}_MANAGED` };
  const legacy = {
    TOOLJET_EDITION: 'ce',
    TOOLJET_HOST: 'https://tools.example.test',
    SUB_PATH: '/tools/',
    TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
    TOOLJET_OIDC_ISSUER: connector.issuer,
    TOOLJET_OIDC_CLIENT_ID: connector.clientId,
    [credential]: 'fixture-secret',
    [managed.clientSecretEnv]: 'fixture-managed-secret',
  };
  const registered = (mapping: unknown) => ({ ...legacy, TOOLJET_OIDC_CONNECTORS: JSON.stringify(mapping) });

  it('keeps the same legacy registration and prepares a distinct client for another workspace', () => {
    const env = registered({ [workspaceId.toUpperCase()]: connector, [otherWorkspaceId]: managed });
    expect(getManagedOidcRegistrations(env).get(workspaceId)).toEqual(getConfiguredOidcSettings(legacy));
    expect(getManagedOidcRegistrations(env).get(otherWorkspaceId)).toMatchObject({
      workspaceId: otherWorkspaceId,
      issuer: connector.issuer,
      clientId: managed.clientId,
      clientSecret: 'fixture-managed-secret',
      redirectUri: 'https://tools.example.test/tools/api/oauth/oidc/callback',
    });
    expect(getConfiguredOidcSettings(env)).toEqual(getConfiguredOidcSettings(legacy));
  });

  it.each([
    ['malformed JSON', '{'],
    ['an array', JSON.stringify([connector])],
    ['an invalid workspace', JSON.stringify({ invalid: connector })],
    ['an invalid issuer', JSON.stringify({ [workspaceId]: { ...connector, issuer: 'http://accounts.example.test' } })],
    [
      'a missing managed secret',
      JSON.stringify({ [otherWorkspaceId]: { ...managed, clientSecretEnv: 'TOOLJET_OIDC_CLIENT_SECRET_MISSING' } }),
    ],
    ['an unrelated credential', JSON.stringify({ [otherWorkspaceId]: { ...managed, clientSecretEnv: 'PG_PASS' } })],
    ['a legacy client assigned to a second workspace', JSON.stringify({ [otherWorkspaceId]: connector })],
    ['a conflicting legacy client', JSON.stringify({ [workspaceId]: managed })],
    [
      'duplicate workspace keys with different case',
      JSON.stringify({ [otherWorkspaceId]: managed, [otherWorkspaceId.toUpperCase()]: managed }),
    ],
  ])('rejects %s', (_reason, value) => {
    expect(() =>
      getManagedOidcRegistrations({ ...legacy, PG_PASS: 'fixture', TOOLJET_OIDC_CONNECTORS: value })
    ).toThrow(/^Invalid TOOLJET_OIDC_CONNECTORS configuration$/);
  });

  it('preserves installs without managed settings and other editions', () => {
    expect(getManagedOidcRegistrations(legacy).size).toBe(0);
    expect(getManagedOidcRegistrations({ ...legacy, TOOLJET_EDITION: 'ee', TOOLJET_OIDC_CONNECTORS: '{' }).size).toBe(
      0
    );
  });
});

import { assertConfiguredOidcSettings, getConfiguredOidcSettings } from '@modules/auth/oauth/configured-oidc.config';

/** @group platform */
describe('Configured workspace OIDC settings', () => {
  const workspaceId = '6b5aa378-072f-4022-977e-0066545ee3c6';
  const otherWorkspaceId = '94db67ea-e2e7-47ba-9d92-95cab041e726';
  const credential = 'TOOLJET_OIDC_CLIENT_SECRET';
  const connector = { issuer: 'https://accounts.example.test/oidc', clientId: 'staff', clientSecretEnv: credential };
  const common = {
    TOOLJET_EDITION: 'ce',
    TOOLJET_HOST: 'https://tools.example.test',
    SUB_PATH: '/tools/',
    [credential]: 'fixture-secret',
  };
  const legacy = {
    ...common,
    TOOLJET_OIDC_ISSUER: connector.issuer,
    TOOLJET_OIDC_CLIENT_ID: connector.clientId,
    TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
  };
  const managed = { ...common, TOOLJET_OIDC_CONNECTORS: JSON.stringify({ [workspaceId.toUpperCase()]: connector }) };

  it('resolves the same registration and callback with legacy, managed or both settings', () => {
    const settings = getConfiguredOidcSettings(legacy);
    expect(settings).toEqual({
      issuer: connector.issuer,
      clientId: connector.clientId,
      clientSecret: 'fixture-secret',
      workspaceId,
      origin: 'https://tools.example.test',
      subpath: '/tools',
      redirectUri: 'https://tools.example.test/tools/api/oauth/oidc/callback',
    });
    expect(getConfiguredOidcSettings(managed)).toEqual(settings);
    expect(getConfiguredOidcSettings({ ...legacy, TOOLJET_OIDC_CONNECTORS: managed.TOOLJET_OIDC_CONNECTORS })).toEqual(
      settings
    );
    expect(() => assertConfiguredOidcSettings(managed)).not.toThrow();
  });

  it.each([
    ['malformed JSON', '{'],
    ['an empty mapping', '{}'],
    ['an array', JSON.stringify([connector])],
    ['a second workspace', JSON.stringify({ [workspaceId]: connector, [otherWorkspaceId]: connector })],
    ['an invalid workspace', JSON.stringify({ invalid: connector })],
    ['an invalid issuer', JSON.stringify({ [workspaceId]: { ...connector, issuer: 'http://accounts.example.test' } })],
    [
      'a missing managed secret',
      JSON.stringify({ [workspaceId]: { ...connector, clientSecretEnv: `${credential}_NEW` } }),
    ],
    ['an unrelated credential', JSON.stringify({ [workspaceId]: { ...connector, clientSecretEnv: 'PG_PASS' } })],
  ])('rejects %s before the CE server starts', (_reason, value) => {
    const env = { ...legacy, PG_PASS: 'fixture-db-password', TOOLJET_OIDC_CONNECTORS: value };
    expect(getConfiguredOidcSettings(env)).toBeNull();
    expect(() => assertConfiguredOidcSettings(env)).toThrow(/^Invalid TOOLJET_OIDC_CONNECTORS configuration$/);
  });

  it('rejects disagreement with legacy routing and keeps legacy-only and other editions compatible', () => {
    const conflict = { ...legacy, ...managed, TOOLJET_OIDC_CLIENT_ID: 'old-client' };
    expect(getConfiguredOidcSettings(conflict)).toBeNull();
    expect(() => assertConfiguredOidcSettings(conflict)).toThrow();

    expect(getConfiguredOidcSettings({ ...managed, TOOLJET_EDITION: 'ee' })).toBeNull();
    expect(() => assertConfiguredOidcSettings({ ...managed, TOOLJET_EDITION: 'ee' })).not.toThrow();
    expect(() => assertConfiguredOidcSettings({ TOOLJET_HOST: 'https://tools.example.test' })).not.toThrow();
  });
});

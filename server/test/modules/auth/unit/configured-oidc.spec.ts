import { UnauthorizedException } from '@nestjs/common';
import { Issuer } from 'openid-client';
import { ConfiguredOidcService } from '@modules/auth/oauth/configured-oidc.service';
import { getConfiguredOidcSettings, oidcReturnPath } from '@modules/auth/oauth/configured-oidc.config';
import { SSOResponseRepository } from '@modules/auth/oauth/repository/sso-response.repository';
import { dbTransactionWrap } from '@helpers/database.helper';

jest.mock('@helpers/database.helper', () => ({ dbTransactionWrap: jest.fn() }));

/** @group platform */
describe('Configured CE OIDC', () => {
  const issuer = 'https://accounts.example.test/oidc';
  const workspaceId = '6b5aa378-072f-4022-977e-0066545ee3c6';
  const flowId = '2ccaf13e-563c-4985-a373-30b888e5dfb2';
  const state = '3bca5c4c-c2ab-4187-86e9-8ac41d2e745e';
  const environment = {
    TOOLJET_EDITION: 'ce',
    TOOLJET_HOST: 'https://tools.example.test',
    TOOLJET_OIDC_ISSUER: issuer,
    TOOLJET_OIDC_CLIENT_ID: 'test-client',
    TOOLJET_OIDC_CLIENT_SECRET: 'test-only',
    TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
  };

  beforeEach(() => jest.replaceProperty(process, 'env', { ...process.env, ...environment }));
  afterEach(() => jest.restoreAllMocks());

  it('enables CE only with a full, pinned HTTPS configuration', () => {
    expect(getConfiguredOidcSettings({ ...environment, TOOLJET_EDITION: 'ee' })).toBeNull();
    expect(getConfiguredOidcSettings({ ...environment, TOOLJET_OIDC_CLIENT_SECRET: '' })).toBeNull();
    expect(
      getConfiguredOidcSettings({ ...environment, TOOLJET_OIDC_ISSUER: 'http://accounts.example.test' })
    ).toBeNull();
    expect(getConfiguredOidcSettings(environment)).toMatchObject({
      issuer,
      workspaceId,
      redirectUri: 'https://tools.example.test/api/oauth/oidc/callback',
    });
  });

  it('keeps the app viewer return on the configured instance', () => {
    const settings = getConfiguredOidcSettings(environment);
    expect(oidcReturnPath('/applications/portfolio/overview?view=pending', settings)).toBe(
      '/applications/portfolio/overview?view=pending'
    );
    expect(oidcReturnPath('//outside.example/applications/portfolio', settings)).toBe('/');
    expect(oidcReturnPath('/applications/../../api/oauth/oidc/start', settings)).toBe('/');
    expect(oidcReturnPath('/applications/\\outside.example', settings)).toBe('/');
  });

  const prepareService = () => {
    const client = {
      authorizationUrl: jest.fn().mockReturnValue('https://accounts.example.test/authorize'),
      callbackParams: jest.fn().mockReturnValue({ code: 'provider-code', state }),
      callback: jest.fn().mockResolvedValue({
        claims: () => ({
          sub: '123',
          iss: issuer,
          email: 'unverified@example.test',
          email_verified: false,
          role: 'admin',
        }),
      }),
      issuer: { issuer },
    };
    const request = { cookies: { tj_oidc_flow: flowId } };
    const response = { cookie: jest.fn(), clearCookie: jest.fn() };
    const consume = jest.fn().mockResolvedValue({
      nonce: 'provider-nonce',
      codeVerifier: 'private-verifier',
      returnTo: '/applications/portfolio',
    });
    const challenges = {
      createSSOResponse: jest.fn().mockResolvedValue({ id: flowId }),
      consumeConfiguredOidc: consume,
    };
    const discover = jest.spyOn(Issuer, 'discover').mockResolvedValue({
      issuer,
      authorization_endpoint: 'https://accounts.example.test/authorize',
      token_endpoint: 'https://accounts.example.test/token',
      jwks_uri: 'https://accounts.example.test/keys',
      Client: jest.fn().mockImplementation(() => client),
    } as unknown as Issuer);
    const service = new ConfiguredOidcService(
      challenges as unknown as ConstructorParameters<typeof ConfiguredOidcService>[0],
      null
    );
    const establishSession = jest.spyOn(service, 'establishSession').mockResolvedValue(undefined);
    return { service, client, challenges, response, request, consume, discover, establishSession };
  };

  it('sets a browser-bound cookie and uses S256 PKCE, state and nonce', async () => {
    const { service, client, challenges, response } = prepareService();

    await expect(service.start(response as never, '/applications/portfolio')).resolves.toBe(
      'https://accounts.example.test/authorize'
    );

    expect(response.cookie).toHaveBeenCalledWith(
      'tj_oidc_flow',
      flowId,
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax' })
    );
    expect(client.authorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'code',
        code_challenge_method: 'S256',
        code_challenge: expect.any(String),
        state: expect.any(String),
        nonce: expect.any(String),
      })
    );
    expect(challenges.createSSOResponse).toHaveBeenCalledTimes(1);
  });

  it('consumes browser state once and stamps only provider-verified identity into the native session', async () => {
    const { service, client, request, response, consume, establishSession } = prepareService();

    await expect(service.complete(request as never, response as never)).resolves.toBe('/applications/portfolio');

    expect(consume).toHaveBeenCalledWith(flowId, state);
    expect(client.callback).toHaveBeenCalledWith(
      'https://tools.example.test/api/oauth/oidc/callback',
      { code: 'provider-code', state },
      expect.objectContaining({ state, nonce: 'provider-nonce', code_verifier: 'private-verifier' })
    );
    expect(establishSession).toHaveBeenCalledWith(response, workspaceId, { issuer, sub: '123' }, undefined);

    consume.mockResolvedValueOnce(null);
    await expect(service.complete(request as never, response as never)).rejects.toThrow(UnauthorizedException);
    expect(client.callback).toHaveBeenCalledTimes(1);
  });

  it('rejects absent browser state and the wrong discovered issuer before any token exchange', async () => {
    const { service, client, response, consume, discover } = prepareService();

    await expect(service.complete({ cookies: {} } as never, response as never)).rejects.toThrow(UnauthorizedException);
    expect(consume).not.toHaveBeenCalled();

    discover.mockResolvedValueOnce({ issuer: 'https://outside.example' } as unknown as Issuer);
    await expect(service.start(response as never, '/')).rejects.toThrow(UnauthorizedException);
    expect(client.callback).not.toHaveBeenCalled();
  });

  it('consumes only a live row matching the browser cookie and provider state with one DELETE', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const statement = {
      delete: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    };
    const repository = Object.create(SSOResponseRepository.prototype) as SSOResponseRepository;
    jest.spyOn(repository, 'createQueryBuilder').mockReturnValue(statement as never);

    await expect(repository.consumeConfiguredOidc(flowId, state)).resolves.toBeNull();
    expect(statement.where).toHaveBeenCalledWith({
      id: flowId,
      configId: state,
      sso: 'configured_oidc',
      createdAt: expect.objectContaining({ type: 'moreThan', value: new Date(now - 5 * 60 * 1000) }),
    });
    expect(statement.returning).toHaveBeenCalledWith('response');
    expect(statement.execute).toHaveBeenCalledTimes(1);
  });

  const prepareAccount = (mappedUserId?: string) => {
    const workspace = { id: workspaceId };
    const user = { id: 'tooljet-user' };
    const manager = {
      query: jest.fn().mockResolvedValueOnce(mappedUserId ? [{ user_id: mappedUserId }] : []),
      findOne: jest.fn().mockResolvedValue(user),
    };
    jest.mocked(dbTransactionWrap).mockImplementation(async (operation) => operation(manager));
    const sessions = {
      findOrganization: jest.fn().mockResolvedValue(workspace),
      generateLoginResultPayload: jest.fn(),
    };
    const service = new ConfiguredOidcService(null, sessions as never);
    return { workspace, user, manager, sessions, service };
  };

  it('uses an existing issuer/subject binding even if the provider email changes', async () => {
    const { service, workspace, user, manager, sessions } = prepareAccount('tooljet-user');
    const identity = { issuer, sub: '123' };

    await service.establishSession(null, workspaceId, identity, 'changed@example.test');

    expect(manager.findOne).toHaveBeenCalledWith(expect.any(Function), {
      where: {
        id: 'tooljet-user',
        status: 'active',
        organizationUsers: { organizationId: workspaceId, status: 'active' },
      },
    });
    expect(sessions.generateLoginResultPayload).toHaveBeenCalledWith(
      null,
      user,
      workspace,
      true,
      false,
      undefined,
      manager,
      undefined,
      undefined,
      false,
      identity
    );
  });

  it('rejects a new subject colliding with an existing account binding without starting a session', async () => {
    const { service, manager, sessions } = prepareAccount();
    manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(
      service.establishSession(null, workspaceId, { issuer, sub: 'another-subject' }, 'user@example.test')
    ).rejects.toThrow(UnauthorizedException);

    expect(sessions.generateLoginResultPayload).not.toHaveBeenCalled();
  });
});

import { UnauthorizedException } from '@nestjs/common';
import * as database from '@helpers/database.helper';
import { UserSessions } from '@entities/user_sessions.entity';
import { SessionUtilService } from '@modules/session/util.service';

/** @group platform */
describe('SessionUtilService configured OIDC actor', () => {
  const workspaceId = '6b5aa378-072f-4022-977e-0066545ee3c6';
  const issuer = 'https://accounts.example.test/oidc';
  const clientId = 'test-client';
  const actor = { issuer, sub: '123', clientId };
  const user = { id: 'tooljet-user', sessionId: 'tooljet-session', organizationId: workspaceId };
  const service = Object.create(SessionUtilService.prototype) as SessionUtilService;
  const manager = { findOne: jest.fn() };

  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      TOOLJET_EDITION: 'ce',
      TOOLJET_HOST: 'https://tools.example.test',
      TOOLJET_OIDC_ISSUER: issuer,
      TOOLJET_OIDC_CLIENT_ID: clientId,
      TOOLJET_OIDC_CLIENT_SECRET: 'test-only',
      TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
      TOOLJET_OIDC_CONNECTORS: undefined,
    });
    manager.findOne.mockReset();
    jest.spyOn(database, 'getDBConnection').mockReturnValue({ query: jest.fn().mockResolvedValue([]) } as never);
    jest.spyOn(database, 'dbTransactionWrap').mockImplementation(async (operation) => operation(manager));
  });
  afterEach(() => jest.restoreAllMocks());

  it('uses the existing authenticated user and active native session to resolve an actor', async () => {
    manager.findOne.mockResolvedValue({ oidcIdentity: actor });

    await expect(service.getOidcActor(user)).resolves.toEqual(actor);
    expect(manager.findOne).toHaveBeenCalledWith(UserSessions, {
      where: {
        id: user.sessionId,
        userId: user.id,
        sessionType: 'user',
        expiry: expect.objectContaining({ type: 'moreThanOrEqual' }),
      },
      select: { oidcIdentity: true },
    });
  });

  it('requires the session stamp to match the active workspace registration', async () => {
    const otherWorkspace = '94db67ea-e2e7-47ba-9d92-95cab041e726';
    const registration = { issuer, client_id: 'other-client', enabled: true, revision: 'revision' };
    process.env.TOOLJET_OIDC_CONNECTORS = JSON.stringify({
      [otherWorkspace]: { issuer, clientId: registration.client_id, clientSecretEnv: 'TOOLJET_OIDC_CLIENT_SECRET' },
    });
    jest.spyOn(database, 'getDBConnection').mockReturnValue({
      query: jest.fn().mockResolvedValue([registration]),
    } as never);
    manager.findOne.mockResolvedValueOnce({ oidcIdentity: actor });
    const switchedUser = { ...user, organizationId: otherWorkspace };
    await expect(service.getOidcActor(switchedUser)).rejects.toThrow(UnauthorizedException);

    const matchingActor = { ...actor, clientId: registration.client_id };
    manager.findOne.mockResolvedValueOnce({ oidcIdentity: matchingActor });
    await expect(service.getOidcActor(switchedUser)).rejects.toThrow(UnauthorizedException);
    manager.findOne.mockResolvedValue({ oidcIdentity: { ...matchingActor, revision: registration.revision } });
    await expect(service.getOidcActor(switchedUser)).resolves.toEqual(matchingActor);
    registration.enabled = false;
    await expect(service.getOidcActor(switchedUser)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects another workspace before looking up a session', async () => {
    await expect(service.getOidcActor({ ...user, organizationId: 'different-workspace' })).rejects.toThrow(
      UnauthorizedException
    );
    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { oidcIdentity: { ...actor, issuer: 'https://wrong.example.test' } },
    { oidcIdentity: { ...actor, clientId: 'previous-client' } },
    { oidcIdentity: { issuer, sub: actor.sub } },
  ])('rejects a session without the configured issuer and client', async (session) => {
    manager.findOne.mockResolvedValue(session);
    await expect(service.getOidcActor(user)).rejects.toThrow(UnauthorizedException);
  });
});

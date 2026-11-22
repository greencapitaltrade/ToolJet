import { UnauthorizedException } from '@nestjs/common';
import * as database from '@helpers/database.helper';
import { UserSessions } from '@entities/user_sessions.entity';
import { SessionUtilService } from '@modules/session/util.service';

/** @group platform */
describe('SessionUtilService configured OIDC actor', () => {
  const workspaceId = '6b5aa378-072f-4022-977e-0066545ee3c6';
  const issuer = 'https://accounts.example.test/oidc';
  const actor = { issuer, sub: '123' };
  const user = { id: 'tooljet-user', sessionId: 'tooljet-session', organizationId: workspaceId };
  const service = Object.create(SessionUtilService.prototype) as SessionUtilService;
  const manager = { findOne: jest.fn() };

  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      TOOLJET_EDITION: 'ce',
      TOOLJET_HOST: 'https://tools.example.test',
      TOOLJET_OIDC_ISSUER: issuer,
      TOOLJET_OIDC_CLIENT_ID: 'test-client',
      TOOLJET_OIDC_CLIENT_SECRET: 'test-only',
      TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
    });
    manager.findOne.mockReset();
    jest.spyOn(database, 'dbTransactionWrap').mockImplementation(async (operation) => operation(manager));
  });
  afterEach(() => jest.restoreAllMocks());

  it('uses only the authenticated user and active native session to resolve an actor', async () => {
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

  it('rejects another workspace before looking up a session', async () => {
    await expect(service.getOidcActor({ ...user, organizationId: 'different-workspace' })).rejects.toThrow(
      UnauthorizedException
    );
    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it.each([null, {}, { oidcIdentity: { issuer: 'https://wrong.example.test', sub: actor.sub } }])(
    'rejects a missing, ordinary, or unrecognized issuer session',
    async (session) => {
      manager.findOne.mockResolvedValue(session);
      await expect(service.getOidcActor(user)).rejects.toThrow(UnauthorizedException);
    }
  );
});

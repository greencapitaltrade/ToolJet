import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { generators, Issuer } from 'openid-client';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { validate as isUuid } from 'uuid';
import { User } from '@entities/user.entity';
import { dbTransactionWrap } from '@helpers/database.helper';
import { SessionUtilService } from '@modules/session/util.service';
import { USER_STATUS, WORKSPACE_USER_STATUS } from '@modules/users/constants/lifecycle';
import {
  CONFIGURED_OIDC_FLOW,
  CONFIGURED_OIDC_FLOW_LIFETIME_MS,
  SSOResponseRepository,
  WORKSPACE_OIDC_FLOW,
} from './repository/sso-response.repository';
import {
  getConfiguredOidcLocation,
  isHttpsUrl,
  type ConfiguredOidcSettings,
  type OidcIdentity,
} from './configured-oidc.config';
import { resolveWorkspaceOidc, workspaceOidcReturnPath } from './configured-oidc.workspace-settings';

const FLOW_COOKIE = 'tj_oidc_flow';

@Injectable()
export class ConfiguredOidcService {
  constructor(
    private readonly challenges: SSOResponseRepository,
    private readonly sessions: SessionUtilService
  ) {}

  async start(response: Response, returnTo: unknown, workspaceId?: string): Promise<string> {
    const settings = await resolveWorkspaceOidc(workspaceId);
    if (!settings) throw new NotFoundException();
    const client = await this.getClient(settings);
    const state = randomUUID();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const connector = settings.revision
      ? { workspaceId: settings.workspaceId, revision: settings.revision }
      : undefined;
    const flow = await this.challenges.createSSOResponse(
      state,
      JSON.stringify({ nonce, codeVerifier, returnTo: await workspaceOidcReturnPath(returnTo, settings), connector }),
      connector ? WORKSPACE_OIDC_FLOW : CONFIGURED_OIDC_FLOW
    );

    response.cookie(FLOW_COOKIE, flow.id, {
      ...this.cookieOptions(settings),
      maxAge: CONFIGURED_OIDC_FLOW_LIFETIME_MS,
    });
    return client.authorizationUrl({
      scope: 'openid profile email',
      response_type: 'code',
      state,
      nonce,
      code_challenge: generators.codeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
  }

  async complete(request: Request, response: Response): Promise<string> {
    const location = getConfiguredOidcLocation();
    if (!location) throw new NotFoundException();
    const flowId = request.cookies?.[FLOW_COOKIE];
    response.clearCookie(FLOW_COOKIE, this.cookieOptions(location));
    if (!isUuid(flowId)) throw new UnauthorizedException();

    try {
      const { state, code } = request.query;
      if (typeof state !== 'string' || !isUuid(state) || typeof code !== 'string') throw new UnauthorizedException();
      const flow = await this.challenges.consumeConfiguredOidc(flowId, state);
      if (!flow) throw new UnauthorizedException();
      const settings = await resolveWorkspaceOidc(flow.connector?.workspaceId);
      if (!settings || settings.revision !== flow.connector?.revision) throw new UnauthorizedException();
      const client = await this.getClient(settings);
      const params = client.callbackParams(request);
      if (params.state !== state || params.code !== code) throw new UnauthorizedException();

      const token = await client.callback(settings.redirectUri, params, {
        state: params.state,
        nonce: flow.nonce,
        code_verifier: flow.codeVerifier,
        response_type: 'code',
      });
      const claims = token.claims();
      if (claims.iss !== settings.issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) {
        throw new UnauthorizedException();
      }

      const email = claims.email_verified === true && typeof claims.email === 'string' ? claims.email : undefined;
      const returnTo = await workspaceOidcReturnPath(flow.returnTo, settings);
      const active = await resolveWorkspaceOidc(settings.workspaceId);
      if (!active || active.revision !== settings.revision) {
        throw new UnauthorizedException();
      }
      await this.establishSession(
        response,
        settings.workspaceId,
        {
          issuer: claims.iss,
          sub: claims.sub,
          clientId: settings.clientId,
          ...(settings.revision && { revision: settings.revision }),
        },
        email
      );
      return returnTo;
    } catch {
      // Provider callback errors may include the code or token response.
      throw new UnauthorizedException('OIDC sign-in could not be completed');
    }
  }

  async establishSession(response: Response, workspaceId: string, identity: OidcIdentity, email?: string) {
    await dbTransactionWrap(async (manager: EntityManager) => {
      const workspace = await this.sessions.findOrganization(workspaceId, manager);
      const bindings = await manager.query<{ user_id: string }[]>(
        'SELECT user_id FROM configured_oidc_identities WHERE issuer = $1 AND subject = $2',
        [identity.issuer, identity.sub]
      );
      const boundUserId = bindings[0]?.user_id;
      if (!boundUserId && !email) throw new UnauthorizedException();

      const user = await manager.findOne(User, {
        where: {
          ...(boundUserId ? { id: boundUserId } : { email }),
          status: USER_STATUS.ACTIVE,
          organizationUsers: { organizationId: workspaceId, status: WORKSPACE_USER_STATUS.ACTIVE },
        },
      });
      if (!user) throw new UnauthorizedException();

      if (!boundUserId) {
        await manager.query(
          'INSERT INTO configured_oidc_identities (issuer, subject, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [identity.issuer, identity.sub, user.id]
        );
        const [binding] = await manager.query<{ user_id: string }[]>(
          'SELECT user_id FROM configured_oidc_identities WHERE issuer = $1 AND subject = $2',
          [identity.issuer, identity.sub]
        );
        if (binding?.user_id !== user.id) throw new UnauthorizedException();
      }

      await this.sessions.generateLoginResultPayload(
        response,
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
  }

  private async getClient(settings: ConfiguredOidcSettings) {
    const provider = await Issuer.discover(settings.issuer).catch(() => {
      throw new UnauthorizedException('OIDC provider is unavailable');
    });
    if (
      provider.issuer !== settings.issuer ||
      ![provider.authorization_endpoint, provider.token_endpoint, provider.jwks_uri].every(isHttpsUrl)
    ) {
      throw new UnauthorizedException('OIDC provider metadata does not match the configured issuer');
    }
    return new provider.Client({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      token_endpoint_auth_method: 'client_secret_basic',
      id_token_signed_response_alg: 'RS256',
      redirect_uris: [settings.redirectUri],
      response_types: ['code'],
    });
  }

  private cookieOptions(settings: Pick<ConfiguredOidcSettings, 'subpath'>) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'lax' as const,
      path: `${settings.subpath}/api/oauth/oidc/callback`,
    };
  }
}

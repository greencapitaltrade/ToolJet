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
} from './repository/sso-response.repository';
import {
  getConfiguredOidcSettings,
  isHttpsUrl,
  type ConfiguredOidcSettings,
  type OidcIdentity,
  oidcReturnPath,
} from './configured-oidc.config';

const FLOW_COOKIE = 'tj_oidc_flow';

@Injectable()
export class ConfiguredOidcService {
  constructor(
    private readonly challenges: SSOResponseRepository,
    private readonly sessions: SessionUtilService
  ) {}

  async start(response: Response, returnTo: unknown): Promise<string> {
    const settings = this.getSettings();
    const client = await this.getClient(settings);
    const state = randomUUID();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const flow = await this.challenges.createSSOResponse(
      state,
      JSON.stringify({ nonce, codeVerifier, returnTo: oidcReturnPath(returnTo, settings) }),
      CONFIGURED_OIDC_FLOW
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
    const settings = this.getSettings();
    const flowId = request.cookies?.[FLOW_COOKIE];
    response.clearCookie(FLOW_COOKIE, this.cookieOptions(settings));
    if (!isUuid(flowId)) throw new UnauthorizedException();

    try {
      const client = await this.getClient(settings);
      const params = client.callbackParams(request);
      if (!isUuid(params.state) || typeof params.code !== 'string') throw new UnauthorizedException();
      const flow = await this.challenges.consumeConfiguredOidc(flowId, params.state);
      if (!flow) throw new UnauthorizedException();

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
      await this.establishSession(response, settings.workspaceId, { issuer: claims.iss, sub: claims.sub }, email);
      return oidcReturnPath(flow.returnTo, settings);
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

  private getSettings() {
    const settings = getConfiguredOidcSettings();
    if (!settings) throw new NotFoundException();
    return settings;
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

  private cookieOptions(settings: ConfiguredOidcSettings) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'lax' as const,
      path: `${settings.subpath}/api/oauth/oidc/callback`,
    };
  }
}

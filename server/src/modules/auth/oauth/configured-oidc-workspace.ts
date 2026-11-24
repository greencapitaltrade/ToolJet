import { Injectable, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '@modules/session/guards/jwt-auth.guard';
import type { SessionUtilService } from '@modules/session/util.service';
import { getConfiguredOidcSettings } from './configured-oidc.config';

export type OidcWorkspaceRequest = Request & { user: Parameters<SessionUtilService['getOidcActor']>[0] };

@Injectable()
export class ConfiguredOidcWorkspaceGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = getConfiguredOidcSettings();
    const request: Request = context.switchToHttp().getRequest();
    if (
      !config ||
      request.headers.origin !== config.origin ||
      request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
      typeof request.cookies?.tj_auth_token !== 'string' ||
      !request.cookies.tj_auth_token ||
      request.cookies.tj_oauth_viewer ||
      request.headers.tj_auth_token ||
      request.headers['x-tooljet-delegation'] ||
      request.headers['tj-admin-api-key']
    ) {
      return false;
    }
    request.headers['tj-workspace-id'] = config.workspaceId;
    return (await super.canActivate(context)) === true;
  }
}

export function positiveId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && (value.length < 19 || value <= '9223372036854775807')
  );
}

export class ThorActorError extends Error {
  constructor(readonly status: 401 | 503) {
    super();
  }
}

export async function resolveThorActor(
  sessions: SessionUtilService,
  user: OidcWorkspaceRequest['user'],
  config: { issuer: string; clientId: string; thorOrigin: string }
): Promise<{ userId: string; organizationId: string }> {
  const actor = await sessions.getOidcActor(user).catch(() => null);
  if (actor?.issuer !== config.issuer || actor.clientId !== config.clientId || !positiveId(actor.sub)) {
    throw new ThorActorError(401);
  }

  const identity = await fetch(new URL(`/v1/users/oidc-subject/${actor.sub}`, config.thorOrigin).href, {
    method: 'GET',
    redirect: 'error',
    headers: { 'x-gct-oidc-issuer': actor.issuer, 'x-gct-oidc-client-id': actor.clientId },
    signal: AbortSignal.timeout(5_000),
  });
  if (!identity.ok) throw new ThorActorError(identity.status === 404 ? 401 : 503);
  const thorUser: { sub?: unknown; organization_id?: unknown } | null = await identity.json();
  if (thorUser?.sub !== actor.sub || !positiveId(thorUser.organization_id)) throw new ThorActorError(503);
  return { userId: actor.sub, organizationId: thorUser.organization_id };
}

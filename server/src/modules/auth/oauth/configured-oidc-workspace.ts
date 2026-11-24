import type { SessionUtilService } from '@modules/session/util.service';

export type OidcActorUser = Parameters<SessionUtilService['getOidcActor']>[0];

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
  user: OidcActorUser,
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

import { Body, Controller, type ExecutionContext, Header, Injectable, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MODULES } from '@modules/app/constants/modules';
import { InitFeature } from '@modules/app/decorators/init-feature.decorator';
import { InitModule } from '@modules/app/decorators/init-module';
import { JwtAuthGuard } from '@modules/session/guards/jwt-auth.guard';
import { SessionUtilService } from '@modules/session/util.service';
import { FeatureAbilityGuard } from '../ability/guard';
import { FEATURE_KEY } from '../constants';
import { getConfiguredOidcSettings } from './configured-oidc.config';

const readFields = ['partnerId', 'after'];
const operations = new Map([
  ['session', []],
  ['partners', readFields],
  ['borrowerApplications', readFields],
  ['borrowerDpd', readFields],
  ['dealerLink', ['partnerId']],
  ['borrowerLink', ['partnerId']],
  ['feeStatus', ['dealerId']],
  ['feeCheckout', ['dealerId']],
]);

const errors = new Map([
  [400, 'This action or its inputs are invalid.'],
  [401, 'Sign in with your organization account to continue.'],
  [403, 'You do not have access to this action.'],
  [404, 'This record is unavailable.'],
  [409, 'The record changed. Refresh and try again.'],
  [422, 'This record cannot be used for that action.'],
  [429, 'Too many requests. Try again later.'],
  [503, 'The operations service is unavailable. Try again later.'],
]);

function settings() {
  const oidc = getConfiguredOidcSettings();
  if (!oidc || process.env.TOOLJET_PARTNER_OPS_ISSUER !== oidc.issuer) return null;
  try {
    const upstream = new URL(process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN);
    const thor = new URL(process.env.TOOLJET_PARTNER_OPS_THOR_ORIGIN);
    // With HTTP, the deployment's workload mTLS policy supplies peer authentication.
    const mesh = upstream.protocol === 'http:' && upstream.hostname.endsWith('.svc.cluster.local');
    if (
      (!mesh && upstream.protocol !== 'https:') ||
      !['http:', 'https:'].includes(thor.protocol) ||
      !thor.hostname.endsWith('.svc.cluster.local') ||
      upstream.pathname !== '/' ||
      thor.pathname !== '/' ||
      upstream.search ||
      thor.search ||
      upstream.hash ||
      thor.hash ||
      upstream.username ||
      thor.username ||
      upstream.password ||
      thor.password
    ) {
      return null;
    }
    return {
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      origin: oidc.origin,
      workspaceId: oidc.workspaceId,
      endpoint: new URL('/v1/channel-partners/operator', upstream).href,
      thorOrigin: thor.origin,
    };
  } catch {
    return null;
  }
}

function positiveId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && (value.length < 19 || value <= '9223372036854775807')
  );
}

function validatedOperation(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { operation, ...fields } = body as Record<string, unknown>;
  if (typeof operation !== 'string') return null;
  const allowed = operations.get(operation);
  if (!allowed) return null;
  const values = Object.entries(fields);
  if (values.some(([key, value]) => !allowed.includes(key) || !positiveId(value))) return null;
  if (allowed.includes('dealerId') && !positiveId(fields.dealerId)) return null;
  return Object.fromEntries([['operation', operation], ...values]) as Record<string, string>;
}

type ViewerRequest = Request & { user: Parameters<SessionUtilService['getOidcActor']>[0] };

@Injectable()
export class PartnerOpsGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = settings();
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
    // Use the native JWT guard's active workspace membership check with the configured workspace.
    request.headers['tj-workspace-id'] = config.workspaceId;
    return (await super.canActivate(context)) === true;
  }
}

@Controller('partner-ops')
@InitModule(MODULES.AUTH)
@UseGuards(PartnerOpsGuard, FeatureAbilityGuard)
export class PartnerOpsController {
  constructor(private readonly sessions: SessionUtilService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @InitFeature(FEATURE_KEY.PARTNER_OPS)
  async relay(@Req() request: ViewerRequest, @Body() body: unknown, @Res() response: Response) {
    const fail = (status: number) => response.status(status).json({ error: errors.get(status) });
    const config = settings();
    if (!config) return fail(404);
    const input = validatedOperation(body);
    if (!input) return fail(400);
    const actor = await this.sessions.getOidcActor(request.user).catch(() => null);
    if (actor?.issuer !== config.issuer || actor.clientId !== config.clientId || !positiveId(actor.sub)) {
      return fail(401);
    }

    try {
      const identity = await fetch(new URL(`/v1/users/oidc-subject/${actor.sub}`, config.thorOrigin).href, {
        method: 'GET',
        redirect: 'error',
        headers: { 'x-gct-oidc-issuer': actor.issuer, 'x-gct-oidc-client-id': actor.clientId },
        signal: AbortSignal.timeout(5_000),
      });
      if (!identity.ok) return fail(identity.status === 404 ? 401 : 503);
      const thorUser: { sub?: unknown; organization_id?: unknown } | null = await identity.json();
      if (thorUser?.sub !== actor.sub || !positiveId(thorUser.organization_id)) return fail(503);

      const upstream = await fetch(config.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'x-gct-user-id': actor.sub,
          'x-gct-org-id': thorUser.organization_id,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(input.operation === 'feeCheckout' ? 35_000 : 20_000),
      });
      if (!upstream.ok) return fail(errors.has(upstream.status) ? upstream.status : 503);
      const result: { data?: unknown } = await upstream.json();
      if (!result?.data || typeof result.data !== 'object' || Array.isArray(result.data)) return fail(503);
      return response.status(200).json({ data: result.data });
    } catch {
      return fail(503);
    }
  }
}

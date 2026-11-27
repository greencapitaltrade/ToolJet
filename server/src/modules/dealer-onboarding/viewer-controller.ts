import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Issuer } from 'openid-client';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { FeatureAbilityGuard } from '@modules/app/ability/guard';
import { FEATURE_KEY } from '@modules/app/constants';
import { MODULES } from '@modules/app/constants/modules';
import { InitFeature } from '@modules/app/decorators/init-feature.decorator';
import { InitModule } from '@modules/app/decorators/init-module';
import { RedisService } from '@modules/redis/service';
import { App } from '@entities/app.entity';
import { AppVersion } from '@entities/app_version.entity';
import { getConfiguredOidcSettings } from '@modules/auth/oauth/configured-oidc.config';
import { privateServiceOrigin } from '@helpers/private-service-origin';
import { DEALER_VIEWER_COOKIE, DEALER_VIEWER_ENV, dealerViewerConfig } from '@modules/data-queries/dealer-viewer';
import { getOidcRestSourceOrigin } from '@modules/data-queries/oidc-rest';
import { ApplicantSessions } from '../applicant-session/store';
import { DealerOidcBroker, DealerOidcRedisStore, dealerOidcEndpointAllowed } from './oidc-broker';
import { DealerViewerLogin } from './viewer-login';

const FLOW_COOKIE = '__Host-tj-dealer-flow';
const STATE_COOKIE = '__Host-tj-dealer-state';
const cookie = { secure: true, httpOnly: true, sameSite: 'lax' as const, path: '/' };
type Viewer = { referral: string; personToken?: string; userId?: string; organizationId?: string; email?: string; emailVerified?: true };

@Controller('dealer-onboarding/viewer')
@InitModule(MODULES.ROOT)
@UseGuards(FeatureAbilityGuard)
export class DealerViewerController {
  constructor(private readonly config: ConfigService, private readonly redis: RedisService, private readonly db: DataSource) {}

  private async context() {
    const scope = dealerViewerConfig(this.config.get<string>(DEALER_VIEWER_ENV), this.config.get<string>('SECRET_KEY_BASE'));
    const oidc = getConfiguredOidcSettings();
    const thor = privateServiceOrigin(this.config.get<string>('TOOLJET_OIDC_THOR_ORIGIN'));
    const intentSecret = this.config.get<string>('TOOLJET_DEALER_ENROLLMENT_INTENT_SECRET');
    const clientId = this.config.get<string>('TOOLJET_DEALER_OIDC_CLIENT_ID');
    const clientSecret = this.config.get<string>('TOOLJET_DEALER_OIDC_CLIENT_SECRET');
    if (!scope || !oidc || oidc.origin !== scope.origin || !thor || !intentSecret || !clientId || !clientSecret || clientId === oidc.clientId) throw new Error();
    const destiny = getOidcRestSourceOrigin(scope.sourceId);
    if (!destiny) throw new Error();
    const app = await this.db.getRepository(App).findOne({ where: { id: scope.appId } });
    if (!app?.currentVersionId || app.organizationId !== oidc.workspaceId) throw new Error();
    const version = await this.db.getRepository(AppVersion).findOne({ where: { id: app.currentVersionId, appId: app.id } });
    const slug = version?.slug;
    if (!version?.isPublic || !slug || !/^[A-Za-z0-9_-]+$/.test(slug)) throw new Error();
    const redirectUri = `${oidc.origin}${oidc.subpath}/api/dealer-onboarding/viewer/callback`;
    const provider = await Issuer.discover(oidc.issuer);
    if (provider.issuer !== oidc.issuer || ![provider.authorization_endpoint, provider.token_endpoint, provider.jwks_uri].every((endpoint) => dealerOidcEndpointAllowed(oidc.issuer, endpoint))) throw new Error();
    const client = new provider.Client({ client_id: clientId, client_secret: clientSecret,
      token_endpoint_auth_method: 'client_secret_basic', id_token_signed_response_alg: 'RS256', redirect_uris: [redirectUri], response_types: ['code'] });
    const connection = { call: (command: string, ...args: string[]) => this.redis.getClient().call(command, ...args) };
    const sessions = new ApplicantSessions<Viewer>(connection, 'dealer-viewer');
    const state = new DealerOidcRedisStore(connection, scope.organizationId, scope.lspSecret);
    const broker = new DealerOidcBroker({ issuer: oidc.issuer, clientId, organizationId: scope.organizationId, redirectUri, intentSecret }, state, client, async (subject) => {
      const response = await fetch(new URL(`/v1/users/oidc-subject/${subject}`, thor).href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'x-gct-oidc-issuer': oidc.issuer, 'x-gct-oidc-client-id': clientId } });
      if (!response.ok) throw new Error();
      return response.json();
    });
    return { scope, sessions, login: new DealerViewerLogin(scope, destiny, sessions, broker), redirect: `${oidc.subpath}/applications/${encodeURIComponent(slug)}` };
  }

  @Post('start')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async start(@Req() req: Request, @Res() res: Response) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    try {
      const scope = dealerViewerConfig(this.config.get<string>(DEALER_VIEWER_ENV), this.config.get<string>('SECRET_KEY_BASE'));
      if (!scope || req.originalUrl.includes('?') || req.get('origin') !== scope.origin ||
        (req.get('sec-fetch-site') && req.get('sec-fetch-site') !== 'same-origin') || !req.is('application/json') ||
        Number(req.get('content-length')) > 16384 || Buffer.byteLength(JSON.stringify(req.body ?? null)) > 16384 || !req.body || !['referral', 'referral,personToken', 'personToken,referral'].includes(Object.keys(req.body).join())) throw new Error();
      const limiter = new ApplicantSessions<Viewer>({ call: (command, ...args) => this.redis.getClient().call(command, ...args) }, 'dealer-viewer');
      await limiter.rate(scope, 'viewer-start', req.ip || 'unknown', 20, 600);
      const ctx = await this.context();
      const result = await ctx.login.start(req.body.referral, req.body.personToken);
      res.cookie(FLOW_COOKIE, result.id, { ...cookie, maxAge: 600000 });
      res.cookie(STATE_COOKIE, result.state, { ...cookie, maxAge: 600000 });
      return res.status(200).json({ url: result.url });
    } catch { return res.status(503).json({ error: 'Dealer login unavailable' }); }
  }

  @Get('callback')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async callback(@Req() req: Request, @Res() res: Response) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.clearCookie(FLOW_COOKIE, cookie); res.clearCookie(STATE_COOKIE, cookie);
    try {
      const ctx = await this.context();
      const { state, code, iss } = req.query;
      if (typeof state !== 'string' || typeof code !== 'string' ||
        (iss !== undefined && (typeof iss !== 'string' || !iss))) throw new Error();
      const session = await ctx.login.callback(
        { state, code, ...(iss !== undefined ? { iss } : {}) },
        req.cookies?.[FLOW_COOKIE], req.cookies?.[STATE_COOKIE]
      );
      res.cookie(DEALER_VIEWER_COOKIE, session.id, { ...cookie, maxAge: 1800000 });
      return res.redirect(303, `${ctx.redirect}${session.director ? '?director=1' : ''}`);
    } catch { return res.status(503).send('Dealer login unavailable'); }
  }
}

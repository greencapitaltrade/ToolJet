import { createHmac } from 'node:crypto';
import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { FeatureAbilityGuard } from '@modules/app/ability/guard';
import { FEATURE_KEY } from '@modules/app/constants';
import { MODULES } from '@modules/app/constants/modules';
import { InitFeature } from '@modules/app/decorators/init-feature.decorator';
import { InitModule } from '@modules/app/decorators/init-module';
import { RedisService } from '@modules/redis/service';
import { privateServiceOrigin } from '../../helpers/private-service-origin';
import { exactHttpsOrigin, rejectApplicant } from '../applicant-session/fury';
import { ApplicantHttpRequest, handleApplicantRequest } from '../applicant-session/http';
import { ApplicantRedis } from '../applicant-session/store';
import { DEALER_PARTICIPANT_ENV, DealerParticipant, parseDealerParticipantConfig } from './participant';
import { parseDealerUpload, parseDealerSelfie } from './upload';
import {
  DEALER_ONBOARDING_ENV,
  DEALER_OWNER_KYC_ORIGIN,
  DealerOnboarding,
  parseDealerOnboardingConfig,
  type VnDealerScope,
} from './relay';
import { DEALER_VOLTCRED_BRIDGE_ENV, parseDealerVoltcredBridge, parseTrustedVoltcredReceipt } from './voltcred-bridge';
import { createDealerOidcBroker } from './oidc-factory';
import { parseVnAdmissionConfig } from './admission';

const vnCallbackPath = '/api/dealer-onboarding/vn/callback';
const dealerCookie = '__Host-tj-dealer-onboarding';

@Controller('dealer-onboarding')
@InitModule(MODULES.ROOT)
@UseGuards(FeatureAbilityGuard)
export class DealerOnboardingController {
  private readonly relay: DealerOnboarding;
  private readonly participant: DealerParticipant;
  private readonly connection: ApplicantRedis;
  private vnBroker?: ReturnType<typeof createDealerOidcBroker>;

  constructor(
    private readonly config: ConfigService,
    redis: RedisService
  ) {
    const connection: ApplicantRedis = { call: (command, ...args) => redis.getClient().call(command, ...args) };
    this.connection = connection;
    this.relay = new DealerOnboarding(connection);
    this.participant = new DealerParticipant(
      connection,
      fetch,
      this.config.get<string>('TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN')
    );
  }

  @Post()
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async handle(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const participant = parseDealerParticipantConfig(this.config.get<string>(DEALER_PARTICIPANT_ENV));
    const settings = parseDealerOnboardingConfig(this.config.get<string>(DEALER_ONBOARDING_ENV), participant);
    return handleApplicantRequest(req, res, settings, 'dealer', this.relay.run.bind(this.relay));
  }

  private voltcredSettings() {
    const scope = parseDealerOnboardingConfig(this.config.get<string>(DEALER_ONBOARDING_ENV));
    const voltcred = parseDealerVoltcredBridge(this.config.get<string>(DEALER_VOLTCRED_BRIDGE_ENV));
    return scope && voltcred ? { ...scope, voltcred } : null;
  }

  private async vnSettings(): Promise<
    ({ scope: VnDealerScope } & Awaited<ReturnType<typeof createDealerOidcBroker>>) | null
  > {
    const rawAdmission = this.config.get<string>('TOOLJET_DEALER_VN_ADMISSION');
    if (!process.env.TOOLJET_DEALER_VN_OIDC) return null;
    const legacy =
      rawAdmission === undefined ? parseDealerOnboardingConfig(this.config.get<string>(DEALER_ONBOARDING_ENV)) : null;
    try {
      this.vnBroker ??= createDealerOidcBroker(process.env, { redis: this.connection });
      const { broker, config } = await this.vnBroker;
      const destinyOrigin = privateServiceOrigin(config.destinyOrigin);
      const admission = parseVnAdmissionConfig(rawAdmission, config.organizationId);
      if (rawAdmission !== undefined && !admission) return null;
      const origin = admission ? this.config.get<string>('TOOLJET_HOST') : legacy?.origin;
      if (
        !origin ||
        !exactHttpsOrigin(origin) ||
        !destinyOrigin ||
        !privateServiceOrigin(config.thorOrigin) ||
        config.redirectUri !== new URL(vnCallbackPath, origin).href ||
        new URL(config.viewerUrl).origin !== origin
      )
        return null;
      const vn = { actorOrganizationId: config.organizationId, destinyOrigin, viewerUrl: config.viewerUrl };
      if (!admission) {
        if (!legacy || config.organizationId !== legacy.organizationId) return null;
        return { scope: { ...legacy, vn }, broker, config };
      }
      const scope: VnDealerScope = {
        origin,
        organizationId: config.organizationId,
        namespace: 'signed-admission',
        sessionKey: createHmac('sha256', admission.hmacSecret).update('tooljet-vn-session-v1').digest('hex'),
        admission,
        vn,
      };
      return { scope, broker, config };
    } catch {
      this.vnBroker = undefined;
      return null;
    }
  }

  private async publicSettings(realm: unknown) {
    if (realm === 'vn') {
      const scope = (await this.vnSettings())?.scope;
      return scope && !scope.admission ? scope : null;
    }
    if (realm === 'voltcred') return this.voltcredSettings();
    return null;
  }

  @Post('vn/start')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async startVn(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const vn = await this.vnSettings();
    return handleApplicantRequest(req, res, vn?.scope ?? null, 'dealer', (scope, input, _id, setCookie) =>
      this.relay.startVn(scope, vn!.broker, input, setCookie)
    );
  }

  @Post('vn/participant/start')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async startVnParticipant(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const vn = await this.vnSettings();
    const secret = process.env.THOR_VN_DEALER_ENROLLMENT_SECRET || '';
    return handleApplicantRequest(
      req,
      res,
      vn?.scope.admission ? vn.scope : null,
      'dealer',
      (scope, input, _id, setCookie) =>
        this.relay.startVnParticipant(scope, vn!.broker, vn!.config.clientId, secret, input, setCookie)
    );
  }

  @Post('vn/participant/recheck')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async recheckVnParticipant(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const vn = await this.vnSettings();
    if (
      !vn?.scope.admission ||
      !req.is('application/json') ||
      Object.keys(req.query).length ||
      Number(req.get('content-length')) > 16384 ||
      typeof req.rawBody !== 'string' ||
      Buffer.byteLength(req.rawBody) > 16384
    )
      return res.status(403).json({ error: 'Unavailable' });
    try {
      const result = await this.relay.recheckVnParticipant(
        vn.scope,
        vn.config.clientId,
        process.env.THOR_VN_DEALER_ENROLLMENT_SECRET || '',
        req.body,
        req.get('x-gct-participant-issued-at') || '',
        req.get('x-gct-participant-recheck-signature') || '',
        req.rawBody
      );
      return res.status(200).json(result);
    } catch {
      return res.status(403).json({ error: 'Unavailable' });
    }
  }

  @Post('vn/signer/start')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async startVnSigner(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const vn = await this.vnSettings();
    return handleApplicantRequest(
      req,
      res,
      vn?.scope.admission ? vn.scope : null,
      'dealer',
      (scope, input, _id, setCookie) =>
        this.relay.startVnSigner(
          scope,
          vn!.broker,
          vn!.config.clientId,
          process.env.THOR_VN_DEALER_ENROLLMENT_SECRET || '',
          input,
          setCookie
        )
    );
  }

  @Post('vn/signer/recheck')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async recheckVnSigner(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const vn = await this.vnSettings();
    if (
      !vn?.scope.admission ||
      !req.is('application/json') ||
      Object.keys(req.query).length ||
      Number(req.get('content-length')) > 16384 ||
      typeof req.rawBody !== 'string' ||
      Buffer.byteLength(req.rawBody) > 16384
    )
      return res.status(403).json({ error: 'Unavailable' });
    try {
      return res
        .status(200)
        .json(
          await this.relay.recheckVnSigner(
            vn.scope,
            vn.config.clientId,
            process.env.THOR_VN_DEALER_ENROLLMENT_SECRET || '',
            req.body,
            req.get('x-signer-issued-at') || '',
            req.get('x-signer-recheck-signature') || '',
            req.rawBody
          )
        );
    } catch {
      return res.status(403).json({ error: 'Unavailable' });
    }
  }

  @Post('vn/signer/sign')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async signVnSigner(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const vn = await this.vnSettings();
    const signingOrigin = this.config.get<string>('TOOLJET_DEALER_SIGNING_ORIGIN');
    const scope = vn?.scope.admission && exactHttpsOrigin(signingOrigin) ? { ...vn.scope, signingOrigin } : null;
    return handleApplicantRequest(req, res, scope, 'dealer', (settings, input, id) =>
      this.relay.signVnSigner(
        settings,
        vn!.config.clientId,
        process.env.THOR_VN_DEALER_ENROLLMENT_SECRET || '',
        input,
        id
      )
    );
  }

  @Post('vn/signer/invite')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async inviteVnSigner(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const scope = (await this.vnSettings())?.scope;
    return handleApplicantRequest(
      req,
      res,
      scope?.admission ? scope : null,
      'dealer',
      this.relay.inviteVnSigner.bind(this.relay)
    );
  }

  @Post('vn/participant/kyc')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async participantKycVn(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const vn = await this.vnSettings();
    const kycOrigin = this.config.get<string>(DEALER_OWNER_KYC_ORIGIN);
    const scope = vn?.scope.admission && exactHttpsOrigin(kycOrigin) ? { ...vn.scope, kycOrigin } : null;
    return handleApplicantRequest(req, res, scope, 'dealer', this.relay.participantKycVn.bind(this.relay));
  }

  @Post('vn/participant/selfie')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async participantSelfieVn(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const vn = await this.vnSettings();
    const kycOrigin = this.config.get<string>(DEALER_OWNER_KYC_ORIGIN);
    const scope = vn?.scope.admission && exactHttpsOrigin(kycOrigin) ? { ...vn.scope, kycOrigin } : null;
    return handleApplicantRequest(
      req,
      res,
      scope,
      'dealer',
      (settings, _body, id) => this.relay.participantSelfieVn(settings, () => parseDealerSelfie(req, res), id),
      'multipart/form-data'
    );
  }

  @Post('vn/session')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async sessionVn(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      (await this.vnSettings())?.scope ?? null,
      'dealer',
      this.relay.sessionVn.bind(this.relay)
    );
  }

  @Post('vn/admission-lookup')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async lookupVnAdmission(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const scope = (await this.vnSettings())?.scope;
    return handleApplicantRequest(
      req,
      res,
      scope?.admission ? scope : null,
      'dealer',
      this.relay.lookupVnAdmission.bind(this.relay)
    );
  }

  @Post('vn/admission-open')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async openVnAdmission(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const scope = (await this.vnSettings())?.scope;
    return handleApplicantRequest(
      req,
      res,
      scope?.admission ? scope : null,
      'dealer',
      this.relay.openVnAdmission.bind(this.relay)
    );
  }

  @Post('vn/admission')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async admitVn(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const scope = (await this.vnSettings())?.scope;
    return handleApplicantRequest(
      req,
      res,
      scope?.admission ? scope : null,
      'dealer',
      this.relay.admitVnAction.bind(this.relay)
    );
  }

  @Post('vn/admission-status')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async resumeVnAdmission(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const scope = (await this.vnSettings())?.scope;
    return handleApplicantRequest(
      req,
      res,
      scope?.admission ? scope : null,
      'dealer',
      this.relay.resumeVnAdmission.bind(this.relay)
    );
  }

  @Post('vn/admission-document')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async uploadVnAdmissionDocument(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const scope = (await this.vnSettings())?.scope;
    return handleApplicantRequest(
      req,
      res,
      scope?.admission ? scope : null,
      'dealer',
      (settings, _body, id) => this.relay.uploadVnAdmissionDocument(settings, () => parseDealerUpload(req, res), id),
      'multipart/form-data'
    );
  }

  @Post('vn/roster')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async rosterVn(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const scope = (await this.vnSettings())?.scope;
    return handleApplicantRequest(
      req,
      res,
      scope?.admission ? scope : null,
      'dealer',
      this.relay.rosterVn.bind(this.relay)
    );
  }

  @Post('vn/financial')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async financialVn(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const scope = (await this.vnSettings())?.scope;
    const bankConsentOrigin = this.config.get<string>('TOOLJET_DEALER_BANK_AA_ORIGIN');
    const settings = scope?.admission && exactHttpsOrigin(bankConsentOrigin) ? { ...scope, bankConsentOrigin } : null;
    return handleApplicantRequest(req, res, settings, 'dealer', this.relay.financialVn.bind(this.relay));
  }

  @Get('vn/callback')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async finishVn(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const unavailable = (status: number) => res.status(status).json({ error: 'Dealer verification unavailable' });
    const vn = await this.vnSettings();
    if (!vn) return unavailable(404);
    const { state, code, iss } = req.query;
    if (
      Object.keys(req.query).some((name) => !['code', 'state', 'iss'].includes(name)) ||
      (iss !== undefined && iss !== vn.config.issuer) ||
      typeof state !== 'string' ||
      typeof code !== 'string'
    )
      return unavailable(400);
    const id = req.cookies?.[dealerCookie];
    if (typeof id !== 'string') return unavailable(401);
    try {
      await this.relay.finishVn(
        vn.scope,
        vn.broker,
        { code, state },
        id,
        (fresh, ttl) => {
          res.cookie(dealerCookie, fresh, {
            secure: true,
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: ttl * 1000,
          });
        },
        { clientId: vn.config.clientId, secret: process.env.THOR_VN_DEALER_ENROLLMENT_SECRET || '' }
      );
      return res.redirect(303, vn.config.viewerUrl);
    } catch {
      return unavailable(401);
    }
  }

  @Post('voltcred/start')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async startVoltcred(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      this.voltcredSettings(),
      'dealer',
      this.relay.startVoltcred.bind(this.relay)
    );
  }

  @Post('voltcred/receive')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async receiveVoltcred(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const unavailable = (status: number) => res.status(status).json({ error: 'Dealer verification unavailable' });
    const scope = this.voltcredSettings();
    if (!scope) return unavailable(404);
    if (req.originalUrl.includes('?') || !req.is('application/json')) return unavailable(400);
    const receipt = parseTrustedVoltcredReceipt(scope.voltcred, req.get('authorization'), req.body);
    if (!receipt) return unavailable(401);
    try {
      return res.status(200).json(await this.relay.receiveVoltcred(scope, receipt));
    } catch {
      return unavailable(409);
    }
  }

  @Post('voltcred/finish')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async finishVoltcred(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      this.voltcredSettings(),
      'dealer',
      this.relay.finishVoltcred.bind(this.relay)
    );
  }

  @Post(':dealerRealm/status')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async statusVoltcred(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.publicSettings(req.params.dealerRealm),
      'dealer',
      this.relay.statusVoltcred.bind(this.relay)
    );
  }

  @Post(':dealerRealm/evidence/status')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async evidenceStatusVoltcred(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.publicSettings(req.params.dealerRealm),
      'dealer',
      this.relay.evidenceStatusVoltcred.bind(this.relay)
    );
  }

  @Post('vn/execution')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async executionVn(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const scope = (await this.vnSettings())?.scope;
    const owner = scope?.admission ? scope : await this.publicOwnerSettings('vn');
    return handleApplicantRequest(
      req,
      res,
      owner && 'vn' in owner ? owner : null,
      'dealer',
      this.relay.executionVn.bind(this.relay)
    );
  }

  @Post(':dealerRealm/review')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async reviewVoltcred(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const realm = req.params.dealerRealm;
    const scope = realm === 'vn' ? ((await this.vnSettings())?.scope ?? null) : await this.publicSettings(realm);
    return handleApplicantRequest(req, res, scope, 'dealer', this.relay.reviewVoltcred.bind(this.relay));
  }

  @Post(':dealerRealm/agreement')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async agreementVoltcred(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const vn = req.params.dealerRealm === 'vn' ? (await this.vnSettings())?.scope : null;
    const owner = vn?.admission ? vn : await this.publicOwnerSettings(req.params.dealerRealm);
    const participant = parseDealerParticipantConfig(this.config.get<string>(DEALER_PARTICIPANT_ENV));
    const matched = parseDealerOnboardingConfig(this.config.get<string>(DEALER_ONBOARDING_ENV), participant);
    return handleApplicantRequest(
      req,
      res,
      owner ? { ...owner, signingOrigin: matched?.signingOrigin } : null,
      'dealer',
      this.relay.agreementVoltcred.bind(this.relay)
    );
  }

  @Post(':dealerRealm/people/status')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async peopleStatusVoltcred(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.publicSettings(req.params.dealerRealm),
      'dealer',
      this.relay.peopleStatusVoltcred.bind(this.relay)
    );
  }

  private async publicOwnerSettings(realm: unknown) {
    const settings = await this.publicSettings(realm);
    const ownerHmacKey = this.config.get<string>('TOOLJET_DEALER_PUBLIC_OWNER_HMAC_KEY');
    const kycOrigin = this.config.get<string>(DEALER_OWNER_KYC_ORIGIN);
    return settings &&
      typeof ownerHmacKey === 'string' &&
      /^[\x21-\x7e]{32,512}$/.test(ownerHmacKey) &&
      exactHttpsOrigin(kycOrigin)
      ? { ...settings, ownerHmacKey, kycOrigin }
      : null;
  }

  @Post(':dealerRealm/people/owner')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async publicOwner(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.publicOwnerSettings(req.params.dealerRealm),
      'dealer',
      this.relay.publicOwnerVoltcred.bind(this.relay)
    );
  }

  @Post(':dealerRealm/people/owner/selfie')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async publicOwnerSelfie(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.publicOwnerSettings(req.params.dealerRealm),
      'dealer',
      (scope, _body, id) => this.relay.publicOwnerSelfieVoltcred(scope, () => parseDealerSelfie(req, res), id),
      'multipart/form-data'
    );
  }

  @Post(':dealerRealm/lookup')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async lookupVoltcred(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.publicSettings(req.params.dealerRealm),
      'dealer',
      this.relay.lookupVoltcred.bind(this.relay)
    );
  }

  @Post(':dealerRealm/evidence/upload')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async uploadVoltcredEvidence(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.publicSettings(req.params.dealerRealm),
      'dealer',
      (scope, _body, id) => this.relay.uploadVoltcredEvidence(scope, () => parseDealerUpload(req, res), id),
      'multipart/form-data'
    );
  }

  @Post(':dealerRealm/open')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async openVoltcred(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.publicSettings(req.params.dealerRealm),
      'dealer',
      this.relay.openVoltcred.bind(this.relay)
    );
  }

  private async bankSettings(realm: unknown) {
    const settings = await this.publicSettings(realm);
    const bankConsentOrigin = this.config.get<string>('TOOLJET_DEALER_BANK_AA_ORIGIN');
    return settings && exactHttpsOrigin(bankConsentOrigin) ? { ...settings, bankConsentOrigin } : null;
  }

  @Post(':dealerRealm/bank/start')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async startBank(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.bankSettings(req.params.dealerRealm),
      'dealer',
      this.relay.startFinancialVoltcred.bind(this.relay, 'bank')
    );
  }

  @Post(':dealerRealm/bank/status')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async statusBank(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.bankSettings(req.params.dealerRealm),
      'dealer',
      this.relay.statusFinancialVoltcred.bind(this.relay, 'bank')
    );
  }

  @Post(':dealerRealm/bank/sync')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async syncBank(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.bankSettings(req.params.dealerRealm),
      'dealer',
      this.relay.syncFinancialVoltcred.bind(this.relay, 'bank')
    );
  }

  @Post(':dealerRealm/bank/options')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async optionsBank(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.bankSettings(req.params.dealerRealm),
      'dealer',
      this.relay.optionsFinancialVoltcred.bind(this.relay, 'bank')
    );
  }

  @Post(':dealerRealm/bank/attach')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async attachBank(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.bankSettings(req.params.dealerRealm),
      'dealer',
      this.relay.attachFinancialVoltcred.bind(this.relay, 'bank')
    );
  }

  @Post(':dealerRealm/gst/start')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async startGst(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.bankSettings(req.params.dealerRealm),
      'dealer',
      this.relay.startFinancialVoltcred.bind(this.relay, 'gst')
    );
  }

  @Post(':dealerRealm/gst/status')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async statusGst(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.bankSettings(req.params.dealerRealm),
      'dealer',
      this.relay.statusFinancialVoltcred.bind(this.relay, 'gst')
    );
  }

  @Post(':dealerRealm/gst/sync')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async syncGst(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.bankSettings(req.params.dealerRealm),
      'dealer',
      this.relay.syncFinancialVoltcred.bind(this.relay, 'gst')
    );
  }

  @Post(':dealerRealm/gst/options')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async optionsGst(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.bankSettings(req.params.dealerRealm),
      'dealer',
      this.relay.optionsFinancialVoltcred.bind(this.relay, 'gst')
    );
  }

  @Post(':dealerRealm/gst/attach')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async attachGst(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      await this.bankSettings(req.params.dealerRealm),
      'dealer',
      this.relay.attachFinancialVoltcred.bind(this.relay, 'gst')
    );
  }

  @Post('dossier')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async dossier(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const settings = parseDealerOnboardingConfig(this.config.get<string>(DEALER_ONBOARDING_ENV));
    return handleApplicantRequest(req, res, settings, 'dealer', (scope, body, id) => {
      if (req.originalUrl.includes('?')) return rejectApplicant(400);
      return this.relay.dossier(scope, body, id);
    });
  }

  @Post('participant')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async handleParticipant(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const settings = parseDealerParticipantConfig(this.config.get<string>(DEALER_PARTICIPANT_ENV));
    return handleApplicantRequest(
      req,
      res,
      settings,
      'dealer-participant',
      this.participant.run.bind(this.participant)
    );
  }

  @Post('participant/selfie')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async uploadParticipantSelfie(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const settings = parseDealerParticipantConfig(this.config.get<string>(DEALER_PARTICIPANT_ENV));
    return handleApplicantRequest(
      req,
      res,
      settings,
      'dealer-participant',
      (scope, _body, id) => this.participant.uploadSelfie(scope, () => parseDealerSelfie(req, res), id),
      'multipart/form-data'
    );
  }

  private ownerKycSettings() {
    const participant = parseDealerParticipantConfig(this.config.get<string>(DEALER_PARTICIPANT_ENV));
    const settings = parseDealerOnboardingConfig(this.config.get<string>(DEALER_ONBOARDING_ENV), participant);
    const kycOrigin = this.config.get<string>(DEALER_OWNER_KYC_ORIGIN);
    return settings && exactHttpsOrigin(kycOrigin) ? { ...settings, kycOrigin } : null;
  }

  @Post('identity')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async ownerKyc(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(req, res, this.ownerKycSettings(), 'dealer', this.relay.ownerKyc.bind(this.relay));
  }

  @Post('identity/selfie')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async uploadOwnerSelfie(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    return handleApplicantRequest(
      req,
      res,
      this.ownerKycSettings(),
      'dealer',
      (scope, _body, id) => this.relay.uploadOwnerSelfie(scope, () => parseDealerSelfie(req, res), id),
      'multipart/form-data'
    );
  }

  @Post('document')
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async upload(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const settings = parseDealerOnboardingConfig(this.config.get<string>(DEALER_ONBOARDING_ENV));
    return handleApplicantRequest(
      req,
      res,
      settings,
      'dealer',
      (scope, _body, id) => this.relay.upload(scope, () => parseDealerUpload(req, res), id),
      'multipart/form-data'
    );
  }
}

import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { FeatureAbilityGuard } from '@modules/app/ability/guard';
import { FEATURE_KEY } from '@modules/app/constants';
import { MODULES } from '@modules/app/constants/modules';
import { InitFeature } from '@modules/app/decorators/init-feature.decorator';
import { InitModule } from '@modules/app/decorators/init-module';
import { RedisService } from '@modules/redis/service';
import { exactHttpsOrigin, rejectApplicant } from '../applicant-session/fury';
import { ApplicantHttpRequest, handleApplicantRequest } from '../applicant-session/http';
import { ApplicantRedis } from '../applicant-session/store';
import { DEALER_PARTICIPANT_ENV, DealerParticipant, parseDealerParticipantConfig } from './participant';
import { parseDealerUpload, parseDealerSelfie } from './upload';
import { DEALER_ONBOARDING_ENV, DEALER_OWNER_KYC_ORIGIN, DealerOnboarding, parseDealerOnboardingConfig } from './relay';

@Controller('dealer-onboarding')
@InitModule(MODULES.ROOT)
@UseGuards(FeatureAbilityGuard)
export class DealerOnboardingController {
  private readonly relay: DealerOnboarding;
  private readonly participant: DealerParticipant;

  constructor(
    private readonly config: ConfigService,
    redis: RedisService
  ) {
    const connection: ApplicantRedis = { call: (command, ...args) => redis.getClient().call(command, ...args) };
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

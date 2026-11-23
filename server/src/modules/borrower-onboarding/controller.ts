import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { FeatureAbilityGuard } from '@modules/app/ability/guard';
import { FEATURE_KEY } from '@modules/app/constants';
import { MODULES } from '@modules/app/constants/modules';
import { InitFeature } from '@modules/app/decorators/init-feature.decorator';
import { InitModule } from '@modules/app/decorators/init-module';
import { RedisService } from '@modules/redis/service';
import { ApplicantHttpRequest, handleApplicantRequest } from '../applicant-session/http';
import { BORROWER_ONBOARDING_ENV, BorrowerOnboarding, parseBorrowerOnboardingConfig } from './relay';
import { parseBorrowerUpload } from './upload';

@Controller('borrower-onboarding')
@InitModule(MODULES.ROOT)
@UseGuards(FeatureAbilityGuard)
export class BorrowerOnboardingController {
  private readonly relay: BorrowerOnboarding;

  constructor(
    private readonly config: ConfigService,
    redis: RedisService
  ) {
    this.relay = new BorrowerOnboarding({
      call: (command, ...args) => redis.getClient().call(command, ...args),
    });
  }

  @Post()
  @InitFeature(FEATURE_KEY.BORROWER_ONBOARDING)
  async handle(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const settings = parseBorrowerOnboardingConfig(this.config.get<string>(BORROWER_ONBOARDING_ENV));
    return handleApplicantRequest(req, res, settings, 'borrower', this.relay.run.bind(this.relay));
  }

  @Post('document')
  @InitFeature(FEATURE_KEY.BORROWER_ONBOARDING)
  async upload(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const settings = parseBorrowerOnboardingConfig(this.config.get<string>(BORROWER_ONBOARDING_ENV));
    return handleApplicantRequest(
      req,
      res,
      settings,
      'borrower',
      (scope, _body, id) => this.relay.upload(scope, () => parseBorrowerUpload(req, res), id),
      'multipart/form-data'
    );
  }
}

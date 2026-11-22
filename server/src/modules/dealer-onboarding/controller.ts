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
import { DEALER_ONBOARDING_ENV, DealerOnboarding, parseDealerOnboardingConfig } from './relay';

@Controller('dealer-onboarding')
@InitModule(MODULES.ROOT)
@UseGuards(FeatureAbilityGuard)
export class DealerOnboardingController {
  private readonly relay: DealerOnboarding;

  constructor(
    private readonly config: ConfigService,
    redis: RedisService
  ) {
    this.relay = new DealerOnboarding({ call: (command, ...args) => redis.getClient().call(command, ...args) });
  }

  @Post()
  @InitFeature(FEATURE_KEY.DEALER_ONBOARDING)
  async handle(@Req() req: ApplicantHttpRequest, @Res() res: Response) {
    const settings = parseDealerOnboardingConfig(this.config.get<string>(DEALER_ONBOARDING_ENV));
    return handleApplicantRequest(req, res, settings, 'dealer', this.relay.run.bind(this.relay));
  }
}

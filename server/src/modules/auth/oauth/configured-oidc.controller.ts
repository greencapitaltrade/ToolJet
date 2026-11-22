import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MODULES } from '@modules/app/constants/modules';
import { InitFeature } from '@modules/app/decorators/init-feature.decorator';
import { InitModule } from '@modules/app/decorators/init-module';
import { FeatureAbilityGuard } from '../ability/guard';
import { FEATURE_KEY } from '../constants';
import { ConfiguredOidcService } from './configured-oidc.service';

@Controller('oauth/oidc')
@InitModule(MODULES.AUTH)
@UseGuards(FeatureAbilityGuard)
export class ConfiguredOidcController {
  constructor(private readonly oidc: ConfiguredOidcService) {}

  @Get('start')
  @InitFeature(FEATURE_KEY.OAUTH_OPENID_CONFIGS)
  async start(@Query('returnTo') returnTo: string, @Res() response: Response) {
    response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    response.redirect(await this.oidc.start(response, returnTo));
  }

  @Get('callback')
  @InitFeature(FEATURE_KEY.OAUTH_SIGN_IN)
  async callback(@Req() request: Request, @Res() response: Response) {
    response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    response.redirect(await this.oidc.complete(request, response));
  }
}

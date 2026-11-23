import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { FeatureAbilityGuard } from '@modules/app/ability/guard';
import { FEATURE_KEY } from '@modules/app/constants';
import { MODULES } from '@modules/app/constants/modules';
import { InitFeature } from '@modules/app/decorators/init-feature.decorator';
import { InitModule } from '@modules/app/decorators/init-module';
import { RedisService } from '@modules/redis/service';
import { ApplicantRequestError } from '../applicant-session/fury';
import { BORROWER_ONBOARDING_ENV, BorrowerOnboarding, parseBorrowerOnboardingConfig } from './relay';

const sessionCookie = '__Host-tj-borrower-onboarding';

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
  async handle(@Req() req: Request & { rawBody?: string }, @Res() res: Response) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const settings = parseBorrowerOnboardingConfig(this.config.get<string>(BORROWER_ONBOARDING_ENV));
    const failure = (status: number) => res.status(status).json({ error: 'Borrower onboarding request unavailable' });
    if (!settings) return failure(404);
    if (
      req.get('origin') !== settings.origin ||
      (req.get('sec-fetch-site') !== undefined && req.get('sec-fetch-site') !== 'same-origin')
    )
      return failure(403);
    if (!req.is('application/json')) return failure(415);
    if (
      Number(req.get('content-length')) > 16 * 1024 ||
      (req.rawBody !== undefined && Buffer.byteLength(req.rawBody) > 16 * 1024)
    )
      return failure(413);
    const id = req.cookies?.[sessionCookie];
    try {
      const result = await this.relay.run(settings, req.body, typeof id === 'string' ? id : undefined, (fresh, ttl) => {
        res.cookie(sessionCookie, fresh, {
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: ttl * 1000,
        });
      });
      return res.status(200).json(result);
    } catch (error) {
      return failure(error instanceof ApplicantRequestError ? error.status : 503);
    }
  }
}

import { Injectable } from '@nestjs/common';
import { DataSource, MoreThan, Repository } from 'typeorm';
import { SSOResponse } from '@entities/sso_response.entity';

export const CONFIGURED_OIDC_FLOW = 'configured_oidc';
export const CONFIGURED_OIDC_FLOW_LIFETIME_MS = 5 * 60 * 1000;

type OidcFlow = { nonce: string; codeVerifier: string; returnTo: string };

@Injectable()
export class SSOResponseRepository extends Repository<SSOResponse> {
  constructor(dataSource: DataSource) {
    super(SSOResponse, dataSource.createEntityManager());
  }

  async findById(id: string): Promise<SSOResponse> {
    return await this.findOneOrFail({
      where: { id },
    });
  }

  async createSSOResponse(configId: string, response: string, sso: string): Promise<SSOResponse> {
    const ssoResponse = this.create({
      configId,
      response,
      sso,
    });

    return await this.save(ssoResponse);
  }

  async consumeConfiguredOidc(id: string, state: string): Promise<OidcFlow | null> {
    const { raw } = await this.createQueryBuilder()
      .delete()
      .where({
        id,
        configId: state,
        sso: CONFIGURED_OIDC_FLOW,
        createdAt: MoreThan(new Date(Date.now() - CONFIGURED_OIDC_FLOW_LIFETIME_MS)),
      })
      .returning('response')
      .execute();

    return raw[0] ? JSON.parse(raw[0].response) : null;
  }
}

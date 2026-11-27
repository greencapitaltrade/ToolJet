import { Injectable } from '@nestjs/common';
import { DataSource, In, MoreThan, Repository } from 'typeorm';
import { SSOResponse } from '@entities/sso_response.entity';

export const CONFIGURED_OIDC_FLOW = 'configured_oidc';
export const WORKSPACE_OIDC_FLOW = 'configured_oidc_workspace';
export const CONFIGURED_OIDC_FLOW_LIFETIME_MS = 5 * 60 * 1000;

type OidcFlow = {
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  connector?: { workspaceId: string; revision: string };
};

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
        sso: In([CONFIGURED_OIDC_FLOW, WORKSPACE_OIDC_FLOW]),
        createdAt: MoreThan(new Date(Date.now() - CONFIGURED_OIDC_FLOW_LIFETIME_MS)),
      })
      .returning(['response', 'sso'])
      .execute();

    if (!raw[0]) return null;
    const flow: OidcFlow = JSON.parse(raw[0].response);
    if (raw[0].sso === WORKSPACE_OIDC_FLOW && !flow?.connector) return null;
    return flow;
  }
}

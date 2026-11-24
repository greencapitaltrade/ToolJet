import type { App } from '@entities/app.entity';
import type { DataQuery } from '@entities/data_query.entity';
import type { User } from '@entities/user.entity';
import { SessionUtilService } from '@modules/session/util.service';
import { APP_TYPES } from '@modules/apps/constants';
import { DataSourceScopes, DataSourceTypes } from '@modules/data-sources/constants';
import { Injectable } from '@nestjs/common';
import { runCreditReview } from './credit-review.relay';
import { FINANCE_ENV } from './finance.config';
import { runFinance } from './finance.relay';
import { runPartnerOps } from './partner-ops.relay';

export type RelayResult = { status: number; data?: object; error?: string };

const requestBody = '{{parameters.requestBody}}';
const operationPrefix = 'https://tooljet-relay.invalid/';
const transports = [
  { appIdEnv: 'TOOLJET_PARTNER_OPS_APP_ID', run: runPartnerOps },
  { appIdEnv: 'TOOLJET_CREDIT_REVIEW_APP_ID', run: runCreditReview, nestedFields: true },
  { appIdEnv: FINANCE_ENV.appId, run: runFinance },
];

@Injectable()
export class StaffRelayService {
  constructor(private readonly sessions: SessionUtilService) {}

  async run(user: User, app: App, query: DataQuery, resolvedOptions: object): Promise<RelayResult | undefined> {
    const { dataSource, options } = query;
    if (
      app.type !== APP_TYPES.FRONT_END ||
      query.appVersion?.appId !== app.id ||
      dataSource.kind !== 'restapi' ||
      dataSource.type !== DataSourceTypes.STATIC ||
      dataSource.scope !== DataSourceScopes.GLOBAL ||
      dataSource.organizationId !== app.organizationId ||
      typeof options?.url !== 'string' ||
      options.method !== 'post' ||
      options.body_toggle !== true ||
      options.raw_body !== requestBody
    ) {
      return;
    }

    const operation = options.url.startsWith(operationPrefix) && options.url.slice(operationPrefix.length);
    if (!operation) return;

    // A copy or import can reuse the saved REST expression and source, but receives a different app ID.
    const assigned = transports.filter(({ appIdEnv }) => process.env[appIdEnv] === app.id);
    if (!assigned.length) return;
    if (assigned.length !== 1) return { status: 503, error: 'The query connection is unavailable.' };
    if (!user) return { status: 401, error: 'Sign in with your organization account to continue.' };

    let fields: Record<string, unknown>;
    try {
      const raw = resolvedOptions?.[requestBody];
      if (typeof raw === 'string') fields = JSON.parse(raw);
    } catch {
      // Invalid JSON is handled with the same response as other invalid input.
    }
    if (
      !fields ||
      typeof fields !== 'object' ||
      Array.isArray(fields) ||
      Object.prototype.hasOwnProperty.call(fields, 'operation')
    ) {
      return { status: 400, error: 'This action or its inputs are invalid.' };
    }

    const { run, nestedFields } = assigned[0];
    return run(this.sessions, user, nestedFields ? { operation, fields } : { ...fields, operation });
  }
}

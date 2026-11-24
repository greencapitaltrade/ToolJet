import { request as requestHttp } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { MODULES } from '@modules/app/constants/modules';
import { AppsRepository } from '@modules/apps/repository';
import { AppEnvironmentUtilService } from '@modules/app-environments/util.service';
import { AppValidationService } from '@modules/app-validation/service';
import { PluginsServiceSelector } from '@modules/data-sources/services/plugin-selector.service';
import { DataSourcesUtilService } from '@modules/data-sources/util.service';
import { FeatureAbilityFactory } from '@modules/data-queries/ability/app';
import { DataQueriesController } from '@modules/data-queries/controller';
import { DataQueriesService } from '@modules/data-queries/service';
import { DataQueriesUtilService } from '@modules/data-queries/util.service';
import { DataQueryRepository } from '@modules/data-queries/repository';
import { StaffRelayService } from '@modules/data-queries/staff-relay.service';
import { OrganizationRepository } from '@modules/organizations/repository';
import { DataSourcesRepository } from '@modules/data-sources/repository';
import { GitSyncConfigsUtilService } from '@modules/git-sync-configs/util.service';
import { VersionRepository } from '@modules/versions/repository';
import { LicenseTermsService } from '@modules/licensing/interfaces/IService';
import { TransactionLogger } from '@modules/logging/service';
import { SessionUtilService } from '@modules/session/util.service';
import { sanitizeOAuthRequest, sanitizeTraceObject } from '@otel/sanitize';

const site = 'https://workspace.example.test';
const issuer = 'https://issuer.example.test/oidc';
const thor = 'http://thor.namespace.svc.cluster.local';
const ironman = 'http://ironman.namespace.svc.cluster.local';
const workspaceId = 'e38e7590-76c7-46b1-9413-d56ec6ee28af';
const appId = '92d02185-6e06-47dc-8f94-f8f504fa4afd';
const unrelatedAppId = '2dd5b04c-f85f-4d9f-afe5-06345d14a3c7';
const versionId = '1717908f-6b43-4788-b397-b115c7f63295';
const userId = '9007199254740993';
const orgId = '9007199254740994';
const readKey = 'a'.repeat(64);
const csvKey = 'b'.repeat(64);
const csv = 'Payment Method Name,Debit Account No / IBAN,Amount\r\nFixture,TEST,100\r\n';

const staticRestSourceId = 'f7727657-e8b2-4b39-826d-e4f22fd3e53a';
const queryIds = { queue: 'bda1ab27-f81d-4fc5-972a-c77f296a61ec', csv: '387c2cf2-d198-4203-aaa5-866a7b4578e9' };
const copiedQueryId = 'd8557247-9ff1-470e-906c-cdce54cf9cdd';
const ordinaryQueryId = '82c0c972-e3f6-4292-af3c-9270588f9463';
const apps = { findByDataQuery: jest.fn() };
const queryRepository = { getOneById: jest.fn(), isQueryInVersion: jest.fn() };
const environmentOptions = { getOptions: jest.fn() };
const nativeRun = jest.fn();
const sessions = { getOidcActor: jest.fn() };
const permissions = jest.fn();

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 1000, limit: 50 }])],
  controllers: [DataQueriesController],
  providers: [
    { provide: AppsRepository, useValue: apps },
    { provide: DataQueryRepository, useValue: queryRepository },
    { provide: DataSourcesRepository, useValue: {} },
    { provide: GitSyncConfigsUtilService, useValue: {} },
    { provide: VersionRepository, useValue: {} },
    {
      provide: OrganizationRepository,
      useValue: { getSingleOrganizationWithId: jest.fn(), touchLastAccessedAt: jest.fn() },
    },
    DataQueriesService,
    DataQueriesUtilService,
    { provide: AppEnvironmentUtilService, useValue: environmentOptions },
    { provide: AppValidationService, useValue: {} },
    { provide: DataSourcesUtilService, useValue: { resolveOAuthRedirectHost: jest.fn() } },
    { provide: PluginsServiceSelector, useValue: {} },
    StaffRelayService,
    { provide: LicenseTermsService, useValue: {} },
    { provide: TransactionLogger, useValue: { log: jest.fn() } },
    { provide: DataSource, useValue: { getRepository: () => ({ findOne: jest.fn().mockResolvedValue(null) }) } },
    {
      provide: FeatureAbilityFactory,
      useValue: new FeatureAbilityFactory({ resourceActionsPermission: permissions } as never),
    },
    { provide: SessionUtilService, useValue: sessions },
    { provide: ConfigService, useValue: new ConfigService() },
  ],
})
class Fixture {}

describe('private Finance relay', () => {
  const queue = { operation: 'queue' };
  const exportCsv = { operation: 'csv' };
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let endpoint: string;

  function request(body: unknown, headers: Record<string, string> = {}, queryId?: string) {
    const { operation, ...fields } = (body || {}) as { operation?: string };
    return requestQuery(
      queryId ?? queryIds[operation] ?? queryIds.queue,
      {
        resolvedOptions: { '{{parameters.requestBody}}': JSON.stringify(queryIds[operation] ? fields : body) },
      },
      headers
    );
  }

  function requestQuery(queryId: string, body: object, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; contentType: string; cacheControl: string; body: string }>(
      (resolve, reject) => {
        const req = requestHttp(
          `${endpoint}/data-queries/${queryId}/run`,
          {
            method: 'POST',
            headers: { Origin: site, 'Content-Type': 'application/json', Cookie: 'tj_auth_token=fixture', ...headers },
          },
          (res) => {
            res.setEncoding('utf8');
            let output = '';
            res.on('data', (chunk: string) => (output += chunk));
            res.once('end', () =>
              resolve({
                status: res.statusCode,
                contentType: res.headers['content-type'],
                cacheControl: res.headers['cache-control'],
                body: output,
              })
            );
          }
        );
        req.once('error', reject);
        req.end(JSON.stringify(body));
      }
    );
  }

  beforeAll(async () => {
    app = await NestFactory.create(Fixture, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    app.use((req, _res, next) => {
      req.cookies = req.headers.cookie === 'tj_auth_token=fixture' ? { tj_auth_token: 'fixture' } : {};
      next();
    });
    await app.listen(0, '127.0.0.1');
    endpoint = `${await app.getUrl()}/api`;
  });

  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      TOOLJET_EDITION: 'ce',
      TOOLJET_HOST: site,
      TOOLJET_OIDC_ISSUER: issuer,
      TOOLJET_OIDC_CLIENT_ID: 'test-client',
      TOOLJET_OIDC_CLIENT_SECRET: 'synthetic-test-client-secret',
      TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
      TOOLJET_PARTNER_OPS_THOR_ORIGIN: thor,
      TOOLJET_FINANCE_APP_ID: appId,
      TOOLJET_FINANCE_IRONMAN_ORIGIN: ironman,
      TOOLJET_FINANCE_READ_KEY: readKey,
      TOOLJET_FINANCE_CSV_KEY: csvKey,
    });
    apps.findByDataQuery.mockReset().mockImplementation(async (id: string) => ({
      id: id === copiedQueryId ? unrelatedAppId : appId,
      organizationId: workspaceId,
      type: 'front-end',
      isPublic: false,
      currentVersionId: versionId,
    }));
    queryRepository.getOneById.mockReset().mockImplementation(async (id: string) => ({
      id,
      appVersionId: versionId,
      appVersion: { id: versionId, appId: id === copiedQueryId ? unrelatedAppId : appId, isPublic: false },
      dataSourceId: id === ordinaryQueryId ? 'other-connection' : staticRestSourceId,
      dataSource: {
        id: id === ordinaryQueryId ? 'other-connection' : staticRestSourceId,
        kind: 'restapi',
        scope: 'global',
        type: id === ordinaryQueryId ? 'default' : 'static',
        organizationId: workspaceId,
      },
      options: {
        url: id === queryIds.csv ? 'https://tooljet-relay.invalid/csv' : 'https://tooljet-relay.invalid/queue',
        method: 'post',
        body_toggle: true,
        raw_body: '{{parameters.requestBody}}',
      },
    }));
    queryRepository.isQueryInVersion.mockReset().mockResolvedValue(true);
    environmentOptions.getOptions.mockReset().mockResolvedValue({ options: {}, environmentId: 'native-env' });
    nativeRun.mockReset().mockResolvedValue({ status: 'ok', data: { ordinary: true } });
    jest.spyOn(app.get(DataQueriesUtilService), 'fetchServiceAndParsedParams').mockResolvedValue({
      sourceOptions: {},
      parsedQueryOptions: {},
      service: { run: nativeRun } as never,
    });
    sessions.getOidcActor.mockReset().mockResolvedValue({ issuer, clientId: 'test-client', sub: userId });
    permissions.mockReset().mockResolvedValue({ [MODULES.APP]: { viewableAppsId: [appId] } });
    jest.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockImplementation(async (ctx) => {
      const request = ctx.switchToHttp().getRequest();
      if (!request.cookies?.tj_auth_token) return false;
      request.user = {
        id: 'tooljet-user',
        sessionId: 'native-session',
        organizationId: workspaceId,
      };
      return true;
    });
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (url === `${thor}/v1/users/oidc-subject/${userId}`) {
        return globalThis.Response.json({ sub: userId, organization_id: orgId });
      }
      if (url === `${ironman}/v1/finance/disbursements/export`) {
        return new globalThis.Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
      }
      return globalThis.Response.json({
        products: [
          {
            productId: '41',
            productName: 'Battery finance',
            payoutMode: 'manual',
            rows: [
              {
                applicationId: '101',
                loanId: '201',
                disbursementStatus: 'pending',
                manualPayoutCandidate: true,
                borrowerId: '301',
                netPaise: '9999',
                bankAccount: 'private',
              },
            ],
            payoutHistory: [{ private: 'history' }],
          },
          {
            productId: '42',
            productName: 'Vehicle finance',
            payoutMode: 'automated',
            rows: [
              { applicationId: '102', loanId: '202', disbursementStatus: 'initiated', manualPayoutCandidate: false },
            ],
          },
        ],
      });
    });
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => app?.close());

  it('enforces the native viewer grant on the query’s app before resolving the actor', async () => {
    expect((await request(queue, { Cookie: '' })).status).toBe(401);
    permissions.mockResolvedValue({ [MODULES.APP]: { viewableAppsId: [unrelatedAppId] } });
    expect((await request(queue, { 'tj-app-id': unrelatedAppId })).status).toBe(403);
    expect(apps.findByDataQuery).toHaveBeenCalledWith(queryIds.queue);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an anonymous released public query before resolving or forwarding a Thor actor', async () => {
    apps.findByDataQuery.mockResolvedValue({
      id: appId,
      organizationId: workspaceId,
      type: 'front-end',
      isPublic: true,
      currentVersionId: versionId,
    });
    const result = await request(queue, { Cookie: '' });
    expect(JSON.parse(result.body)).toMatchObject({ status: 'failed' });
    expect(sessions.getOidcActor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the relay bound to the installed query and ignores caller-supplied operation and source selectors', async () => {
    const forged = {
      options: { url: 'https://tooljet-relay.invalid/csv', dataSourceId: staticRestSourceId },
      resolvedOptions: { '{{parameters.requestBody}}': '{}', url: 'https://tooljet-relay.invalid/csv' },
    };
    permissions.mockResolvedValue({ [MODULES.APP]: { viewableAppsId: [appId, unrelatedAppId] } });
    const copied = await requestQuery(copiedQueryId, forged);
    expect(JSON.parse(copied.body)).toMatchObject({ status: 'ok', data: { ordinary: true } });
    expect(nativeRun).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();

    const ordinary = await requestQuery(ordinaryQueryId, forged);
    expect(JSON.parse(ordinary.body)).toMatchObject({ status: 'ok', data: { ordinary: true } });
    expect(nativeRun).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();

    await requestQuery(queryIds.queue, forged);
    expect(fetch).toHaveBeenLastCalledWith(
      `${ironman}/v1/finance/disbursements`,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('uses a normal plugin run for the editor path even in view mode', async () => {
    const installedQuery = await queryRepository.getOneById(queryIds.queue);
    const installedApp = await apps.findByDataQuery(queryIds.queue);
    await expect(
      app
        .get(DataQueriesService)
        .runQueryOnBuilder(
          { id: 'tooljet-user', organizationId: workspaceId } as never,
          queryIds.queue,
          'native-env',
          { resolvedOptions: { '{{parameters.requestBody}}': '{}' } } as never,
          { can: () => false } as never,
          installedQuery.dataSource,
          {} as never,
          'view',
          installedApp
        )
    ).resolves.toMatchObject({ status: 'ok', data: { ordinary: true } });
    expect(nativeRun).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'PARTNER_OPS',
      'session',
      '/v1/channel-partners/session',
      { display_name: 'Operator', permissions: {}, channels: [] },
      { name: 'Operator' },
    ],
    ['CREDIT_REVIEW', 'queue', '/v1/applications/credit-review/queue', { cases: [] }, { cases: [] }],
  ])(
    'runs %s through the same saved-query viewer route',
    async (relay, operation, path, upstreamData, responseData) => {
      const destiny = 'http://destiny.namespace.svc.cluster.local';
      delete process.env.TOOLJET_FINANCE_APP_ID;
      process.env[`TOOLJET_${relay}_APP_ID`] = appId;
      process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN = destiny;
      process.env.TOOLJET_CREDIT_REVIEW_SIGNING_KEY = generateKeyPairSync('ed25519')
        .privateKey.export({ format: 'der', type: 'pkcs8' })
        .toString('base64');
      const row = await queryRepository.getOneById(queryIds.queue);
      queryRepository.getOneById.mockResolvedValueOnce({
        ...row,
        options: { ...row.options, url: `https://tooljet-relay.invalid/${operation}` },
      });
      jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: userId, organization_id: orgId }));
      jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json(upstreamData));
      const result = await request(queue);
      expect(JSON.parse(result.body)).toMatchObject({ status: 'ok', data: responseData });
      expect(fetch).toHaveBeenLastCalledWith(`${destiny}${path}`, expect.any(Object));
    }
  );

  it('reads all organization products and returns only the visible pending queue fields', async () => {
    const result = await request(queue, { 'x-gct-user-id': '1', 'x-gct-org-id': '2', 'api-secret': 'browser-key' });
    expect(result.status).toBe(201);
    expect(result.cacheControl).toBe('no-store');
    expect(JSON.parse(result.body)).toMatchObject({
      status: 'ok',
      data: {
        canRequestCsv: true,
        rows: [
          { product: 'Battery finance', applicationId: '101', loanId: '201', status: 'Pending payout' },
          { product: 'Vehicle finance', applicationId: '102', loanId: '202', status: 'Transfer initiated' },
        ],
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `${ironman}/v1/finance/disbursements`,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { 'x-gct-user-id': userId, 'x-gct-org-id': orgId, 'api-secret': readKey },
      })
    );
    expect(jest.mocked(fetch).mock.calls[1][1].body).toBeUndefined();
  });

  it('requests the entire reconciled CSV with the separate export key and preserves the file bytes', async () => {
    const result = await request(exportCsv);
    expect(result.cacheControl).toBe('no-store');
    expect(JSON.parse(result.body)).toMatchObject({ status: 'ok', data: { csv } });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `${ironman}/v1/finance/disbursements/export`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-gct-user-id': userId,
          'x-gct-org-id': orgId,
          'api-secret': csvKey,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
    );
  });

  it.each([
    { operation: 'queue', organizationId: '1' },
    { operation: 'csv', items: [{ disbursementId: '12', netPaise: '1' }] },
    { operation: 'csv', productId: '6' },
    { operation: 'csv', userId: '3' },
    { operation: 'download' },
    [],
  ])('rejects caller-provided scope, amount or unrelated operations', async (body) => {
    expect(JSON.parse((await request(body)).body)).toMatchObject({ status: 'failed', data: { status: 400 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves the queue usable without an export grant', async () => {
    delete process.env.TOOLJET_FINANCE_CSV_KEY;
    expect(JSON.parse((await request(queue)).body)).toMatchObject({ status: 'ok' });
    expect(JSON.parse((await request(exportCsv)).body)).toMatchObject({ status: 'failed', data: { status: 503 } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects reused action credentials and external Ironman origins before forwarding a request', async () => {
    process.env.TOOLJET_FINANCE_CSV_KEY = readKey;
    expect(JSON.parse((await request(exportCsv)).body)).toMatchObject({ status: 'failed', data: { status: 503 } });
    process.env.TOOLJET_FINANCE_IRONMAN_ORIGIN = 'https://public.example.test';
    expect(JSON.parse((await request(queue)).body)).toMatchObject({ status: 'failed', data: { status: 503 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an Ironman grant denial without exposing upstream details', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: userId, organization_id: orgId }));
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ detail: 'private grant details' }, { status: 401 }));
    const result = await request(queue);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'failed', data: { status: 403 } });
    expect(result.body).not.toContain('private grant details');
  });

  it('requires a registered Thor actor before forwarding any finance request', async () => {
    sessions.getOidcActor.mockRejectedValueOnce(new Error('session rejected'));
    expect(JSON.parse((await request(exportCsv)).body)).toMatchObject({ status: 'failed', data: { status: 401 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves an actionable reconciliation error without returning private upstream details', async () => {
    jest
      .mocked(fetch)
      .mockImplementationOnce(async () => globalThis.Response.json({ sub: userId, organization_id: orgId }));
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(
        globalThis.Response.json(
          { code: 'finance_csv_reconciliation_required', detail: 'private account data' },
          { status: 409 }
        )
      );
    const result = await request(exportCsv);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'failed', data: { status: 409 } });
    expect(result.body).toContain('Reconcile pending manual payouts');
    expect(result.body).not.toContain('private account data');
  });

  it('rejects a malformed queue response or a CSV type containing non-CSV data', async () => {
    for (const [action, payload] of [
      [queue, globalThis.Response.json({ products: [{ rows: [{ disbursementStatus: 'unknown' }] }] })],
      [exportCsv, new globalThis.Response('<html>private</html>', { headers: { 'content-type': 'text/csv' } })],
    ] as const) {
      jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: userId, organization_id: orgId }));
      jest.mocked(fetch).mockResolvedValueOnce(payload);
      const result = await request(action);
      expect(JSON.parse(result.body)).toMatchObject({ status: 'failed', data: { status: 503 } });
      expect(result.body).not.toContain('private');
    }
  });

  it('keeps finance operation and credential parameters out of request telemetry', () => {
    const credentials = { 'api-secret': readKey, TOOLJET_FINANCE_READ_KEY: readKey, TOOLJET_FINANCE_CSV_KEY: csvKey };
    expect(sanitizeTraceObject(credentials)).toEqual({
      'api-secret': '[REDACTED]',
      TOOLJET_FINANCE_READ_KEY: '[REDACTED]',
      TOOLJET_FINANCE_CSV_KEY: '[REDACTED]',
    });
    expect(
      sanitizeOAuthRequest({
        id: 'request',
        method: 'POST',
        url: `/api/data-queries/${queryIds.csv}/run?a=secret`,
        body: credentials,
      })
    ).toEqual({ id: 'request', method: 'POST', url: `/api/data-queries/${queryIds.csv}/run` });
  });
});

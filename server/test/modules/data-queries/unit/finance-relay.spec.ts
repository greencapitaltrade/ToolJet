import { request as requestHttp } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { MODULES } from '@modules/app/constants/modules';
import { AppsRepository } from '@modules/apps/repository';
import { FeatureAbilityFactory } from '@modules/data-queries/ability/app';
import { FinanceController } from '@modules/data-queries/finance.controller';
import { LicenseTermsService } from '@modules/licensing/interfaces/IService';
import { TransactionLogger } from '@modules/logging/service';
import { JwtAuthGuard } from '@modules/session/guards/jwt-auth.guard';
import { SessionUtilService } from '@modules/session/util.service';
import { VersionRepository } from '@modules/versions/repository';
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

const apps = { findById: jest.fn() };
const versions = { findOne: jest.fn() };
const sessions = { getOidcActor: jest.fn() };
const permissions = jest.fn();

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 1000, limit: 50 }])],
  controllers: [FinanceController],
  providers: [
    { provide: AppsRepository, useValue: apps },
    { provide: VersionRepository, useValue: versions },
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

  function request(body: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; contentType: string; cacheControl: string; body: string }>(
      (resolve, reject) => {
        const req = requestHttp(
          endpoint,
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
    endpoint = `${await app.getUrl()}/api/finance`;
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
    apps.findById.mockReset().mockResolvedValue({
      id: appId,
      organizationId: workspaceId,
      type: 'front-end',
      isPublic: false,
      currentVersionId: versionId,
    });
    versions.findOne.mockReset().mockResolvedValue({ isPublic: false, isStub: false });
    sessions.getOidcActor.mockReset().mockResolvedValue({ issuer, clientId: 'test-client', sub: userId });
    permissions.mockReset().mockResolvedValue({ [MODULES.APP]: { viewableAppsId: [appId] } });
    jest.spyOn(JwtAuthGuard.prototype, 'canActivate').mockImplementation(async (ctx) => {
      ctx.switchToHttp().getRequest().user = {
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

  it('requires the native cookie, same origin and exact private released app grant before upstream lookup', async () => {
    expect((await request(queue, { Cookie: '' })).status).toBe(403);
    expect((await request(queue, { Origin: 'https://other.example.test' })).status).toBe(403);
    permissions.mockResolvedValue({ [MODULES.APP]: { viewableAppsId: [unrelatedAppId] } });
    expect((await request(queue, { 'tj-app-id': unrelatedAppId })).status).toBe(403);
    apps.findById.mockResolvedValueOnce({ id: appId, organizationId: workspaceId, type: 'front-end', isPublic: true });
    expect((await request(queue)).status).toBe(403);
    expect(apps.findById).toHaveBeenCalledWith(appId, workspaceId);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads all organization products and returns only the visible pending queue fields', async () => {
    const result = await request(queue, { 'x-gct-user-id': '1', 'x-gct-org-id': '2', 'api-secret': 'browser-key' });
    expect(result.status).toBe(200);
    expect(result.cacheControl).toBe('no-store');
    expect(JSON.parse(result.body)).toEqual({
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
    expect(result).toEqual({
      status: 200,
      contentType: 'text/csv; charset=utf-8',
      cacheControl: 'no-store',
      body: csv,
    });
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
    expect((await request(body)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves the queue usable without an export grant', async () => {
    delete process.env.TOOLJET_FINANCE_CSV_KEY;
    expect((await request(queue)).status).toBe(200);
    expect((await request(exportCsv)).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects reused action credentials and external Ironman origins before forwarding a request', async () => {
    process.env.TOOLJET_FINANCE_CSV_KEY = readKey;
    expect((await request(exportCsv)).status).toBe(503);
    process.env.TOOLJET_FINANCE_IRONMAN_ORIGIN = 'https://public.example.test';
    expect((await request(queue)).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an Ironman grant denial without exposing upstream details', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: userId, organization_id: orgId }));
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ detail: 'private grant details' }, { status: 401 }));
    const result = await request(queue);
    expect(result.status).toBe(403);
    expect(result.body).not.toContain('private grant details');
  });

  it('requires a registered Thor actor before forwarding any finance request', async () => {
    sessions.getOidcActor.mockRejectedValueOnce(new Error('session rejected'));
    expect((await request(exportCsv)).status).toBe(401);
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
    expect(result.status).toBe(409);
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
      expect(result.status).toBe(503);
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
      sanitizeOAuthRequest({ id: 'request', method: 'POST', url: '/api/finance?a=secret', body: credentials })
    ).toEqual({ id: 'request', method: 'POST', url: '/api/finance' });
  });
});

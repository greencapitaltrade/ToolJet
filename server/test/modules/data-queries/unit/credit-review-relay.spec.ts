import { generateKeyPairSync, verify } from 'node:crypto';
import { request as requestHttp } from 'node:http';
import { Module, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import {
  CreditReviewController,
  CreditReviewGuard,
  CreditReviewViewerGuard,
} from '@modules/data-queries/credit-review.controller';
import { FeatureAbilityFactory } from '@modules/data-queries/ability/app';
import { FeatureAbilityGuard } from '@modules/data-queries/ability/app/guard';
import { FEATURE_KEY } from '@modules/data-queries/constants';
import { MODULES } from '@modules/app/constants/modules';
import { AppsRepository } from '@modules/apps/repository';
import { LicenseTermsService } from '@modules/licensing/interfaces/IService';
import { TransactionLogger } from '@modules/logging/service';
import { JwtAuthGuard } from '@modules/session/guards/jwt-auth.guard';
import { SessionUtilService } from '@modules/session/util.service';
import { VersionRepository } from '@modules/versions/repository';
import { sanitizeOAuthRequest, sanitizeTraceObject } from '@otel/sanitize';

const site = 'https://workspace.example.test';
const issuer = 'https://issuer.example.test/oidc';
const thor = 'http://thor.namespace.svc.cluster.local';
const destiny = 'http://destiny.namespace.svc.cluster.local';
const workspaceId = 'e38e7590-76c7-46b1-9413-d56ec6ee28af';
const appId = '2dd5b04c-f85f-4d9f-afe5-06345d14a3c7';
const versionId = '1717908f-6b43-4788-b397-b115c7f63295';
const userId = '9007199254740993';
const orgId = '9007199254740994';
const signedKey = generateKeyPairSync('ed25519');
const user = { id: 'tooljet-user', sessionId: 'native-session', organizationId: workspaceId };
const apps = { findById: jest.fn() };
const versions = { findOne: jest.fn() };
const sessions = { getOidcActor: jest.fn() };
const guard = new CreditReviewGuard(apps as never, versions as never);
const controller = new CreditReviewController(sessions as never);

function request(headers = {}, cookies: Record<string, string> = { tj_auth_token: 'fixture' }) {
  return { headers: { origin: site, 'content-type': 'application/json', ...headers }, cookies, user };
}

function context(req: object) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getClass: () => CreditReviewController,
    getHandler: () => CreditReviewController.prototype.relay,
  } as unknown as ExecutionContext;
}

async function relay(body: unknown, req = request()) {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await controller.relay(req as never, body, response as unknown as Response);
  return { status: response.status.mock.calls[0][0], body: response.json.mock.calls[0][0] };
}

function nativeViewerGuard(permissions: jest.Mock) {
  const factory = new FeatureAbilityFactory({ resourceActionsPermission: permissions } as never);
  return new CreditReviewViewerGuard(
    new Reflector(),
    { resolve: jest.fn().mockResolvedValue(factory) } as never,
    {} as never,
    { log: jest.fn() } as never,
    { getRepository: () => ({ findOne: jest.fn().mockResolvedValue(null) }) } as never
  );
}

function runQueue(endpoint: string, cookie?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = requestHttp(
      endpoint,
      {
        method: 'POST',
        headers: { Origin: site, 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
      },
      (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode));
      }
    );
    req.once('error', reject);
    req.end(JSON.stringify({ operation: 'queue', fields: {} }));
  });
}

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    TOOLJET_EDITION: 'ce',
    TOOLJET_HOST: site,
    TOOLJET_OIDC_ISSUER: issuer,
    TOOLJET_OIDC_CLIENT_ID: 'test-client',
    TOOLJET_OIDC_CLIENT_SECRET: 'synthetic-test-client-secret',
    TOOLJET_OIDC_WORKSPACE_ID: workspaceId,
    TOOLJET_PARTNER_OPS_THOR_ORIGIN: thor,
    TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN: destiny,
    TOOLJET_CREDIT_REVIEW_APP_ID: appId,
    TOOLJET_CREDIT_REVIEW_SIGNING_KEY: signedKey.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
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
  jest.spyOn(JwtAuthGuard.prototype, 'canActivate').mockResolvedValue(true);
  jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (url === `${thor}/v1/users/oidc-subject/${userId}`) {
      return globalThis.Response.json({ sub: userId, organization_id: orgId });
    }
    return globalThis.Response.json({ cases: [] });
  });
});

afterEach(() => jest.restoreAllMocks());

describe('private credit review relay', () => {
  it('keeps case details and signed proof out of telemetry', () => {
    expect(
      sanitizeOAuthRequest({
        id: 'request-1',
        method: 'POST',
        url: '/tools/api/credit-review?caseId=23',
        headers: { 'x-gct-credit-review-proof': 'synthetic-proof' },
        body: { fields: { reason: 'synthetic private case detail' } },
      })
    ).toEqual({ id: 'request-1', method: 'POST', url: '/tools/api/credit-review' });
    expect(sanitizeTraceObject({ 'x-gct-credit-review-proof': 'synthetic-proof' })).toEqual({
      'x-gct-credit-review-proof': '[REDACTED]',
    });
  });
  it('uses the native query viewer permission for the configured private released app', async () => {
    const reflector = new Reflector();
    expect(reflector.get('tjModuleId', CreditReviewController)).toBe(MODULES.DATA_QUERY);
    expect(reflector.get('tjFeatureId', CreditReviewController.prototype.relay)).toBe(FEATURE_KEY.RUN_STAFF_RELAY);
    expect(reflector.get('__guards__', CreditReviewController)).toEqual(
      expect.arrayContaining([CreditReviewGuard, CreditReviewViewerGuard])
    );
    expect(CreditReviewViewerGuard.prototype).toBeInstanceOf(FeatureAbilityGuard);

    const permissions = jest.fn().mockResolvedValue({ [MODULES.APP]: { viewableAppsId: ['unrelated-app'] } });
    const viewerGuard = nativeViewerGuard(permissions);
    const denied = context(request());
    await expect(guard.canActivate(denied)).resolves.toBe(true);
    await expect(viewerGuard.canActivate(denied)).rejects.toThrow('You do not have permission');
    expect(fetch).not.toHaveBeenCalled();

    permissions.mockResolvedValue({ [MODULES.APP]: { viewableAppsId: [appId] } });
    const allowed = context(request({ 'tj-workspace-id': 'caller-value' }));
    await expect(guard.canActivate(allowed)).resolves.toBe(true);
    expect(allowed.switchToHttp().getRequest().headers['tj-workspace-id']).toEqual(workspaceId);
    expect(apps.findById).toHaveBeenLastCalledWith(appId, workspaceId);
    await expect(viewerGuard.canActivate(allowed)).resolves.toBe(true);
  });

  it('enforces the stock app grant on the mounted HTTP route before the first upstream call', async () => {
    const permissions = jest.fn().mockResolvedValue({ [MODULES.APP]: { viewableAppsId: ['unrelated-app'] } });
    jest.mocked(JwtAuthGuard.prototype.canActivate).mockImplementation(async (ctx) => {
      ctx.switchToHttp().getRequest().user = user;
      return true;
    });
    @Module({
      imports: [ThrottlerModule.forRoot([{ ttl: 1000, limit: 50 }])],
      controllers: [CreditReviewController],
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
    const app = await NestFactory.create(Fixture, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    app.use((req, _res, next) => {
      req.cookies = req.headers.cookie === 'tj_auth_token=fixture' ? { tj_auth_token: 'fixture' } : {};
      next();
    });
    try {
      await app.listen(0, '127.0.0.1');
      const endpoint = `${await app.getUrl()}/api/credit-review`;
      await expect(runQueue(endpoint)).resolves.toBe(403);
      await expect(runQueue(endpoint, 'tj_auth_token=fixture')).resolves.toBe(403);
      expect(fetch).not.toHaveBeenCalled();

      permissions.mockResolvedValue({ [MODULES.APP]: { viewableAppsId: [appId] } });
      await expect(runQueue(endpoint, 'tj_auth_token=fixture')).resolves.toBe(200);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('rejects nonbrowser credentials and public, unreleased, maintenance or cross-workspace apps', async () => {
    for (const req of [
      request({}, {}),
      request({ origin: 'https://other.example.test' }),
      request({ 'content-type': 'text/plain' }),
      request({ tj_auth_token: 'header-token' }),
      request({ 'x-tooljet-delegation': 'delegated' }),
      request({ 'tj-admin-api-key': 'admin' }),
      request({}, { tj_auth_token: 'fixture', tj_oauth_viewer: 'viewer' }),
    ]) {
      await expect(guard.canActivate(context(req))).resolves.toBe(false);
    }
    expect(apps.findById).not.toHaveBeenCalled();

    const privateApp = await apps.findById();
    for (const change of [
      { isPublic: true },
      { currentVersionId: null },
      { isMaintenanceOn: true },
      { organizationId: 'other-workspace' },
      { type: 'workflow' },
    ]) {
      apps.findById.mockResolvedValueOnce({ ...privateApp, ...change });
      await expect(guard.canActivate(context(request()))).resolves.toBe(false);
    }
    versions.findOne.mockResolvedValueOnce({ isPublic: true, isStub: false });
    await expect(guard.canActivate(context(request()))).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      { operation: 'queue', fields: { after: '23' } },
      'queue',
      ['queue', '23'],
      '/v1/applications/credit-review/queue',
      { action: 'queue', after: '23' },
    ],
    [
      { operation: 'queue', fields: {} },
      'queue',
      ['queue', null],
      '/v1/applications/credit-review/queue',
      { action: 'queue' },
    ],
    [
      { operation: 'case', fields: { applicationId: '23' } },
      '23',
      ['options', null, null, null, null, null],
      '/v1/23/credit-review',
      { action: 'options' },
    ],
    [
      {
        operation: 'action',
        fields: {
          applicationId: '23',
          action: 'close',
          reviewStepId: '44',
          revision: 'rev-2',
          reason: 'Reason supplied',
        },
      },
      '23',
      ['close', '44', 'rev-2', null, 'Reason supplied', null],
      '/v1/23/credit-review',
      { action: 'close', reviewStepId: '44', revision: 'rev-2', reason: 'Reason supplied' },
    ],
  ])(
    'binds the canonical verified actor, operation and request to Destiny',
    async (body, target, fields, path, expected) => {
      const req = request({ 'x-gct-org-id': '1', 'x-gct-user-id': '2', 'x-gct-credit-review-proof': 'caller-proof' });
      expect(await relay(body, req)).toEqual({ status: 200, body: { data: { cases: [] } } });
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        `${thor}/v1/users/oidc-subject/${userId}`,
        expect.objectContaining({
          redirect: 'error',
          headers: { 'x-gct-oidc-client-id': 'test-client', 'x-gct-oidc-issuer': issuer },
        })
      );
      const [url, options] = jest.mocked(fetch).mock.calls[1];
      expect(url).toBe(destiny + path);
      expect(options).toEqual(expect.objectContaining({ method: 'POST', redirect: 'error' }));
      expect(JSON.parse(options.body as string)).toEqual(expected);
      const headers = options.headers as Record<string, string>;
      expect(headers['x-gct-user-id']).toBe(userId);
      expect(headers['x-gct-org-id']).toBe(orgId);
      const [subject, expiry, signature] = headers['x-gct-credit-review-proof'].split('.');
      expect(subject).toBe(userId);
      expect(Number(expiry) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(30);
      expect(
        verify(
          null,
          Buffer.from(JSON.stringify(['destiny-borrower-credit-review-v2', target, userId, orgId, fields, expiry])),
          signedKey.publicKey,
          Buffer.from(signature, 'base64url')
        )
      ).toBe(true);
    }
  );

  it.each([
    { operation: 'queue', fields: { organizationId: '1' } },
    { operation: 'queue', fields: { after: '01' } },
    { operation: 'case', fields: { applicationId: '1/other' } },
    { operation: 'case', fields: { applicationId: '9223372036854775808' } },
    {
      operation: 'action',
      fields: {
        applicationId: '23',
        action: 'close',
        reviewStepId: '1',
        revision: 'x',
        reason: ' ',
        role: 'credit_officer',
      },
    },
    {
      operation: 'action',
      fields: { applicationId: '23', action: 'return', reviewStepId: '1', revision: 'x', reason: 'Required' },
    },
  ])('rejects caller-supplied scope or invalid review requests before contacting either service', async (body) => {
    expect((await relay(body)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires registered Thor identity and never exposes upstream failures', async () => {
    sessions.getOidcActor.mockRejectedValueOnce(new Error('private error'));
    expect((await relay({ operation: 'queue', fields: {} })).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();

    jest.mocked(fetch).mockResolvedValueOnce(globalThis.Response.json({ sub: '222', organization_id: orgId }));
    expect((await relay({ operation: 'queue', fields: {} })).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);

    jest
      .mocked(fetch)
      .mockResolvedValueOnce(globalThis.Response.json({ sub: userId, organization_id: orgId }))
      .mockResolvedValueOnce(globalThis.Response.json({ proof: 'sensitive upstream error' }, { status: 403 }));
    expect(await relay({ operation: 'queue', fields: {} })).toEqual({
      status: 403,
      body: { error: 'You do not have access to this action.' },
    });
  });
});

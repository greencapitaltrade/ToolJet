import { Test } from '@nestjs/testing';
import { DataQueriesUtilService } from '@modules/data-queries/util.service';
import { VersionRepository } from '@modules/versions/repository';
import { ConfigService } from '@nestjs/config';
import { AppEnvironmentUtilService } from '@modules/app-environments/util.service';
import { DataSourcesUtilService } from '@modules/data-sources/util.service';
import { PluginsServiceSelector } from '@modules/data-sources/services/plugin-selector.service';
import { SessionUtilService } from '@modules/session/util.service';
import type { User } from '@entities/user.entity';
import type { App } from '@entities/app.entity';
import type { Response } from 'express';
import * as oidcRest from '@modules/data-queries/oidc-rest';
import * as dealerViewer from '@modules/data-queries/dealer-viewer';

describe('DataQueriesUtilService.runQuery — isPublic/appName resolution', () => {
  let service: DataQueriesUtilService;
  let runMock: jest.Mock;
  let parseSourceOptions: jest.Mock;
  const getOidcActor = jest.fn();

  beforeEach(async () => {
    runMock = jest.fn().mockResolvedValue({ status: 'ok' });
    parseSourceOptions = jest.fn().mockResolvedValue({});

    const module = await Test.createTestingModule({
      providers: [
        DataQueriesUtilService,
        { provide: VersionRepository, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: AppEnvironmentUtilService,
          useValue: { getOptions: jest.fn().mockResolvedValue({ environmentId: 'env-1', options: {} }) },
        },
        {
          provide: DataSourcesUtilService,
          useValue: {
            parseSourceOptions,
            resolveOAuthRedirectHost: jest.fn().mockResolvedValue('http://localhost'),
          },
        },
        { provide: SessionUtilService, useValue: { getOidcActor } },
        {
          provide: PluginsServiceSelector,
          useValue: { getService: jest.fn().mockResolvedValue({ run: runMock }) },
        },
      ],
    }).compile();

    service = module.get(DataQueriesUtilService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('should use the app_versions row (not the raw App) for isPublic on a workflow', async () => {
    const appToUse = {
      id: 'app-1',
      type: 'workflow',
      isPublic: true,
      name: 'Old Name',
      organizationId: 'org-1',
    } as any;
    const dataQuery = {
      dataSource: { id: 'ds-1', kind: 'other', pluginId: 'plugin-1', options: {} },
      appVersion: { isPublic: false, appName: 'New Name', branchId: null },
      options: {},
    } as any;
    const response = { cookie: jest.fn(), setHeader: jest.fn() } as any;

    await service.runQuery(undefined as any, dataQuery, {}, response, undefined, undefined, appToUse);

    expect(runMock).toHaveBeenCalled();
    const runArgs = runMock.mock.calls[0];
    expect(runArgs[4]).toMatchObject({ app: { id: 'app-1', isPublic: false } });
  });

  it('validates a protected REST route against the saved template before in-place native option resolution', async () => {
    const organizationId = '7cc73e0a-e785-4f25-9233-ce6049496ea4';
    const origin = 'http://api.namespace.svc.cluster.local';
    const sourceId = 'native-source';
    jest.replaceProperty(process, 'env', {
      ...process.env,
      TOOLJET_EDITION: 'ce',
      TOOLJET_HOST: 'https://workspace.example.test',
      TOOLJET_OIDC_ISSUER: 'https://login.example.test/oidc',
      TOOLJET_OIDC_CLIENT_ID: 'test-client',
      TOOLJET_OIDC_CLIENT_SECRET: 'test-only',
      TOOLJET_OIDC_WORKSPACE_ID: organizationId,
      TOOLJET_OIDC_THOR_ORIGIN: 'http://identity.namespace.svc.cluster.local',
      TOOLJET_OIDC_REST_SOURCES: JSON.stringify({ [sourceId]: origin }),
    });
    parseSourceOptions.mockResolvedValue({ url: origin });
    const query = {
      dataSource: { id: sourceId, kind: 'restapi', organizationId, type: 'default', scope: 'global' },
      appVersion: { isPublic: false, branchId: null },
      options: { method: 'get', url: '/v1/records/{{parameters.recordId}}/summary' },
    };
    const user = { id: 'test-user', organizationId } as User;
    const app = { organizationId } as App;
    const response = { setHeader: jest.fn() } as unknown as Response;

    await expect(
      service.runQuery(
        user,
        query,
        { '{{parameters.recordId}}': '123/different-route' },
        response,
        undefined,
        'view',
        app
      )
    ).rejects.toMatchObject({ data: { status: 400 } });
    expect(getOidcActor).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });
  it('uses the dealer codec only for its app and allows another explicitly private app through OIDC', async () => {
    const organizationId = '18';
    const sourceId = 'native-source';
    const origin = 'http://api.namespace.svc.cluster.local';
    const dealerConfig = {
      sourceId,
      appId: 'dealer-app',
      queryIds: ['query'],
      origin: 'https://dealer.example',
      organizationId,
    };
    jest.replaceProperty(process, 'env', {
      ...process.env,
      TOOLJET_OIDC_REST_SOURCES: JSON.stringify({ [sourceId]: origin }),
    });
    jest
      .spyOn(service['configService'], 'get')
      .mockImplementation((key: string) =>
        key === 'TOOLJET_DEALER_VIEWER'
          ? JSON.stringify(dealerConfig)
          : key === 'SECRET_KEY_BASE'
            ? 's'.repeat(40)
            : undefined
      );
    parseSourceOptions.mockResolvedValue({ url: origin });
    const prepare = jest
      .spyOn(oidcRest, 'prepareOidcRestQuery')
      .mockImplementation(async (_origin, _saved, parsed, source, user, _sessions, actor) => {
        if (!user && !actor) throw new Error('Sign in');
        return { sourceOptions: source, queryOptions: parsed };
      });
    const viewer = jest.spyOn(dealerViewer, 'dealerViewerActor').mockImplementation(async (_raw, _secret, binding) => {
      if (binding.appId !== 'dealer-app' || !binding.isPublic || binding.appVersionId !== binding.currentVersionId)
        throw new Error('invalid binding');
      return { userId: '42', organizationId, email: 'owner@example.test', referral: 'r'.repeat(48) };
    });
    Object.assign(service, { redis: { getClient: () => ({ call: jest.fn() }) } });
    const user = { id: 'staff', organizationId } as User;
    const response = { req: { get: jest.fn(), cookies: {} }, setHeader: jest.fn() } as unknown as Response;
    const run = (
      appId: string,
      visibility: boolean | undefined,
      identity: User | undefined,
      currentVersionId = 'version',
      execution: { mode?: string } = { mode: 'view' }
    ) =>
      service.runQuery(
        identity,
        {
          id: 'query',
          appVersionId: 'version',
          appVersion: { isPublic: visibility },
          dataSource: { id: sourceId, kind: 'restapi', organizationId, type: 'default', scope: 'global' },
          options: { method: 'get', url: '/v1/records' },
        },
        {},
        response,
        undefined,
        execution.mode,
        { id: appId, organizationId, currentVersionId } as App
      );
    await expect(run('staff-app', false, user, 'version', {})).rejects.toMatchObject({ data: { status: 401 } });
    expect(runMock).not.toHaveBeenCalled();
    await run('staff-app', false, user);
    expect(prepare).toHaveBeenCalledWith(
      origin,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      user,
      expect.anything(),
      undefined
    );
    expect(viewer).not.toHaveBeenCalled();
    await expect(run('staff-app', false, undefined)).rejects.toThrow();
    await expect(run('other-public', true, user)).rejects.toThrow();
    await expect(run('unknown', undefined, user)).rejects.toThrow();
    await run('dealer-app', true, undefined);
    expect(viewer).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ appId: 'dealer-app' }),
      expect.any(Function)
    );
    // The configured app must never fall back to staff OIDC, even for a private version.
    viewer.mockRejectedValue(new Error('invalid binding'));
    await expect(run('dealer-app', false, user)).rejects.toThrow();
    await expect(run('dealer-app', true, user, 'stale')).rejects.toThrow();
    expect(runMock).toHaveBeenCalledTimes(2);
    delete process.env.TOOLJET_OIDC_REST_SOURCES;
    await expect(run('staff-app', false, user)).rejects.toMatchObject({ data: { status: 503 } });
    expect(runMock).toHaveBeenCalledTimes(2);
  });
});

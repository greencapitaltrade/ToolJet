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
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('false') } },
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
});

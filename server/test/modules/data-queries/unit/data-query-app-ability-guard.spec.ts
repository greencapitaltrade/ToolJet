// server/test/modules/data-queries/unit/data-query-app-ability-guard.spec.ts
import { FeatureAbilityGuard } from '@modules/data-queries/ability/app/guard';
import { App } from '@entities/app.entity';
import { MODULES } from '@modules/app/constants/modules';
import { APP_TYPES } from '@modules/apps/constants';
import { FeatureAbilityFactory } from '@modules/data-queries/ability/app';
import { FEATURE_KEY } from '@modules/data-queries/constants';
import type { ExecutionContext } from '@nestjs/common';

/** @group platform */
describe('data-queries app FeatureAbilityGuard', () => {
  let guard: FeatureAbilityGuard;

  beforeEach(() => {
    guard = new FeatureAbilityGuard(null as any, null as any, null as any, null as any, null as any);
  });

  const withResource = (resource: any) => (guard as any).getResource({ tj_app: resource });

  describe('getResource', () => {
    it('resolves a FRONT_END app to APP + GLOBAL_DATA_SOURCE', () => {
      expect(withResource({ type: APP_TYPES.FRONT_END })).toEqual([
        { resourceType: MODULES.APP },
        { resourceType: MODULES.GLOBAL_DATA_SOURCE },
      ]);
    });

    it('resolves a MODULE app to MODULES + GLOBAL_DATA_SOURCE', () => {
      expect(withResource({ type: APP_TYPES.MODULE })).toEqual([
        { resourceType: MODULES.MODULES },
        { resourceType: MODULES.GLOBAL_DATA_SOURCE },
      ]);
    });

    it('resolves a WORKFLOW app to WORKFLOWS + GLOBAL_DATA_SOURCE', () => {
      expect(withResource({ type: APP_TYPES.WORKFLOW })).toEqual([
        { resourceType: MODULES.WORKFLOWS },
        { resourceType: MODULES.GLOBAL_DATA_SOURCE },
      ]);
    });

    it('defaults an unrecognized app type to APP + GLOBAL_DATA_SOURCE', () => {
      expect(withResource({ type: 'something-else' })).toEqual([
        { resourceType: MODULES.APP },
        { resourceType: MODULES.GLOBAL_DATA_SOURCE },
      ]);
    });
  });

  it('checks each request’s app grant when a workflow query overlaps an unshared app query', async () => {
    const factory = new FeatureAbilityFactory({
      resourceActionsPermission: jest.fn().mockResolvedValue({ isEndUser: true }),
    } as never);
    let finishFirstLookup: () => void;
    const suspensionLookup = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstLookup = resolve;
          })
      )
      .mockResolvedValue(null);
    guard = new FeatureAbilityGuard(
      { get: (key) => (key === 'tjModuleId' ? MODULES.DATA_QUERY : FEATURE_KEY.RUN_VIEWER) } as never,
      { resolve: async () => factory } as never,
      {} as never,
      { log: jest.fn() } as never,
      { getRepository: () => ({ findOne: suspensionLookup }) } as never
    );
    const queryContext = (type: APP_TYPES, id: string) =>
      ({
        getClass: () => null,
        getHandler: () => null,
        switchToHttp: () => ({
          getRequest: () => ({
            user: { id: 'viewer', organizationId: 'workspace' },
            tj_app: { id, type, organizationId: 'workspace', isPublic: false },
            tj_resource_id: id,
            headers: {},
          }),
        }),
      }) as unknown as ExecutionContext;

    const unshared = guard.canActivate(queryContext(APP_TYPES.FRONT_END, 'unshared-app'));
    await expect(guard.canActivate(queryContext(APP_TYPES.WORKFLOW, 'workflow'))).resolves.toBe(true);
    finishFirstLookup();
    await expect(unshared).rejects.toThrow('You do not have permission');
  });

  it('getSubjectType returns App', () => {
    expect((guard as any).getSubjectType()).toBe(App);
  });

  it('forwardAbility is true', () => {
    expect((guard as any).forwardAbility()).toBe(true);
  });
});

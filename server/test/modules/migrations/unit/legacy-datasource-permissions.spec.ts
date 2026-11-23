/** @group database */
import type { QueryRunner } from 'typeorm';
import { CreateDatasourceGroupPermission1680152466161 } from '../../../../migrations/1680152466161-CreateDatasourceGroupPermission';

function mockQueryRunner(tables: string[], retired: boolean) {
  const runner = {
    hasTable: jest.fn(async (name: string) => tables.includes(name)),
    query: jest.fn().mockResolvedValue([{ retired }]),
    createTable: jest.fn(),
    createForeignKey: jest.fn(),
    dropTable: jest.fn(),
  };
  return { runner, queryRunner: runner as unknown as QueryRunner };
}

describe('CreateDatasourceGroupPermission', () => {
  const migration = new CreateDatasourceGroupPermission1680152466161();

  it('should leave retired permissions untouched on an upgrade that already replaced them', async () => {
    const { runner, queryRunner } = mockQueryRunner(['permission_groups'], true);

    await migration.up(queryRunner);
    expect(runner.query).toHaveBeenCalledWith(expect.any(String), [
      'DropGroupPermissionsOlderRelatedTables1720513124281',
    ]);
    expect(runner.createTable).not.toHaveBeenCalled();
    expect(runner.createForeignKey).not.toHaveBeenCalled();

    await migration.down(queryRunner);
    expect(runner.dropTable).toHaveBeenCalledWith('data_source_group_permissions', true);
  });

  it.each([
    { tables: ['group_permissions'], retired: true },
    { tables: ['permission_groups'], retired: false },
    { tables: [], retired: true },
  ])(
    'should retain the normal migration with tables $tables and retirement record $retired',
    async ({ tables, retired }) => {
      const { runner, queryRunner } = mockQueryRunner(tables, retired);

      await migration.up(queryRunner);

      expect(runner.createTable).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'data_source_group_permissions' }),
        true
      );
      expect(runner.createForeignKey).toHaveBeenCalledWith(
        'data_source_group_permissions',
        expect.objectContaining({ referencedTableName: 'group_permissions' })
      );
    }
  );
});

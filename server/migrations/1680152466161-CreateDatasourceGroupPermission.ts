import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateDatasourceGroupPermission1680152466161 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Some CE releases retired the legacy permission tables before shipping this migration.
    if (await this.legacyPermissionsWereRetired(queryRunner)) {
      return;
    }

    await queryRunner.createTable(
      new Table({
        name: 'data_source_group_permissions',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isGenerated: true,
            default: 'gen_random_uuid()',
            isPrimary: true,
          },
          {
            name: 'data_source_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'group_permission_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'read',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
          {
            name: 'update',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
          {
            name: 'delete',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            isNullable: false,
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            isNullable: false,
            default: 'now()',
          },
        ],
      }),
      true
    );

    await queryRunner.createForeignKey(
      'data_source_group_permissions',
      new TableForeignKey({
        columnNames: ['data_source_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'data_sources',
        onDelete: 'CASCADE',
      })
    );

    await queryRunner.createForeignKey(
      'data_source_group_permissions',
      new TableForeignKey({
        columnNames: ['group_permission_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'group_permissions',
        onDelete: 'CASCADE',
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const retired = await this.legacyPermissionsWereRetired(queryRunner);
    await queryRunner.dropTable('data_source_group_permissions', retired);
  }

  private async legacyPermissionsWereRetired(queryRunner: QueryRunner): Promise<boolean> {
    if ((await queryRunner.hasTable('group_permissions')) || !(await queryRunner.hasTable('permission_groups'))) {
      return false;
    }

    const [{ retired }] = (await queryRunner.query(
      'SELECT EXISTS (SELECT 1 FROM "migrations" WHERE "name" = $1) AS "retired"',
      ['DropGroupPermissionsOlderRelatedTables1720513124281']
    )) as { retired: boolean }[];
    return retired;
  }
}

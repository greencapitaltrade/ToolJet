import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConfiguredOidcWorkspaceSettings1795444800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE configured_oidc_workspace_settings (
        workspace_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        issuer text NOT NULL,
        client_id text NOT NULL,
        enabled boolean NOT NULL,
        revision uuid NOT NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE configured_oidc_workspace_settings');
  }
}

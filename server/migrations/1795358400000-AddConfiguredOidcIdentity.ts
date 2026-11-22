import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConfiguredOidcIdentity1795358400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE configured_oidc_identities (
        issuer varchar NOT NULL,
        subject varchar NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (issuer, subject),
        UNIQUE (issuer, user_id)
      )
    `);
    await queryRunner.query('ALTER TABLE user_sessions ADD COLUMN oidc_identity jsonb');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE user_sessions DROP COLUMN oidc_identity');
    await queryRunner.query('DROP TABLE configured_oidc_identities');
  }
}

import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { validate as isUuid } from 'uuid';
import { getDBConnection } from '@helpers/database.helper';
import {
  type ConfiguredOidcSettings,
  getConfiguredOidcSettings,
  getManagedOidcRegistrations,
  oidcReturnPath,
} from './configured-oidc.config';

type SavedRegistration = { issuer: string; client_id: string; enabled: boolean; revision: string };
export type ActiveOidcRegistration = ConfiguredOidcSettings & { revision?: string };
export enum WorkspaceOidcMode {
  DEFAULT = 'deployment_default',
  ENABLED = 'enabled',
  DISABLED = 'disabled',
}

export async function ensureWorkspaceOidcStorage(): Promise<void> {
  if (getConfiguredOidcSettings() || getManagedOidcRegistrations().size > 0) {
    await getDBConnection().query('SELECT 1 FROM configured_oidc_workspace_settings LIMIT 0');
  }
}

async function getSavedRegistration(workspaceId: string): Promise<SavedRegistration | undefined> {
  const [saved] = await getDBConnection().query<SavedRegistration[]>(
    'SELECT issuer, client_id, enabled, revision FROM configured_oidc_workspace_settings WHERE workspace_id = $1',
    [workspaceId]
  );
  return saved;
}

function matches(saved: SavedRegistration, registration: ConfiguredOidcSettings): boolean {
  return saved.issuer === registration.issuer && saved.client_id === registration.clientId;
}

export async function resolveWorkspaceOidc(
  workspaceId = getConfiguredOidcSettings()?.workspaceId
): Promise<ActiveOidcRegistration | null> {
  if (!workspaceId || !isUuid(workspaceId)) return null;
  workspaceId = workspaceId.toLowerCase();
  const legacy = getConfiguredOidcSettings();
  const fallback = legacy?.workspaceId === workspaceId ? legacy : null;
  const registration = getManagedOidcRegistrations().get(workspaceId) ?? fallback;
  if (!registration) return null;

  const saved = await getSavedRegistration(workspaceId);
  if (!saved) return fallback;
  if (!saved.enabled || !matches(saved, registration)) return null;
  // Keep the legacy registration readable by existing pods and cached browsers.
  return fallback ?? { ...registration, revision: saved.revision };
}

export async function describeWorkspaceOidc(workspaceId: string) {
  const registration = getManagedOidcRegistrations().get(workspaceId);
  if (!registration) return null;
  const saved = await getSavedRegistration(workspaceId);
  const legacy = getConfiguredOidcSettings()?.workspaceId === workspaceId;
  return {
    workspaceId: registration.workspaceId,
    issuer: registration.issuer,
    clientId: registration.clientId,
    redirectUri: registration.redirectUri,
    enabled: saved ? saved.enabled && matches(saved, registration) : legacy,
    usingDeploymentDefault: !saved,
    canEdit: process.env.TOOLJET_OIDC_WORKSPACE_SETTINGS_ENABLED === 'true',
  };
}

export async function setWorkspaceOidc(workspaceId: string, mode: WorkspaceOidcMode) {
  const registration = getManagedOidcRegistrations().get(workspaceId);
  if (!registration) throw new NotFoundException();
  if (process.env.TOOLJET_OIDC_WORKSPACE_SETTINGS_ENABLED !== 'true') throw new ServiceUnavailableException();

  const manager = getDBConnection();
  if (mode === WorkspaceOidcMode.DEFAULT) {
    await manager.query('DELETE FROM configured_oidc_workspace_settings WHERE workspace_id = $1', [workspaceId]);
  } else {
    await manager.query(
      `INSERT INTO configured_oidc_workspace_settings (workspace_id, issuer, client_id, enabled, revision)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id) DO UPDATE
       SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id, enabled = EXCLUDED.enabled, revision = EXCLUDED.revision
       WHERE (configured_oidc_workspace_settings.issuer, configured_oidc_workspace_settings.client_id,
              configured_oidc_workspace_settings.enabled) IS DISTINCT FROM
             (EXCLUDED.issuer, EXCLUDED.client_id, EXCLUDED.enabled)`,
      [workspaceId, registration.issuer, registration.clientId, mode === WorkspaceOidcMode.ENABLED, randomUUID()]
    );
  }
  return describeWorkspaceOidc(workspaceId);
}

export async function workspaceOidcReturnPath(value: unknown, registration: ActiveOidcRegistration) {
  const path = oidcReturnPath(value, registration);
  const fallback = `${registration.subpath}/`;
  if (!registration.revision || path === fallback) return path;

  const pathname = new URL(path, registration.origin).pathname;
  const identifier = pathname.slice(`${registration.subpath}/applications/`.length).split('/')[0];
  const [app] = await getDBConnection().query<{ found: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM apps WHERE organization_id = $1 AND (slug = $2 OR id::text = $2)) AS found`,
    [registration.workspaceId, identifier]
  );
  return app?.found ? path : fallback;
}

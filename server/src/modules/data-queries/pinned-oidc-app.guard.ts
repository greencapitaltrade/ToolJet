import { Injectable, type ExecutionContext } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { APP_TYPES } from '@modules/apps/constants';
import { AppsRepository } from '@modules/apps/repository';
import { getConfiguredOidcSettings } from '@modules/auth/oauth/configured-oidc.config';
import { ConfiguredOidcWorkspaceGuard, type OidcWorkspaceRequest } from '@modules/auth/oauth/configured-oidc-workspace';
import { VersionRepository } from '@modules/versions/repository';

@Injectable()
export abstract class PinnedOidcAppGuard extends ConfiguredOidcWorkspaceGuard {
  constructor(
    private readonly apps: AppsRepository,
    private readonly versions: VersionRepository
  ) {
    super();
  }

  protected abstract get appId(): string | undefined;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const id = this.appId;
    if (!id || !isUUID(id) || !(await super.canActivate(context))) return false;
    const request = context
      .switchToHttp()
      .getRequest<OidcWorkspaceRequest & { tj_app?: unknown; tj_resource_id?: string }>();
    const workspaceId = getConfiguredOidcSettings()?.workspaceId;
    if (!workspaceId || request.user?.organizationId !== workspaceId) return false;

    // Pin the resource independently of the caller before checking the app viewer permission.
    const app = await this.apps.findById(id, workspaceId);
    if (
      app?.id !== id ||
      app.organizationId !== workspaceId ||
      app.type !== APP_TYPES.FRONT_END ||
      app.isPublic !== false ||
      app.isMaintenanceOn ||
      !app.currentVersionId
    ) {
      return false;
    }
    const published = await this.versions.findOne({
      where: { id: app.currentVersionId, appId: id },
      select: { isPublic: true, isStub: true },
    });
    if (published?.isPublic !== false || published.isStub !== false) return false;

    request.tj_app = app;
    request.tj_resource_id = app.id;
    return true;
  }
}

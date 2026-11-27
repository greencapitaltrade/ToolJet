# Configured OpenID Connect in Community Edition

The existing default registration uses these deployment settings:

- `TOOLJET_OIDC_ISSUER` is the provider's declared issuer URL.
- `TOOLJET_OIDC_CLIENT_ID` and `TOOLJET_OIDC_CLIENT_SECRET` are the registered confidential client credentials.
- `TOOLJET_OIDC_WORKSPACE_ID` is the ToolJet workspace UUID.
- `TOOLJET_HOST` is the public HTTPS origin. Set `SUB_PATH` for a subpath deployment.

Register the callback at `<ToolJet origin>/api/oauth/oidc/callback`. For a subpath deployment at `/tools/`, the callback is `<ToolJet origin>/tools/api/oauth/oidc/callback`. The provider must support Authorization Code with S256 PKCE, `client_secret_basic`, and RS256 ID tokens. The sign-in button is available on the configured workspace login and app sign-in screens. An app can start the same flow through `GET /api/oauth/oidc/start?returnTo=/applications/<app-slug>`.

## Managed workspace configuration

Set `TOOLJET_OIDC_CONNECTORS` to a JSON object keyed by the ToolJet workspace UUID. The credential reference points to the name of an environment variable provided by the deployment's secret manager. Use `TOOLJET_OIDC_CLIENT_SECRET` or an environment name with that prefix followed by an underscore and a suffix.

```json
{
  "6b5aa378-072f-4022-977e-0066545ee3c6": {
    "issuer": "https://accounts.example.test/oidc",
    "clientId": "staff",
    "clientSecretEnv": "TOOLJET_OIDC_CLIENT_SECRET"
  },
  "94db67ea-e2e7-47ba-9d92-95cab041e726": {
    "issuer": "https://accounts.example.test/oidc",
    "clientId": "staff-second-workspace",
    "clientSecretEnv": "TOOLJET_OIDC_CLIENT_SECRET_SECOND"
  }
}
```

Provision one registration per workspace and use a distinct issuer/client pair for each. The workspace administrator can review the issuer, client ID and callback and enable the registration in **Workspace Settings → Workspace Login → OpenID Connect**. The server resolves the operator-provisioned credentials. Start requests include `workspaceId` from the selected workspace or saved app; the shared callback reads the workspace and activation revision from the persisted challenge. Disabling a managed registration also blocks its protected REST actor resolution.

### Rolling upgrade

1. Apply the additive workspace settings migration before starting the new image. Keep the legacy variables during migration and binary rollback.
2. Mirror the existing registration exactly if enabling Settings management for the legacy workspace. Its cached launch URL, challenge format and session stamp remain compatible. Invalid or conflicting managed configuration prevents server startup. Keep `TOOLJET_OIDC_WORKSPACE_SETTINGS_ENABLED` off until every replica has the new image and the same registrations.
3. Open workspace Settings writes with `TOOLJET_OIDC_WORKSPACE_SETTINGS_ENABLED=true`. Enable a new registration from its workspace only after every Thor and ToolJet replica can read its registration. Exercise start and callback on separate replicas and verify a private saved query. A workspace without a provisioned connector keeps its existing login methods.
4. **Restore deployment default** clears the workspace selection. The legacy workspace resumes using its original registration. A managed-only workspace returns to its existing login methods, with pending managed challenges and session proofs invalidated. Freezing Settings writes preserves stored selections. Restore the legacy default and withdraw additional workspace flows before using a binary that only reads the original registration.

## Workspace members and sessions

Use existing active ToolJet accounts and workspace memberships. On first sign-in, a verified provider email must match an active workspace member. ToolJet then binds the account to the issuer and subject. For a member without a verified provider email, an operator can instead verify that user's issuer subject and pre-bind the existing ToolJet user by adding a row to `configured_oidc_identities` (`issuer`, `subject`, `user_id`). Subsequent sign-ins resolve this binding. Changing the provider email leaves the identity binding intact.

For a server handler guarded by `JwtAuthGuard`, `SessionUtilService.getOidcActor` accepts the authenticated `@User()` principal in the configured workspace and returns the verified `{ issuer, sub, clientId }` from a session for the current OIDC client. A session without the client ID must sign in again. The private subject lookup verifies the user's current service and organization against the client registration. Provider tokens and the verified actor stay on the server.

## Native REST connections

Create a global REST API data source with the service's literal private origin as its base URL. Store service credentials in the data source's server-side options. Use ToolJet's existing data source permissions for people who author queries and its app grants for people who run the released app.

- Set `TOOLJET_OIDC_THOR_ORIGIN` to the private Thor service origin.
- Set `TOOLJET_OIDC_REST_SOURCES` to a JSON object mapping each installed data source UUID to its private service origin. Both settings accept Kubernetes service origins under `.svc.cluster.local`.
- Save each native query with a fixed HTTP method and a root-relative path. Parameters may occupy individual path segments, such as `/v1/records/{{parameters.recordId}}`. Use the query's URL parameters tab for query-string fields.

The REST connector resolves the current Thor subject server-side and sends the canonical IDs in `x-gct-user-id` and `x-gct-org-id` to the configured origin. It returns the normal query result and accepts service responses only from that origin.

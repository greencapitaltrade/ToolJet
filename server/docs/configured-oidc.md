# Configured OpenID Connect in Community Edition

Configure one HTTPS issuer and one ToolJet workspace on every server instance:

- `TOOLJET_OIDC_ISSUER` is the provider's declared issuer URL.
- `TOOLJET_OIDC_CLIENT_ID` and `TOOLJET_OIDC_CLIENT_SECRET` are the registered confidential client credentials.
- `TOOLJET_OIDC_WORKSPACE_ID` is the ToolJet workspace UUID.
- `TOOLJET_HOST` is the public HTTPS origin. Set `SUB_PATH` for a subpath deployment.

Register the callback at `<ToolJet origin>/api/oauth/oidc/callback`. For a subpath deployment at `/tools/`, the callback is `<ToolJet origin>/tools/api/oauth/oidc/callback`. The provider must support Authorization Code with S256 PKCE, `client_secret_basic`, and RS256 ID tokens. The sign-in button is available on the configured workspace login and app sign-in screens. An app can start the same flow through `GET /api/oauth/oidc/start?returnTo=/applications/<app-slug>`.

Use existing active ToolJet accounts and workspace memberships. On first sign-in, a verified provider email must match an active workspace member. ToolJet then binds the account to the issuer and subject. For a member without a verified provider email, an operator can instead verify that user's issuer subject and pre-bind the existing ToolJet user by adding a row to `configured_oidc_identities` (`issuer`, `subject`, `user_id`). Subsequent sign-ins resolve this binding. Changing the provider email leaves the identity binding intact.

For a server handler guarded by `JwtAuthGuard`, `SessionUtilService.getOidcActor` accepts the authenticated `@User()` principal in the configured workspace and returns the verified `{ issuer, sub, clientId }` from a session for the current OIDC client. A session without the client ID must sign in again. The partner-operations relay sends the issuer and client ID only to Thor’s private subject lookup. Thor verifies the user's current service and organization against the client registration. Provider tokens and the actor stamp stay on the server.

For a same-origin application relay, set `tj-workspace-id` to the server-configured ToolJet workspace UUID in middleware before invoking `JwtAuthGuard`. Use the native `tj_auth_token` cookie and discard any client-supplied workspace header, `tj_auth_token` header, admin API key or delegation credential. The workspace UUID only selects the ToolJet login session.

## Partner operations relay

The optional `POST /api/partner-ops` relay uses the configured workspace's native cookie and the verified issuer and subject from that session. To enable it, set `TOOLJET_PARTNER_OPS_ISSUER` to the exact approved issuer, `TOOLJET_PARTNER_OPS_THOR_ORIGIN` to Thor's internal Kubernetes service origin, and `TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN` to the server-managed upstream origin. It accepts JSON requests only from the configured ToolJet origin and uses the server-configured workspace.

Before setting these values, restrict both Thor's `/v1/users/oidc-subject/:subject` and the upstream `/v1/channel-partners/operator` routes to ToolJet's authenticated workload identity. Plain HTTP is accepted only for a fully qualified Kubernetes service name and requires authenticated mesh transport. ToolJet resolves the verified subject against Thor on every operation, then sends only the returned user and organization as `x-gct-user-id` and `x-gct-org-id`. The upstream checks current membership and resource scope for every operation.

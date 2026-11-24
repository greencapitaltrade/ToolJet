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

The `POST /api/partner-ops` relay uses the configured workspace's native cookie and the verified identity from that session. Set `TOOLJET_PARTNER_OPS_THOR_ORIGIN` and `TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN` to the internal Kubernetes service origins for Thor and Destiny. The relay accepts JSON from the configured ToolJet origin and authenticates against the configured workspace.

ToolJet resolves the verified subject against Thor on every operation. It forwards the resulting `x-gct-user-id` and `x-gct-org-id` to Destiny over the existing authenticated service transport. Destiny checks current membership and resource scope through its standard partner APIs. The app relay maps record selectors to the partner directory, applications, DPD, referrals, and draft fee routes.

## Credit review relay

The review app's saved query can send queue, case, and action requests to `POST /api/credit-review`. Set `TOOLJET_CREDIT_REVIEW_APP_ID` to the private front-end app UUID in the configured workspace. The app needs a released version. Each request requires a same-origin native workspace cookie and the standard app viewer permission.

Grant access to Credit Review through ToolJet app permissions. Use the same private Thor and Destiny origins as partner operations. Set the server-only `TOOLJET_CREDIT_REVIEW_SIGNING_KEY` to the base64-encoded DER PKCS#8 Ed25519 private key matching Destiny's configured review authority public key. ToolJet signs the verified Thor user, organization, queue or case, action inputs, and short expiry. Destiny uses the verified organization to scope cases and the pinned application flow to determine which actions are available.

## Finance relay

The Finance app calls `POST /api/finance` with a single `operation` field set to `queue` or `csv`. Set `TOOLJET_FINANCE_APP_ID` to the private released Finance app ID in the configured workspace. The relay requires the native workspace cookie and app viewer permission, then resolves the actor using `TOOLJET_PARTNER_OPS_THOR_ORIGIN`.

Grant access to Finance through ToolJet app permissions. Set `TOOLJET_FINANCE_IRONMAN_ORIGIN` to the private Ironman service origin and configure `TOOLJET_FINANCE_READ_KEY` and `TOOLJET_FINANCE_CSV_KEY` as separate server-managed credentials for the organization. Ironman authenticates the service credential and scopes the queue to the organization verified by Thor. Queue reads cover all products available to that organization. Ironman derives and reconciles the whole eligible manual payout batch before returning CSV.

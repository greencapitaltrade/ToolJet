# Configured OpenID Connect in Community Edition

Configure one HTTPS issuer and one ToolJet workspace on every server instance:

- `TOOLJET_OIDC_ISSUER` is the provider's declared issuer URL.
- `TOOLJET_OIDC_CLIENT_ID` and `TOOLJET_OIDC_CLIENT_SECRET` are the registered confidential client credentials.
- `TOOLJET_OIDC_WORKSPACE_ID` is the ToolJet workspace UUID.
- `TOOLJET_HOST` is the public HTTPS origin. Set `SUB_PATH` for a subpath deployment.

Register the callback at `<ToolJet origin>/api/oauth/oidc/callback`. For a subpath deployment at `/tools/`, the callback is `<ToolJet origin>/tools/api/oauth/oidc/callback`. The provider must support Authorization Code with S256 PKCE, `client_secret_basic`, and RS256 ID tokens. The sign-in button is available on the configured workspace login and app sign-in screens. An app can start the same flow through `GET /api/oauth/oidc/start?returnTo=/applications/<app-slug>`.

Use existing active ToolJet accounts and workspace memberships. On first sign-in, a verified provider email must match an active workspace member. ToolJet then binds the account to the issuer and subject. For a member without a verified provider email, an operator can instead verify that user's issuer subject and pre-bind the existing ToolJet user by adding a row to `configured_oidc_identities` (`issuer`, `subject`, `user_id`). Subsequent sign-ins resolve this binding. Changing the provider email leaves the identity binding intact.

For a server handler guarded by `JwtAuthGuard`, `SessionUtilService.getOidcActor` accepts the authenticated `@User()` principal in the configured workspace and returns the verified `{ issuer, sub, clientId }` from a session for the current OIDC client. A session without the client ID must sign in again. The partner-operations relay sends the issuer and client ID only to Thor’s private subject lookup. Thor verifies the user's current service and organization against the client registration. Provider tokens and the actor stamp stay on the server.

## Saved queries for partner operations, credit review, and Finance

Import and release the three apps in the configured ToolJet workspace. Set `TOOLJET_PARTNER_OPS_APP_ID`, `TOOLJET_CREDIT_REVIEW_APP_ID`, and `TOOLJET_FINANCE_APP_ID` to the installed apps' distinct UUIDs to assign their server-side connections. Share each app through ToolJet's normal app permissions.

The apps use the built-in REST API data source and the native `POST /api/data-queries/:id/run` viewer route. Each saved query uses a POST URL of the form `https://tooljet-relay.invalid/<operation>` and a raw request body of `{{parameters.requestBody}}`. The query receives its operation from the saved URL and JSON inputs from the `requestBody` parameter. ToolJet dispatches the operation internally and resolves the current Thor actor on the server. Finance's CSV query returns the CSV text in `data.csv` so the app can download it.

### Partner operations

Set `TOOLJET_PARTNER_OPS_THOR_ORIGIN` and `TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN` to the private Thor and Destiny service origins. ToolJet forwards `x-gct-user-id` and `x-gct-org-id` from Thor to Destiny over the existing authenticated service transport. The saved queries cover the partner directory, applications, DPD, referrals, and draft fees. Destiny applies its standard membership and resource checks.

### Credit review

Use the same private Thor and Destiny origins. Set the server-only `TOOLJET_CREDIT_REVIEW_SIGNING_KEY` to the base64-encoded DER PKCS#8 Ed25519 private key matching Destiny's configured review authority public key. ToolJet signs the verified actor, queue or case, action inputs, and short expiry. Destiny uses the verified organization to scope cases and the pinned application flow to determine which actions are available.

### Finance

Set `TOOLJET_FINANCE_IRONMAN_ORIGIN` to the private Ironman service origin. Configure `TOOLJET_FINANCE_READ_KEY` and `TOOLJET_FINANCE_CSV_KEY` as separate server-managed credentials. Ironman authenticates the credential and scopes the queue to the organization verified by Thor. Queue reads cover all products available to that organization. Ironman derives and reconciles the whole eligible manual payout batch before returning CSV.

# Configured OpenID Connect in Community Edition

Configure one HTTPS issuer and one ToolJet workspace on every server instance:

- `TOOLJET_OIDC_ISSUER` is the provider's declared issuer URL.
- `TOOLJET_OIDC_CLIENT_ID` and `TOOLJET_OIDC_CLIENT_SECRET` are the registered confidential client credentials.
- `TOOLJET_OIDC_WORKSPACE_ID` is the ToolJet workspace UUID.
- `TOOLJET_HOST` is the public HTTPS origin. Set `SUB_PATH` for a subpath deployment.

Register the callback at `<ToolJet origin>/api/oauth/oidc/callback`. For a subpath deployment at `/tools/`, the callback is `<ToolJet origin>/tools/api/oauth/oidc/callback`. The provider must support Authorization Code with S256 PKCE, `client_secret_basic`, and RS256 ID tokens. The sign-in button is available on the configured workspace login and app sign-in screens. An app can start the same flow through `GET /api/oauth/oidc/start?returnTo=/applications/<app-slug>`.

Use existing active ToolJet accounts and workspace memberships. On first sign-in, a verified provider email must match an active workspace member. ToolJet then binds the account to the issuer and subject. For a member without a verified provider email, an operator can instead verify that user's issuer subject and pre-bind the existing ToolJet user by adding a row to `configured_oidc_identities` (`issuer`, `subject`, `user_id`). Subsequent sign-ins resolve this binding. Changing the provider email leaves the identity binding intact.

For a server handler guarded by `JwtAuthGuard`, `SessionUtilService.getOidcActor` accepts the authenticated `@User()` principal in the configured workspace and returns the verified `{ issuer, sub, clientId }` from a session for the current OIDC client. A session without the client ID must sign in again. The private subject lookup verifies the user's current service and organization against the client registration. Provider tokens and the verified actor stay on the server.

## Native REST connections

Create a global REST API data source with the service's literal private origin as its base URL. Store service credentials in the data source's server-side options. Use ToolJet's existing data source permissions for people who author queries and its app grants for people who run the released app.

- Set `TOOLJET_OIDC_THOR_ORIGIN` to the private Thor service origin.
- Set `TOOLJET_OIDC_REST_SOURCES` to a JSON object mapping each installed data source UUID to its private service origin. Both settings accept Kubernetes service origins under `.svc.cluster.local`.
- Save each native query with a fixed HTTP method and a root-relative path. Parameters may occupy individual path segments, such as `/v1/records/{{parameters.recordId}}`. Use the query's URL parameters tab for query-string fields.

The REST connector resolves the current Thor subject server-side and sends the canonical IDs in `x-gct-user-id` and `x-gct-org-id` to the configured origin. It returns the normal query result and accepts service responses only from that origin.

# Borrower onboarding relay

The native ToolJet borrower app sends JSON to `POST /api/borrower-onboarding`. The relay is disabled until the server has a valid `TOOLJET_BORROWER_ONBOARDING` managed secret. Configure one authorized organization per dedicated browser origin. The JSON object has these properties.

| Property | Value |
| --- | --- |
| `origin` | Exact HTTPS origin that hosts the public borrower app |
| `organizationId` | The organization ID bound to the LSP credential, as a decimal string |
| `furyUrl` | Exact HTTPS gateway URL with path `/v2/graphql` and no query or fragment |
| `lspSecret` | Managed LSP API credential authorized through Heimdallr |
| `returnUrl` | Released ToolJet app URL on the same origin, without query or fragment |
| `providerOrigins` | HTTPS origins returned by validated, supported actions for the released policy |

Confirm the gateway strips client identity headers, establishes the LSP organization using its credential, and consumes the credential before forwarding. Keep the private settings in the server's secret store. The browser origin must also be the ToolJet host or a registered custom domain. Verify the exact Fury borrower and eligibility schema and the matching private Destiny eligibility policy before configuring the relay. Destiny's supported chart value `borrowerReferralEligibility` couples the endpoint to the Fury workload authorization policy when the mesh is enabled. The opaque referral must match an active dealer and a published product with an active Infinity-enabled policy both before OTP and at case creation. Register the borrower app's return origin with the existing Destiny provider callback policy.

Production applications should issue authenticated v3 borrower links with `#onboarding=<opaque token>`. A fragment stays out of ordinary server request logs. The borrower app also accepts previously issued query-string links. The relay stores the browser flow server-side in the existing Redis client and rotates its opaque cookie on OTP verification. The tenant, application ID, action type and data come from the verified flow and its scoped Fury response. The relay exposes only UI labels and supported actions, and can indicate that an active step is unavailable to this client.

The initial controls cover explicitly configured PAN collection, DigiLocker identity, account aggregator consent, text-based form fields, manual document uploads and Digio agreement. The relay reads the active step type, allowed kinds, document requirements and form fields from Fury's `applicationFlow`. PAN collection records the identifier. Identity verification uses the configured DigiLocker action. Account aggregator consent resolves the applicant's saved PAN in Destiny. Set `require_organization_credentials: true` on the pinned bank step and verify the organization's Saafe integration. Consent and receipt both require that integration. Direct Aadhaar XML/OTP, mixed provider collections, image form uploads, and other provider actions need a verified control before publishing a policy that requires them. Automated bureau status is display-only. The relay does not define product documentation requirements or the order of lender steps.

The native file picker sends one PDF, JPEG or PNG up to 10 MiB with the node ID and document code to `POST /api/borrower-onboarding/document`. The relay reads the pending manual requirements for its authenticated case from Fury. Fury uses the verified actor to delegate to Destiny, which checks the active node again, stores the evidence and advances the flow when the configured requirements permit it.

An active selfie node with the configured `CAPTURE` action opens the existing Fury live-face preview. Set `returnUrl` to the exact released viewer URL with its page handle, such as `/applications/borrower-documentation/documentation`. Hulk preserves the popup opener on that canonical GET path. The viewer posts the node ID and one camera JPEG up to 96 KiB to `POST /api/borrower-onboarding/selfie`. The same applicant session submits it through Fury as `SELFIE/CAPTURE`, and Destiny applies the configured matching and advancement policy.

The relay can display a document request when Destiny supplies it for the primary applicant and the corresponding bank statement control is active. The borrower sees the reason and can resubmit through the same account aggregator control. Refresh reads the current request from the existing scoped flow. This relay revision requires Fury's nullable `applicationFlow.documentRequest` schema field.

# login-configs module

Owns login configuration discovery and workspace or instance administration. The public
workspace response contains only the supported login choices.

## Invariants

- Workspace Settings reads and writes use the authenticated workspace context and the
  existing workspace administrator ability. A request body cannot select another workspace.
- The CE managed OIDC control changes the activation of an explicitly provisioned registration
  through `PATCH /login-configs/organization/managed-oidc`. The issuer, client and credential
  reference come from the deployment. Keep raw credentials out of responses.
- The public response reports whether OIDC is active. The shared callback resolves the actual
  registration from its persisted challenge. See `server/docs/configured-oidc.md`.

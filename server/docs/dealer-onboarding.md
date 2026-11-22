# Dealer applicant admission

`POST /api/dealer-onboarding` is the same-origin route for a new dealer to use
their v2 link and existing mobile verification. It shares the applicant HTTP,
Fury and Redis session controls with borrower onboarding. The legacy ToolJet
dealer app remains private and continues to use its native forms.

The relay stays disabled without the managed server secret
`TOOLJET_DEALER_ONBOARDING`. It accepts the existing ToolJet browser `origin`,
authenticated `organizationId`, fixed HTTPS `furyUrl` ending in `/v2/graphql`,
and pre-authorized `lspSecret`. Keep the secret exclusively server-side. The
pre-OTP check uses the exact Fury-workload-only Destiny endpoint and a selected
immutable dealer policy with `dealer_referral_required: true`. A link is never
an identity grant. After OTP, the server holds the verified Fury session and
checks every case using the referral and verified user.

| Operation | Input | Result |
| --- | --- | --- |
| `entry` | v2 `referralToken` and empty `fields` | `invite` or `phone` |
| `requestOtp` | `fields.phone` | `otp` |
| `verifyOtp` | `fields.otp` | `pan` and rotated opaque session cookie |
| `lookup` | `fields.pan` | new business category or the applicant’s existing draft |
| `start` | `gstin`, `businessName`, `applicantName`, `applicantRole`, `email`, optional `firmType` | the same scoped draft on retry |
| `saveEntityDetails` | server-selected `premises` and applicable `cin` or `llpin` | the same draft after an owned, versioned details update |
| `status` | empty `fields` | confirmed stage or draft status and current policy step |

The applicant selects Partnership or LLP after a firm PAN. The registry
portion of GSTIN must match the business PAN. Company and LLP registry evidence
still uses the established review process. The browser never chooses the parent,
tenant, applicant ID, draft ID, or signer on this admission route.

Keep the public route and its ToolJet app disabled until the remaining draft
actions are verified. The response only offers entity details while the pinned
details step is pending and the linked applicant owns a writable draft. A second
server status check guards that action before saving. The relevant remaining
owner contracts are below.

| Continuation | Existing contract and required linkage |
| --- | --- |
| Bank consent and statements | Scoped Destiny case AA routes. Use the server-selected draft, current document requirements and the existing provider lifecycle. |
| Entity proofs, cheque and live premises photo | Destiny document requirements determine exact codes and count. The scoped Fury rear-camera popup produces photo and fresh coordinates in the staged native app. The public relay still needs purpose-specific private file transport. |
| Each person’s KYC and match | Scoped participant consent must bind the actor to their own person association and current version before DigiLocker or selfie. The staged native app uses the separate Fury camera popup. |
| All required signers and review | The pinned dealer policy fixes the signer roster. Only the current person may initiate their own provider action. Do not forward an arbitrary signer from a browser or expose private PDFs. |

The private ToolJet form patch already knows the existing participant, document,
camera and eSign routes. Do not make that app public as a shortcut. Its browser
gateway retains bearer state and broad private query envelopes. The public
continuation requires explicit actions for the confirmed applicant role and
current step and must be tested before activation.

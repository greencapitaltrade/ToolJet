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
server status check guards that action before saving. The relevant owner contracts are below.

`POST /api/dealer-onboarding/document` accepts one `multipart/form-data` file
and a server-projected `code`. A camera capture includes `location` from the
existing Fury popup. The relay checks the verified session before reading the
file, limits attachments to 10 MiB, refreshes the pinned requirement and case
version, and forwards to the fixed authenticated Fury document route. The UI
receives new counts and document labels without file references or data. Bank
statements use PDF. Cheques use JPEG or PNG. Location evidence requires a
freshly geotagged JPEG. The viewer offers only the live mobile camera for
this requirement.

| Continuation | Existing contract and required linkage |
| --- | --- |
| Bank consent and statements | PDF attachment is available through the document action. AA and account verification need their existing tenant-approved provider lifecycle. |
| Entity proofs, cheque and live premises photo | Destiny document requirements determine exact codes and count. The scoped Fury rear-camera popup produces photo and fresh coordinates in the staged native app. The public relay uses the existing private registered-document storage through Fury. |
| Each person’s KYC and match | Scoped participant consent must bind the actor to their own person association and current version before DigiLocker or selfie. The staged native app uses the separate Fury camera popup. |
| All required signers and review | The pinned dealer policy fixes the signer roster. Only the current person may initiate their own provider action. Do not forward an arbitrary signer from a browser or expose private PDFs. |

The private ToolJet form patch already knows the existing participant, document,
camera and eSign routes. Do not make that app public as a shortcut. Its browser
gateway retains bearer state and broad private query envelopes. The public
continuation requires explicit actions for the confirmed applicant role and
current step and must be tested before activation.

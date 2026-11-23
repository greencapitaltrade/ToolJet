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

### Dealer owner dossier

The dedicated `POST /api/dealer-onboarding/dossier` form route uses the
same-origin verified dealer session. It accepts `STATUS` or one current form
action with the displayed draft version. The relay supplies the draft and signed
referral from the existing session and obtains the current form state from
Destiny before writing. Results include the current version and available forms.
Write values go directly from the native form to this route and remain outside
ToolJet queries, tracing and applicant session storage.

The `FURY_DEALER_OWNER_DOSSIER_ENABLED` and
`DESTINY_DEALER_OWNER_DOSSIER_ENABLED` flags default off.

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

## Separate participant session

`POST /api/dealer-onboarding/participant` uses its own opaque HttpOnly cookie
and Redis keys. Keep `TOOLJET_DEALER_PARTICIPANT` unset until the participant
workflow is ready. The managed configuration uses the same four connection
settings as dealer onboarding plus an exact HTTPS `kycOrigin` and
`signingOrigin`. Redirects from a different origin are refused.

The route accepts `entry`, `requestOtp` and `verifyOtp` using the same shapes as
dealer admission. After independent OTP, `attach` accepts `fields.consentId`.
Fury and Destiny must match the receipt to the authenticated participant and
the signed dealer parent before returning status. The server stores the receipt
for the session. `status`, `startKyc`, `syncKyc`, `sign` and `withdraw` accept
empty `fields`. Public responses contain only the projected status and allowed
actions, plus an approved provider redirect when needed.

An owner can use `inviteParticipant` with the intended `mobile`, copy the
invitation, list `participantRequests`, and `acceptParticipant` with an exact
pending `consentId` and the listed `version`. The ToolJet server uses its
verified draft and signed referral for each action. It does not dispatch any
notification.

The participant link carries an opaque invitation reference alongside the
signed referral. `entry` accepts it as `fields.invitationId`. The relay does
not look up the reference before independent OTP. `status` then recovers the
participant’s own receipt or requests their consent details. `claim` accepts
only `consent`, `name`, `role`, `din` and `kyc_contact`. Destiny checks the
verified mobile against the owner’s invitation. The relay stores the receipt
in the participant session and continues through the same own-person actions.
The separate existing-receipt entry remains available for compatibility.

The staged app remains private. Participant selfie transport and native viewer
verification are required before enabling this workflow.

## Owner agreement and submission

`agreementStatus` returns the current stage and at most one allowed action.
`prepareAgreement`, `verifyBank`, `freezeAgreement`, `refreshSignatures`, and
`submitForReview` accept no browser fields. The relay supplies the case,
signed referral and current version from its authenticated owner session.
Destiny checks the original owner and pinned dealer policy again for each
operation. Responses omit account details, signed files and signer links.

Preparation requires registered evidence and opens any configured intermediate
review. Bank verification uses the saved execution data, the pinned product,
and the configured AU remitter. Statement attachments and the verified bank
snapshot are separate prerequisites. Agreement preparation preserves the snapshot and
frozen Aadhaar signer roster. Submission requires completed provider signing
and opens independent review. Existing fee checks remain on review claims
and decisions.

The bank and legal execution details and the owner's own KYC, selfie, and
signature continue through the existing private intake routes.

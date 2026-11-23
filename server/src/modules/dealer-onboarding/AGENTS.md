# Dealer onboarding

`controller.ts` keeps both same-origin routes behind the configured applicant
scope. `relay.ts` holds the referral, PAN and verified Fury device session in
the shared short-lived applicant store.

- The upload route authenticates, locks and rate limits the applicant session
  before parsing the bounded multipart body.
- Document requirements and case version come from the verified scoped case.
  The browser supplies one allowed document code and its evidence. It never
  supplies a case identifier, version, tenant, storage reference or signer.
- The mobile camera popup supplies geotagged JPEG evidence. The relay bounds
  the image and requires fresh location, and Destiny registers the attachment.
- Do not log or persist document data in the relay. Refer to
  `server/docs/dealer-onboarding.md` for the owner contracts.
- The participant route has its own configuration, Redis scope and HttpOnly
  cookie. It verifies OTP before attaching a consent receipt. Its trusted
  downstream verifies the signed dealer parent and the authenticated receipt
  actor before displaying status or running an own-person action.
- Owner handoff operations use the draft and signed referral already stored in
  the verified owner session. The participant route stores only the opaque
  invitation reference before OTP, then obtains the current receipt downstream.
  Keep copied links and the participant role out of query logs and storage.
- Dealer owner identity uses the existing dealer session and separate
  same-origin identity routes. The relay obtains the current owner status from
  Fury before an action or binary upload. No owner, signer, version or provider
  URL comes from the browser. The owner and participant routes share the
  bounded JPEG parser.

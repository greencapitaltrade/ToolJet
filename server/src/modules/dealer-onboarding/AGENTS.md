# Dealer onboarding

`controller.ts` keeps both same-origin routes behind the configured applicant
scope. `relay.ts` holds the referral, PAN and verified Fury device session in
the shared short-lived applicant store.

- The upload route authenticates, locks and rate limits the applicant session
  before parsing the bounded multipart body.
- PAN lookup and creation send the signed referral from Redis. Once bound,
  status reads and updates use the stored draft ID and verified session.
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
- The owner dossier form uses the dedicated same-origin route. Keep form values
  in that request only. The bound session and Destiny determine the draft,
  policy, version and available forms. Never add dossier fields to native
  query parameters or the applicant session.
- Owner signing uses the current completion version, the verified owner
  session, and the matching dealer participant configuration's exact HTTPS
  signing origin. Keep the provider link out of session storage and return
  it only on an explicit own-sign action.

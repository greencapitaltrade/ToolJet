# Dealer onboarding

`controller.ts` keeps the same-origin routes behind the configured applicant
scope. `relay.ts` holds the referral, PAN and verified Fury device session in
the shared short-lived applicant store.

- The upload route authenticates, locks and rate limits the applicant session
  before parsing the bounded multipart body.
- PAN lookup and creation send the signed referral from Redis. Once bound,
  status reads and updates use the stored draft ID and verified session.
- GST Account Aggregator actions use the verified draft and its stored PAN.
  The session keeps the request ID. The browser receives masked registrations
  with opaque selection keys and the current provider consent link when pending.
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
  actor before displaying status or running an own-person action. Participant
  invitations carry the dealer's v3 referral and an opaque invitation ID.
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
- Dealer owner identity uses the existing dealer session and separate
  same-origin identity routes. The relay obtains the current owner status from
  Fury before an action or binary upload. No owner, signer, version or provider
  URL comes from the browser. The owner and participant routes share the
  bounded JPEG parser. The own-sign action uses the same scoped identity route
  and exact configured signing origin as the existing completion route.

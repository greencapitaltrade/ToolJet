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

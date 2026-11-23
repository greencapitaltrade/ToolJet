# Borrower onboarding

- Keep the verified Thor session, referral and bound application in the short-lived
  applicant store. The borrower browser sends an opaque session cookie and an
  active node selector.
- The document action derives the allowed manual codes from the current scoped
  flow status. The browser supplies only an active node, a code and one file.
- Authenticate, lock and rate limit the session before parsing the multipart
  request. Keep file data out of the session and request telemetry.
- Fury forwards the verified actor to Destiny. Destiny owns the configured
  requirements, evidence storage and workflow advancement.

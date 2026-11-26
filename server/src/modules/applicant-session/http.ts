import type { Request, Response } from 'express';
import { ApplicantPurpose, ApplicantRequestError } from './fury';

export type ApplicantHttpRequest = Request & { rawBody?: string };

export async function handleApplicantRequest<T extends { origin: string }>(
  req: ApplicantHttpRequest,
  res: Response,
  settings: T | null,
  purpose: ApplicantPurpose,
  run: (
    scope: T,
    input: unknown,
    id: string | undefined,
    setCookie: (id: string, ttl: number) => void
  ) => Promise<unknown>,
  mediaType = 'application/json'
) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const label = purpose === 'borrower' ? 'Borrower' : 'Dealer';
  const failure = (status: number) => res.status(status).json({ error: `${label} onboarding request unavailable` });
  if (!settings) return failure(404);
  if (
    req.get('origin') !== settings.origin ||
    (req.get('sec-fetch-site') !== undefined && req.get('sec-fetch-site') !== 'same-origin')
  )
    return failure(403);
  if (!req.is(mediaType)) return failure(415);
  if (mediaType === 'application/json') {
    if (
      Number(req.get('content-length')) > 16 * 1024 ||
      (req.rawBody !== undefined && Buffer.byteLength(req.rawBody) > 16 * 1024)
    )
      return failure(413);
  }
  const sessionCookie = `__Host-tj-${purpose}-onboarding`;
  const id = req.cookies?.[sessionCookie];
  try {
    const result = await run(settings, req.body, typeof id === 'string' ? id : undefined, (fresh, ttl) => {
      res.cookie(sessionCookie, fresh, {
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: ttl * 1000,
      });
    });
    return res.status(200).json(result);
  } catch (error) {
    return failure(error instanceof ApplicantRequestError ? error.status : 503);
  }
}

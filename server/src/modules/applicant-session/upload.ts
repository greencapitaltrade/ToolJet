import type { RequestHandler, Response } from 'express';
import { ApplicantRequestError, rejectApplicant } from './fury';
import type { ApplicantHttpRequest } from './http';

export const maxApplicantDocumentBytes = 10 * 1024 * 1024;

export async function parseApplicantUpload(
  req: ApplicantHttpRequest,
  res: Response,
  parser: RequestHandler,
  maxBytes: number
) {
  if (!req.is('multipart/form-data')) return rejectApplicant(415);
  if (Number(req.get('content-length')) > maxBytes + 4096) return rejectApplicant(413);
  await new Promise<void>((resolve, reject) => {
    parser(req, res, (error) => {
      if (error) reject(new ApplicantRequestError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400));
      else resolve();
    });
  });
}

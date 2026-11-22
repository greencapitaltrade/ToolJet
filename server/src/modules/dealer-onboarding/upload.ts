import type { Response } from 'express';
import * as multer from 'multer';
import { ApplicantRequestError, rejectApplicant } from '../applicant-session/fury';
import type { ApplicantHttpRequest } from '../applicant-session/http';
import { maxDealerDocumentBytes } from './relay';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxDealerDocumentBytes, files: 1, fields: 2, fieldSize: 512, parts: 4 },
}).single('file');

export async function parseDealerUpload(req: ApplicantHttpRequest, res: Response) {
  if (!req.is('multipart/form-data')) return rejectApplicant(415);
  if (Number(req.get('content-length')) > maxDealerDocumentBytes + 4096) return rejectApplicant(413);
  await new Promise<void>((resolve, reject) => {
    upload(req, res, (error) => {
      if (error) reject(new ApplicantRequestError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400));
      else resolve();
    });
  });
  if (!req.file || Object.keys(req.body).some((key) => !['code', 'location'].includes(key)))
    return rejectApplicant(400);
  try {
    return {
      code: req.body.code,
      file: req.file.buffer,
      ...(req.body.location !== undefined ? { location: JSON.parse(req.body.location) } : {}),
    };
  } catch {
    return rejectApplicant(400);
  }
}

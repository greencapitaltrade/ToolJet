import type { Response } from 'express';
import * as multer from 'multer';
import { rejectApplicant } from '../applicant-session/fury';
import type { ApplicantHttpRequest } from '../applicant-session/http';
import { parseApplicantUpload } from '../applicant-session/upload';
import { maxDealerSelfieBytes } from './selfie';
import { maxDealerDocumentBytes } from './relay';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxDealerDocumentBytes, files: 1, fields: 2, fieldSize: 512, parts: 4 },
}).single('file');
const selfieUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxDealerSelfieBytes, files: 1, fields: 0, parts: 2 },
}).single('file');

export async function parseDealerUpload(req: ApplicantHttpRequest, res: Response) {
  await parseApplicantUpload(req, res, upload, maxDealerDocumentBytes);
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

export async function parseDealerSelfie(req: ApplicantHttpRequest, res: Response) {
  await parseApplicantUpload(req, res, selfieUpload, maxDealerSelfieBytes);
  if (!req.file || req.file.mimetype !== 'image/jpeg' || Object.keys(req.body).length) return rejectApplicant(400);
  return req.file.buffer;
}

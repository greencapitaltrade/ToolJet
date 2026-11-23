import type { Response } from 'express';
import * as multer from 'multer';
import { rejectApplicant } from '../applicant-session/fury';
import type { ApplicantHttpRequest } from '../applicant-session/http';
import { maxApplicantDocumentBytes, parseApplicantUpload } from '../applicant-session/upload';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxApplicantDocumentBytes, files: 1, fields: 2, fieldSize: 128, parts: 4 },
}).single('file');

export async function parseBorrowerUpload(req: ApplicantHttpRequest, res: Response) {
  if (req.originalUrl.includes('?')) return rejectApplicant(400);
  await parseApplicantUpload(req, res, upload, maxApplicantDocumentBytes);
  if (!req.file || Object.keys(req.body).some((key) => !['nodeId', 'code'].includes(key))) return rejectApplicant(400);
  return { nodeId: req.body.nodeId, code: req.body.code, file: req.file.buffer };
}

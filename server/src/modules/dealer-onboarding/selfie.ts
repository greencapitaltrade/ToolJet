import { rejectApplicant } from '../applicant-session/fury';

export const maxDealerSelfieBytes = 96 * 1024;

export function dealerSelfieData(file: Buffer) {
  if (file.length > maxDealerSelfieBytes) return rejectApplicant(413);
  if (
    file.length < 5 ||
    file[0] !== 0xff ||
    file[1] !== 0xd8 ||
    file[2] !== 0xff ||
    file[file.length - 2] !== 0xff ||
    file[file.length - 1] !== 0xd9
  )
    return rejectApplicant(422);
  return `data:image/jpeg;base64,${file.toString('base64')}`;
}

import { createHash, createHmac } from 'node:crypto';

export const VN_ADMISSION_PATH = '/v1/channel-partners/intakes/admission';
export const VN_ADMISSION_SELFIE_PATH = '/v1/channel-partners/intakes/admission-selfie';
export const VN_ADMISSION_DOCUMENT_PATH = '/v1/channel-partners/intakes/admission-document';
type Admission = {
  organizationId: string;
  issuerOrgId: string;
  userId: string;
  email: string;
  referral: string;
  body: string;
};

/** Construct only after verifying the server-side VN continuation and identity. */
export function vnAdmissionHeaders(
  value: Admission,
  key: string,
  issuedAt = String(Math.floor(Date.now() / 1000)),
  path: string = VN_ADMISSION_PATH
) {
  const id = /^[1-9]\d{0,18}$/;
  const email = value.email.trim().toLowerCase();
  let people = false;
  let signerOwnSign = false;
  try {
    const packet = JSON.parse(value.body);
    people = Object.keys(packet).length === 1 && packet.input?.action === 'people';
    signerOwnSign =
      Object.keys(packet).length === 1 &&
      packet.input &&
      Object.keys(packet.input).sort().join(',') === 'action,signer_token' &&
      packet.input.action === 'signer-own-sign' &&
      /^v3\.[A-Za-z0-9_-]{39,1021}$/.test(packet.input.signer_token);
  } catch {
    /* Invalid bodies retain the smaller limit. */
  }
  if (
    ![VN_ADMISSION_PATH, VN_ADMISSION_DOCUMENT_PATH, VN_ADMISSION_SELFIE_PATH].includes(path) ||
    !id.test(value.organizationId) ||
    !id.test(value.issuerOrgId) ||
    !id.test(value.userId) ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email) ||
    email.length > 254 ||
    !(signerOwnSign ? value.referral === '' : /^v3\.[A-Za-z0-9_-]{39,1021}$/.test(value.referral)) ||
    Buffer.byteLength(value.body) > (people ? 65536 : 16384) ||
    !/^[1-9]\d{0,11}$/.test(issuedAt) ||
    Buffer.byteLength(key) < 32
  )
    throw new Error('Invalid admission');
  const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  const payload = JSON.stringify([
    'destiny-vn-admission-v1',
    'POST',
    path,
    value.organizationId,
    value.issuerOrgId,
    value.userId,
    email,
    issuedAt,
    hash(value.referral),
    hash(value.body),
  ]);
  return {
    'x-gct-admission-issuer-org': value.issuerOrgId,
    'x-gct-admission-user': value.userId,
    'x-admission-email': email,
    'x-gct-admission-issued-at': issuedAt,
    'x-admission-signature': createHmac('sha256', key).update(payload, 'utf8').digest('hex'),
  };
}

export function parseVnAdmissionConfig(value: string | undefined, organizationId: string) {
  try {
    const parsed = JSON.parse(value ?? 'null');
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'hmacSecret,issuerOrgId' ||
      parsed.issuerOrgId !== organizationId ||
      !/^[1-9]\d{0,18}$/.test(parsed.issuerOrgId) ||
      typeof parsed.hmacSecret !== 'string' ||
      Buffer.byteLength(parsed.hmacSecret) < 32
    )
      return null;
    return { issuerOrgId: parsed.issuerOrgId as string, hmacSecret: parsed.hmacSecret as string };
  } catch {
    return null;
  }
}

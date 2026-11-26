import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import {
  signerRecipientKey,
  signerEligibilityHeaders,
  signerRecheckSignature,
} from '../../../../src/modules/dealer-onboarding/vn-signer.ts';

test('signer commitments and private request signatures have separate domains', () => {
  const secret = 's'.repeat(40),
    jti = 'j'.repeat(43),
    issued = '123456',
    nonce = 'b'.repeat(32);
  const mac = (parts) => createHmac('sha256', secret).update(JSON.stringify(parts)).digest('hex');
  const digest = (body) => createHash('sha256').update(body).digest('hex');
  assert.equal(
    signerRecipientKey(secret, '55', 'client', jti),
    mac(['vn_delegated_agreement_signer_recipient_v1', '55', 'client', jti])
  );
  const body = JSON.stringify({
    signer_token: 'opaque',
    recipient_commitment_key: 'a'.repeat(64),
  });
  const headers = signerEligibilityHeaders('55', body, secret, issued, nonce);
  assert.equal(
    headers['x-signer-eligibility-signature'],
    mac([
      'destiny-vn-signer-eligibility-v1',
      'POST',
      '/v1/channel-partners/intakes/signer-eligibility',
      '55',
      issued,
      nonce,
      digest(body),
    ])
  );
  assert.equal(headers['x-gct-signer-issuer-org'], '55');
  const recheck = JSON.stringify({
    jti,
    client_id: 'client',
    organization_id: '55',
    recipient_commitment: 'a'.repeat(64),
  });
  assert.equal(
    signerRecheckSignature(secret, '55', issued, recheck),
    mac([
      'thor-vn-signer-recheck-v1',
      'POST',
      '/api/dealer-onboarding/vn/signer/recheck',
      '55',
      issued,
      digest(recheck),
    ])
  );
});

test('signer admission signs an empty referral only for the exact own-sign body', async () => {
  const { vnAdmissionHeaders } = await import('../../../../src/modules/dealer-onboarding/admission.ts');
  const secret = 's'.repeat(40), token = 'v3.' + 'a'.repeat(39);
  const body = JSON.stringify({ input: { action: 'signer-own-sign', signer_token: token } });
  const value = { organizationId: '55', issuerOrgId: '55', userId: '2', email: 'signer@example.test', referral: '', body };
  const hash = (v) => createHash('sha256').update(v).digest('hex');
  const expected = createHmac('sha256', secret).update(JSON.stringify(['destiny-vn-admission-v1', 'POST', '/v1/channel-partners/intakes/admission', '55', '55', '2', value.email, '123456', hash(''), hash(body)])).digest('hex');
  assert.equal(vnAdmissionHeaders(value, secret, '123456')['x-admission-signature'], expected);
  assert.throws(() => vnAdmissionHeaders({ ...value, body: JSON.stringify({ input: { action: 'resume' } }) }, secret, '123456'));
  assert.throws(() => vnAdmissionHeaders({ ...value, body: JSON.stringify({ input: { action: 'signer-own-sign', signer_token: token, extra: true } }) }, secret, '123456'));
});

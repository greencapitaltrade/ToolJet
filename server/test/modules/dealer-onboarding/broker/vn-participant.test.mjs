import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import {
  participantEligibilityHeaders,
  participantRecipientKey,
  participantRecheckSignature,
} from '../../../../src/modules/dealer-onboarding/vn-participant.ts';

test('participant eligibility is bound to body, issuer and nonce', () => {
  const body = JSON.stringify({ participant_token: 'opaque', recipient_commitment_key: 'a'.repeat(64) });
  const headers = participantEligibilityHeaders('55', body, 's'.repeat(40), '123456', 'b'.repeat(32));
  const digest = createHash('sha256').update(body).digest('hex');
  const message = JSON.stringify([
    'destiny-vn-participant-eligibility-v1',
    'POST',
    '/v1/channel-partners/intakes/participant-eligibility',
    '55',
    '123456',
    'b'.repeat(32),
    digest,
  ]);
  assert.equal(
    headers['x-participant-eligibility-signature'],
    createHmac('sha256', 's'.repeat(40)).update(message).digest('hex')
  );
  assert.equal(headers['x-gct-org-id'], '55');
  assert.equal(headers['x-gct-participant-signature'], undefined);
  assert.throws(() => participantEligibilityHeaders('55', body, 's'.repeat(40), '123456', 'bad'));
});

test('recipient derivation and recheck bind exact fields and body', () => {
  const secret = 'x'.repeat(40);
  const jti = 'j'.repeat(43);
  const expected = createHmac('sha256', secret)
    .update(JSON.stringify(['vn_delegated_person_recipient_v1', '55', 'client', jti]))
    .digest('hex');
  assert.equal(participantRecipientKey(secret, '55', 'client', jti), expected);
  const body = JSON.stringify({
    jti,
    client_id: 'client',
    organization_id: '55',
    recipient_commitment: 'a'.repeat(64),
  });
  const message = JSON.stringify([
    'thor-vn-participant-recheck-v1',
    'POST',
    '/api/dealer-onboarding/vn/participant/recheck',
    '55',
    '123456',
    createHash('sha256').update(body).digest('hex'),
  ]);
  assert.equal(
    participantRecheckSignature(secret, '55', '123456', body),
    createHmac('sha256', secret).update(message).digest('hex')
  );
});

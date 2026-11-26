import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vnAdmissionHeaders } from '../../../../src/modules/dealer-onboarding/admission.ts';
test('matches the Destiny admission vector', () => {
  const referral = `v3.${'a'.repeat(45)}`;
  const body = JSON.stringify({ input: { referral_token: referral, pan: 'ABCDE1234F' } });
  const headers = vnAdmissionHeaders(
    { organizationId: '9', issuerOrgId: '7', userId: '42', email: ' Person@Example.com ', referral, body },
    'test-key-'.repeat(5),
    '1700000000'
  );
  assert.equal(headers['x-admission-signature'], 'd095e942ec38514b32eec33d107a19dabb3cccf312dd5a80d602af5f7a0b85f5');
});
test('signs large people bodies only within the 64 KiB bound', () => {
  const referral = `v3.${'a'.repeat(45)}`,
    base = { organizationId: '9', issuerOrgId: '7', userId: '42', email: 'person@example.com', referral };
  const body = (action) =>
    JSON.stringify({
      input: {
        action,
        referral_token: referral,
        operation: 'save',
        input: { people: Array(30).fill({ name: '界'.repeat(255) }) },
      },
    });
  assert.ok(Buffer.byteLength(body('people')) > 16384);
  assert.match(
    vnAdmissionHeaders({ ...base, body: body('people') }, 'test-key-'.repeat(5), '1700000000')['x-admission-signature'],
    /^[a-f0-9]{64}$/
  );
  for (const action of ['resume', 'financial', 'unknown'])
    assert.throws(() => vnAdmissionHeaders({ ...base, body: body(action) }, 'test-key-'.repeat(5), '1700000000'));
  assert.throws(() =>
    vnAdmissionHeaders(
      { ...base, body: JSON.stringify({ input: { action: 'people', padding: 'x'.repeat(65536) } }) },
      'test-key-'.repeat(5),
      '1700000000'
    )
  );
});
test('keeps admission proof private and retains trusted mesh identity headers', () => {
  const headers = vnAdmissionHeaders(
    {
      organizationId: '9',
      issuerOrgId: '7',
      userId: '42',
      email: 'person@example.com',
      referral: `v3.${'a'.repeat(45)}`,
      body: '{}',
    },
    'test-key-'.repeat(5),
    '1700000000'
  );
  assert.equal(headers['x-admission-email'], 'person@example.com');
  assert.match(headers['x-admission-signature'], /^[a-f0-9]{64}$/);
  assert.equal(headers['x-gct-admission-email'], undefined);
  assert.equal(headers['x-gct-admission-signature'], undefined);
  assert.equal(headers['x-gct-admission-issuer-org'], '7');
  assert.equal(headers['x-gct-admission-user'], '42');
  assert.equal(headers['x-gct-admission-issued-at'], '1700000000');
});

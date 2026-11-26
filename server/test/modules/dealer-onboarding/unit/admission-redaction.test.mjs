import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTraceObject } from '../../../../src/otel/sanitize.ts';

test('redacts both current and legacy admission proof fields recursively', () => {
  assert.deepEqual(
    sanitizeTraceObject({
      nested: {
        'x-admission-email': 'synthetic@example.test',
        'x-admission-signature': 'synthetic-proof',
        'x-admission-metadata': 'synthetic-metadata',
        'x-gct-admission-email': 'synthetic@example.test',
        'x-gct-admission-signature': 'synthetic-proof',
      },
    }),
    {
      nested: {
        'x-admission-email': '[REDACTED]',
        'x-admission-signature': '[REDACTED]',
        'x-admission-metadata': '[REDACTED]',
        'x-gct-admission-email': '[REDACTED]',
        'x-gct-admission-signature': '[REDACTED]',
      },
    }
  );
});

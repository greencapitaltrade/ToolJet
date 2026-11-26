import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticipantIntentStore } from '../../../../src/modules/dealer-onboarding/vn-participant.ts';

test('participant intent binds token and commitment to guest and expires', async () => {
  const values = new Map();
  const redis = {
    call: async (command, key, value, ...rest) => {
      if (command === 'SET') {
        values.set(key, value);
        assert.deepEqual(rest, ['EX', '600', 'NX']);
        return 'OK';
      }
      if (command === 'GET') return values.get(key);
    },
  };
  const store = new ParticipantIntentStore(redis, '55', 's'.repeat(40));
  await store.put('a'.repeat(43), 'b'.repeat(43), 'v3.' + 'c'.repeat(39), 'd'.repeat(64));
  assert.deepEqual(await store.get('a'.repeat(43)), {
    guest: 'b'.repeat(43),
    token: 'v3.' + 'c'.repeat(39),
    commitment: 'd'.repeat(64),
  });
  await assert.rejects(store.put('bad', 'b'.repeat(43), 'token', 'd'.repeat(64)));
});

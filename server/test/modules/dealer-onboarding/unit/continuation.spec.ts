/** @group platform */
import { DealerContinuation } from '../../../../src/modules/dealer-onboarding/continuation';

const scope = {
  origin: 'https://dealer.example',
  organizationId: '39',
  furyUrl: 'https://fury.example/v2/graphql',
  lspSecret: 'synthetic-secret-for-tests',
};
const guest = 'g'.repeat(43);
const referral = `v3.${'r'.repeat(45)}`;
const device = 'device-web';
const token = (claims: Record<string, unknown> = {}) =>
  `header.${Buffer.from(JSON.stringify({ user_id: 21, org_id: 7, app: 'voltcred', email: 'dealer@example.test', device, exp: Math.floor(Date.now() / 1000) + 600, ...claims })).toString('base64url')}.signature`;

function setup() {
  const values = new Map<string, string>();
  const redis = {
    async call(command: string, ...args: string[]) {
      if (command === 'SET') {
        if (values.has(args[0])) return null;
        values.set(args[0], args[1]);
        return 'OK';
      }
      if (command === 'GET') return values.get(args[0]) ?? null;
      if (command === 'EVAL' && args[0].includes('CONTINUATION_ARM')) {
        if (values.get(args[2]) !== args[4] || values.has(args[3])) return 0;
        values.set(args[2], 'armed');
        values.set(args[3], args[5]);
        return 1;
      }
      if (command === 'EVAL' && args[0].includes('CONTINUATION_CONSUME')) {
        const value = values.get(args[2]);
        if (!value || JSON.parse(value).guest !== args[3]) return null;
        values.delete(args[2]);
        return value;
      }
      throw new Error(command);
    },
  };
  return { store: new DealerContinuation(redis), values };
}

test('one-time receipt is bound to original guest and scope', async () => {
  const { store, values } = setup();
  const state = await store.start(scope, guest, referral);
  expect(state).toMatch(/^[\w-]{43}$/);
  const code = await store.receive(scope, state, { token: token(), device, user_id: '21' }, '7');
  expect(code).toMatch(/^[\w-]{43}$/);
  expect(JSON.stringify([...values.keys()])).not.toContain(guest);
  expect(JSON.stringify([...values.values()])).not.toContain('header.');
  await expect(store.receive(scope, state, { token: token(), device, user_id: '21' }, '7')).rejects.toThrow();
  await expect(store.consume(scope, 'x'.repeat(43), code)).rejects.toThrow();
  await expect(store.consume({ ...scope, organizationId: '40' }, guest, code)).rejects.toThrow();
  const receipt = await store.consume(scope, guest, code);
  expect(receipt).toMatchObject({ referral, userId: '21', actorOrgId: '7' });
  expect(receipt.email).toBe('dealer@example.test');
  expect(receipt).not.toHaveProperty('token');
  await expect(store.consume(scope, guest, code)).rejects.toThrow();
});

test.each([
  [{ app: 'other' }, '21', '7'],
  [{ org_id: 39 }, '21', '7'],
  [{ user_id: 22 }, '21', '7'],
  [{ device: 'other' }, '21', '7'],
  [{ exp: 1 }, '21', '7'],
  [{}, '021', '7'],
  [{}, '21', '07'],
  [{ email: '' }, '21', '7'],
  [{ email: 'invalid' }, '21', '7'],
])('rejects mismatched actor claims %#', async (claims, userId, orgId) => {
  const { store } = setup();
  const state = await store.start(scope, guest, referral);
  await expect(store.receive(scope, state, { token: token(claims), device, user_id: userId }, orgId)).rejects.toThrow();
});

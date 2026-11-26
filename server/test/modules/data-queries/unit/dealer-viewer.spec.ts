import { dealerViewerActor, dealerViewerConfig } from '../../../../src/modules/data-queries/dealer-viewer';

const config = JSON.stringify({ sourceId: 'source', appId: 'app', queryIds: ['query'], origin: 'https://dealer.example', organizationId: '18' });
const binding = { sourceId: 'source', appId: 'app', appVersionId: 'version', currentVersionId: 'version', queryId: 'query', isPublic: true, origin: 'https://dealer.example', site: 'same-origin', cookie: 'a'.repeat(43) };
const actor = { userId: '42', organizationId: '18', email: 'owner@example.com', emailVerified: true, referral: `${'a'.repeat(50)}` };

describe('dealer viewer actor boundary', () => {
  it('binds the Redis key to the source without using the legacy Fury secret', () => {
    const secret = 's'.repeat(32);
    expect(dealerViewerConfig(config, secret).lspSecret).not.toEqual(
      dealerViewerConfig(JSON.stringify({ ...JSON.parse(config), sourceId: 'other' }), secret).lspSecret
    );
  });
  it('returns only a verified actor from the scoped store for the exact released query', async () => {
    expect(await dealerViewerActor(config, 's'.repeat(32), binding, async () => actor)).toEqual({ userId: '42', organizationId: '18', referral: actor.referral, email: actor.email });
  });
  it.each([
    { ...binding, appId: 'other' }, { ...binding, queryId: 'other' }, { ...binding, appVersionId: 'draft' },
    { ...binding, isPublic: false }, { ...binding, origin: 'https://evil.example' }, { ...binding, site: 'cross-site' },
    { ...binding, cookie: undefined },
  ])('rejects an invalid binding', async (input) => {
    await expect(dealerViewerActor(config, 's'.repeat(32), input, async () => actor)).rejects.toThrow();
  });
  it.each([null, { ...actor, emailVerified: false }, { ...actor, organizationId: '19' }, { ...actor, userId: '0' }])('rejects invalid stored actors', async (value) => {
    await expect(dealerViewerActor(config, 's'.repeat(32), binding, async () => value)).rejects.toThrow();
  });
});

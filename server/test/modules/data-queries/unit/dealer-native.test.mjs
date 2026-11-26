import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dealerViewerActor, bindDealerReferral, dealerViewerHeaders } from '../../../../src/modules/data-queries/dealer-viewer.ts';

const referral = `${'a'.repeat(50)}`;
const actor = { userId: '42', organizationId: '18', referral, email: 'owner@example.com' };
const base = { method: 'post', url: '/v1/channel-partners/intakes/lookup', body_toggle: true, body: [], raw_body: JSON.stringify({ input: { pan: 'ABCDE1234F' } }) };
test('binds the server referral to native lookup', () => {
  const result = bindDealerReferral(base, base, actor);
  assert.deepEqual(JSON.parse(result.raw_body), { input: { pan: 'ABCDE1234F', referral_token: referral } });
  assert.equal(result.body_toggle, true);
});
test('rejects forged input and alternate transport controls', () => {
  for (const change of [
    { raw_body: JSON.stringify({ input: { referral_token: 'forged' } }) },
    { raw_body: JSON.stringify({ input: { parent_id: 'forged' } }) },
    { raw_body: JSON.stringify({ input: { referralToken: 'forged' } }) },
    { raw_body: JSON.stringify({ input: { user_id: 'forged' } }) },
    { raw_body: JSON.stringify({ input: {}, extra: 1 }) },
    { raw_body: '{}' }, { raw_body: 'not json' }, { body_toggle: false },
    { body: [['input', 'forged']] }, { json_body: '{"input":{}}' },
  ]) assert.throws(() => bindDealerReferral(base, { ...base, ...change }, actor));
});
test('does not rewrite other routes', () => {
  const other = { ...base, url: '/v1/channel-partners/financial-data' };
  assert.equal(bindDealerReferral(other, other, actor), other);
});
test('requires a valid stored referral with the verified actor', async () => {
  const config = JSON.stringify({ sourceId: 'source', appId: 'app', queryIds: ['query'], origin: 'https://dealer.example', organizationId: '18' });
  const binding = { sourceId: 'source', appId: 'app', appVersionId: 'version', currentVersionId: 'version', queryId: 'query', isPublic: true, origin: 'https://dealer.example', cookie: 'a'.repeat(43) };
  const verified = { ...actor, email: 'owner@example.com', emailVerified: true };
  assert.deepEqual(await dealerViewerActor(config, 's'.repeat(32), binding, async () => verified), actor);
  await assert.rejects(dealerViewerActor(config, 's'.repeat(32), binding, async () => ({ ...verified, referral: 'bad' })));
});

test('removes public viewer identity headers while retaining service headers', () => {
  assert.deepEqual(dealerViewerHeaders([['X-GCT-Phone', 'forged'], ['x-Gct-User-Id', 'forged'], ['Authorization', 'forged'], ['Cookie', 'forged'], ['X-Forwarded-For', 'forged'], ['api-secret', 'service']]), [['api-secret', 'service']]);
});

test('builds native start dossier from verified owner and referral', () => {
  for (const [pan, firmType, role] of [['AAAPA1234A', undefined, 'Proprietor'], ['AAACA1234A', undefined, 'Director'], ['AAAFA1234A', 'llp', 'Partner']]) {
    const start = { ...base, url: '/v1/channel-partners/intakes', raw_body: JSON.stringify({ input: { pan, businessName: 'Example', applicantName: 'Owner', ...(firmType && { firmType }) } }) };
    const { input } = JSON.parse(bindDealerReferral(start, start, actor).raw_body);
    assert.deepEqual(input, { referral_token: referral, dossier: { details: { pan, partner_name: 'Example', email: actor.email, ...(firmType && { firm_type: firmType }) }, people: [{ id: 'person1', user_id: actor.userId, name: 'Owner', role, kyc_contact: actor.email }] } });
  }
});
test('rejects forged authority, invalid entity and unexpected start fields', () => {
  const valid = { pan: 'AAAPA1234A', businessName: 'Example', applicantName: 'Owner' };
  const start = { ...base, url: '/v1/channel-partners/intakes' };
  for (const input of [
    { ...valid, user_id: '7' }, { ...valid, dossier: {} }, { ...valid, parent_id: '7' },
    { ...valid, firmType: 'llp' }, { ...valid, pan: 'AAAFA1234A' },
    { ...valid, pan: 'AAAFA1234A', firmType: 'other' }, { ...valid, pan: 'bad' },
    { ...valid, applicantName: '' },
  ]) assert.throws(() => bindDealerReferral(start, { ...start, raw_body: JSON.stringify({ input }) }, actor));
});

test('participant claim requires the configured query and server binds both tokens', async () => {
  const token = `${'b'.repeat(50)}`;
  const config = JSON.stringify({ sourceId: 'source', appId: 'app', queryIds: ['owner', 'claim'], participantClaimQueryId: 'claim', origin: 'https://dealer.example', organizationId: '18' });
  const binding = { sourceId: 'source', appId: 'app', appVersionId: 'version', currentVersionId: 'version', queryId: 'claim', isPublic: true, origin: 'https://dealer.example', cookie: 'a'.repeat(43) };
  const stored = { ...actor, emailVerified: true, personToken: token };
  const participant = await dealerViewerActor(config, 's'.repeat(32), binding, async () => stored);
  const other = await dealerViewerActor(config, 's'.repeat(32), { ...binding, queryId: 'owner' }, async () => stored);
  assert.throws(() => bindDealerReferral(base, base, other));
  const claim = { ...base, url: '/v1/channel-partners/named-person-consent-handoffs/claim', raw_body: '{"input":{}}' };
  assert.deepEqual(JSON.parse(bindDealerReferral(claim, claim, participant).raw_body), { input: { referral_token: referral, token } });
  assert.throws(() => bindDealerReferral(base, base, participant));
  const receipt = { ...base, method: 'get', url: '/v1/channel-partners/person-consents/{{parameters.consentId}}' };
  assert.throws(() => bindDealerReferral(receipt, receipt, participant));
  assert.throws(() => bindDealerReferral(claim, { ...claim, raw_body: '{"input":{"token":"forged"}}' }, participant));
});


test('owner issue binds only a named slot and held referral', () => {
  const issue = { ...base, url: '/v1/channel-partners/intakes/{{parameters.draftId}}/person-consent-handoffs', raw_body: '{"input":{"slot_id":"person2"}}' };
  assert.deepEqual(JSON.parse(bindDealerReferral(issue, issue, actor).raw_body), { input: { slot_id: 'person2', referral_token: referral } });
  for (const input of [{ mobile: '123' }, { slot_id: 'p', referral_token: 'x' }, { slot_id: 1 }, { slot_id: '' }, { slot_id: 'p', extra: 1 }])
    assert.throws(() => bindDealerReferral(issue, { ...issue, raw_body: JSON.stringify({ input }) }, actor));
});

test('participant permits only pinned native person contracts and strict selfie body', async () => {
  const token = `${'b'.repeat(50)}`;
  const config = JSON.stringify({ sourceId: 'source', appId: 'app', queryIds: ['claim', 'person'], participantClaimQueryId: 'claim', origin: 'https://dealer.example', organizationId: '18' });
  const binding = { sourceId: 'source', appId: 'app', appVersionId: 'version', currentVersionId: 'version', queryId: 'person', isPublic: true, origin: 'https://dealer.example', cookie: 'a'.repeat(43) };
  const participant = await dealerViewerActor(config, 's'.repeat(32), binding, async () => ({ ...actor, emailVerified: true, personToken: token }));
  for (const [method, url] of [['get', '/v1/channel-partners/person-consents/{{parameters.consentId}}'], ['post', '/v1/channel-partners/intakes/{{parameters.draftId}}/people/{{parameters.personId}}/kyc/start'], ['post', '/v1/channel-partners/intakes/{{parameters.draftId}}/people/{{parameters.personId}}/kyc/sync']]) {
    const query = { ...base, method, url, ...(method === 'post' ? { raw_body: '{"input":{}}' } : {}) };
    assert.equal(bindDealerReferral(query, query, participant), query);
  }
  const selfie = { ...base, url: '/v1/channel-partners/person-consents/{{parameters.consentId}}/selfie', raw_body: '{"input":{"selfie":"data:image/jpeg;base64,/9j/AP/Z"}}' };
  assert.deepEqual(JSON.parse(bindDealerReferral(selfie, selfie, participant).raw_body), { input: { selfie: 'data:image/jpeg;base64,/9j/AP/Z', referral_token: referral } });
  for (const input of [{ selfie: 'x', referral_token: 'forged' }, { selfie: 2 }, { selfie: 'x', extra: 1 }, ...['/9j/AP/Z', 'data:image/jpeg;base64,/9j/AAAA', 'data:image/jpeg;base64,/9j/AP/Z=', 'data:image/jpeg;base64,' + 'A'.repeat(128 * 1024 + 1)].map(selfie => ({ selfie }))]) assert.throws(() => bindDealerReferral(selfie, { ...selfie, raw_body: JSON.stringify({ input }) }, participant));
  for (const query of [{ ...base }, { ...base, method: 'get', url: '/v1/channel-partners/person-consents/{{parameters.other}}' }, { ...base, url: '/v1/channel-partners/named-person-consent-handoffs/claim' }]) assert.throws(() => bindDealerReferral(query, query, participant));
  await assert.rejects(dealerViewerActor(config, 's'.repeat(32), { ...binding, queryId: 'unlisted' }, async () => ({ ...actor, emailVerified: true, personToken: token })));
});

test('signing binds the held referral for owner and claimed participant with only version', () => {
  const sign = { ...base, url: '/v1/channel-partners/intakes/{{parameters.draftId}}/agreement/own-sign', raw_body: '{"input":{"version":3}}' };
  for (const who of [actor, { ...actor, personToken: 'b'.repeat(50), participantClaim: false }]) {
    assert.deepEqual(JSON.parse(bindDealerReferral(sign, sign, who).raw_body), { input: { version: 3, referral_token: referral } });
    for (const input of [{ version: 3, person_id: '7' }, { version: 3, referral_token: 'forged' }, { version: 0 }, { version: '3' }, {}])
      assert.throws(() => bindDealerReferral(sign, { ...sign, raw_body: JSON.stringify({ input }) }, who));
  }
  const participant = { ...actor, personToken: 'b'.repeat(50), participantClaim: false };
  for (const query of [{ ...sign, method: 'get' }, { ...sign, url: sign.url.replace('own-sign', 'sign') }, { ...sign, url: sign.url.replace('draftId', 'other') }]) assert.throws(() => bindDealerReferral(query, query, participant));
});

test('completion is owner-only and accepts the exact advertised action packet', () => {
  const completion = { ...base, url: '/v1/channel-partners/intakes/{{parameters.draftId}}/referral-completion' };
  for (const input of [{ action: 'STATUS' }, ...['FREEZE', 'REFRESH', 'VERIFY_BANK', 'SUBMIT'].map(action => ({ action, version: 3 }))]) {
    const query = { ...completion, raw_body: JSON.stringify({ input }) };
    assert.deepEqual(JSON.parse(bindDealerReferral(query, query, actor).raw_body), { input: { ...input, referral_token: referral } });
    assert.throws(() => bindDealerReferral(query, query, { ...actor, personToken: 'b'.repeat(50), participantClaim: false }));
  }
  for (const input of [{ action: 'STATUS', version: 3 }, { action: 'FREEZE' }, { action: 'FREEZE', version: 0 }, { action: 'FREEZE', version: 3, actor: '7' }, { action: 'OTHER', version: 3 }])
    assert.throws(() => bindDealerReferral(completion, { ...completion, raw_body: JSON.stringify({ input }) }, actor));
});

test('owner KYC injects held referral only into versioned owner packets', () => {
  const path = '/v1/channel-partners/intakes/{{parameters.draftId}}/people/{{parameters.personId}}/kyc/';
  const participant = { ...actor, personToken: 'b'.repeat(50), participantClaim: false };
  for (const action of ['start', 'sync', 'selfie']) {
    const saved = { ...base, url: path + action, raw_body: '{{parameters.requestBody}}' };
    const input = { version: 3, ...(action === 'selfie' ? { selfie: 'data:image/jpeg;base64,/9j/AP/Z' } : {}) };
    const parsed = { ...saved, raw_body: JSON.stringify({ input }) };
    assert.deepEqual(JSON.parse(bindDealerReferral(saved, parsed, actor).raw_body), { input: { ...input, referral_token: referral } });
    assert.throws(() => bindDealerReferral(saved, parsed, participant));
    for (const bad of [{ ...input, referral_token: 'x' }, { ...input, version: 0 }, { ...input, extra: 1 }, ...(action === 'selfie' ? [{ version: 3, selfie: '/9j/AP/Z' }] : [])])
      assert.throws(() => bindDealerReferral(saved, { ...parsed, raw_body: JSON.stringify({ input: bad }) }, actor));
  }
  const director = { ...base, url: path + 'start', raw_body: '{"input":{}}' };
  assert.throws(() => bindDealerReferral(director, director, actor));
  assert.throws(() => bindDealerReferral(director, { ...director, raw_body: '{"input":{"version":3}}' }, participant));
  const receipt = { ...base, url: '/v1/channel-partners/person-consents/{{parameters.consentId}}/selfie', raw_body: '{"input":{"selfie":"x"}}' };
  assert.throws(() => bindDealerReferral(receipt, receipt, actor));
  const receiptGet = { ...receipt, method: 'get', url: '/v1/channel-partners/person-consents/{{parameters.consentId}}' };
  assert.throws(() => bindDealerReferral(receiptGet, receiptGet, actor));
});

 test('owner dossier binds only exact action envelopes and rejects participant and forged fields', () => {
  const saved = { ...base, url: '/v1/channel-partners/intakes/{{parameters.draftId}}/referral-dossier', raw_body: '{{parameters.requestBody}}' };
  const participant = { ...actor, personToken: 'b'.repeat(50), participantClaim: false };
  for (const input of [{ action: 'STATUS' }, { action: 'SAVE_HISTORY', version: 3, fields: { bank: { from: 'a', to: 'b' } } }, { action: 'SAVE_OWN_DIN', version: 3, fields: { din: '12345678' } }, { action: 'SAVE_EXECUTION', version: 3, fields: Object.fromEntries(['legal_name', 'registered_address', 'additional_address', 'signatory_name', 'signatory_designation', 'bank_account_holder', 'bank_name', 'bank_account_number', 'confirm_account_number', 'bank_ifsc', 'approved_outlets'].map(key => [key, 'value'])) }]) {
    const parsed = { ...saved, raw_body: JSON.stringify({ input }) };
    assert.deepEqual(JSON.parse(bindDealerReferral(saved, parsed, actor).raw_body), { input: { ...input, referral_token: referral } });
    assert.throws(() => bindDealerReferral(saved, parsed, participant));
  }
  for (const input of [{ action: 'STATUS', version: 3 }, { action: 'SAVE_HISTORY', version: 0, fields: {} }, { action: 'SAVE_HISTORY', version: 3 }, { action: 'SAVE_HISTORY', version: 3, fields: [] }, { action: 'SAVE_HISTORY', version: 3, fields: { actor: 'x' } }, { action: 'SAVE_HISTORY', version: 3, fields: { bank: { referral_token: 'x' } } }, { action: 'OTHER', version: 3, fields: {} }, { action: 'STATUS', actor: 'x' }])
    assert.throws(() => bindDealerReferral(saved, { ...saved, raw_body: JSON.stringify({ input }) }, actor));
  for (const query of [{ ...saved, method: 'get' }, { ...saved, url: saved.url.replace('draftId', 'other') }, { ...saved, url: saved.url.replace('referral-dossier', 'Referral-dossier') }]) assert.throws(() => bindDealerReferral(query, query, participant));
});

// Set both paths to mounted source files to verify the complete widget-to-Destiny wire contract.
test('director selfie wire packet passes the actual Destiny JPEG parser', { skip: !process.env.DESTINY_JPEG_MODULE || !process.env.DIRECTOR_WIDGET_MODULE }, async () => {
  const require = createRequire(import.meta.url);
  const { parseJpegDataUrl } = require(process.env.DESTINY_JPEG_MODULE);
  const { createDirector } = require(process.env.DIRECTOR_WIDGET_MODULE);
  const participant = { ...actor, personToken: 'b'.repeat(50), participantClaim: false };
  const saved = { ...base, url: '/v1/channel-partners/person-consents/{{parameters.consentId}}/selfie', raw_body: '{{parameters.requestBody}}' };
  const receipt = { id: '12345678-1234-1234-1234-123456789abc', status: 'accepted', draft_id: 'abcdefab-1234-1234-1234-123456789abc', person_id: '702', version: 2, kyc: { status: 'pending' }, selfie_available: true };
  let wire;
  const widget = createDirector({ runQuery: async (name, params) => {
    if (name === 'dealerPersonSelfie') wire = JSON.parse(bindDealerReferral(saved, { ...saved, raw_body: params.requestBody }, participant).raw_body);
    return { status: 'ok', data: receipt };
  } }, []);
  await widget.selfie(receipt, '/9j/AP/Z');
  assert.equal(wire.input.referral_token, referral);
  assert.equal(parseJpegDataUrl(wire.input.selfie), '/9j/AP/Z');
});

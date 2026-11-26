import { createHmac } from 'node:crypto';
import type { ApplicantSessionScope } from '../applicant-session/store';

export const DEALER_VIEWER_ENV = 'TOOLJET_DEALER_VIEWER';
export const DEALER_VIEWER_COOKIE = '__Host-tj-dealer-viewer';
type Binding = { sourceId: string; appId: string; appVersionId: string; currentVersionId: string; queryId: string; isPublic: boolean; origin?: string; site?: string; cookie?: string };
type Config = ApplicantSessionScope & { sourceId: string; appId: string; queryIds: string[]; participantClaimQueryId?: string };
type Actor = { userId?: unknown; organizationId?: unknown; email?: unknown; emailVerified?: unknown; referral?: unknown; personToken?: unknown };

export function dealerViewerConfig(raw?: string, secret?: string): Config | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const origin = new URL(value.origin);
    if (!secret || secret.length < 32 || origin.protocol !== 'https:' || origin.origin !== value.origin ||
      typeof value.organizationId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.organizationId) || typeof value.sourceId !== 'string' || !value.sourceId || typeof value.appId !== 'string' || !value.appId ||
      !Array.isArray(value.queryIds) || !value.queryIds.length || !value.queryIds.every((id: unknown) => typeof id === 'string' && id)) throw new Error();
    if (value.participantClaimQueryId !== undefined && (typeof value.participantClaimQueryId !== 'string' || !value.queryIds.includes(value.participantClaimQueryId))) throw new Error();
    const lspSecret = createHmac('sha256', secret).update('tooljet-dealer-viewer-session-v1\0').update(value.sourceId).digest('hex');
    return { origin: value.origin, organizationId: value.organizationId, lspSecret, sourceId: value.sourceId, appId: value.appId, queryIds: value.queryIds, participantClaimQueryId: value.participantClaimQueryId };
  } catch { throw new Error('Invalid dealer viewer configuration'); }
}

/** Caller supplies the persisted query and app, never browser-supplied binding IDs. */
export async function dealerViewerActor(raw: string, secret: string, binding: Binding, load: (scope: ApplicantSessionScope, id: string) => Promise<Actor | null>) {
  const config = dealerViewerConfig(raw, secret);
  if (!config || binding.sourceId !== config.sourceId || binding.appId !== config.appId || !binding.isPublic ||
    !binding.currentVersionId || binding.appVersionId !== binding.currentVersionId || !config.queryIds.includes(binding.queryId) ||
    binding.origin !== config.origin || (binding.site !== undefined && binding.site !== 'same-origin') ||
    !binding.cookie || !/^[A-Za-z0-9_-]{43}$/.test(binding.cookie)) throw new Error('Dealer viewer unavailable');
  const actor = await load(config, binding.cookie);
  if (!actor || typeof actor.userId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(actor.userId) || (actor.userId.length === 19 && actor.userId > '9223372036854775807') ||
    actor.organizationId !== config.organizationId || actor.emailVerified !== true || typeof actor.email !== 'string' ||
    actor.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor.email) ||
    typeof actor.referral !== 'string' || !/^[A-Za-z0-9_-]{39,1021}$/.test(actor.referral)) throw new Error('Dealer viewer unavailable');
  if (actor.personToken !== undefined && (typeof actor.personToken !== 'string' || !/^[A-Za-z0-9_-]{39,1021}$/.test(actor.personToken))) throw new Error('Dealer viewer unavailable');
  if (actor.personToken === undefined && binding.queryId === config.participantClaimQueryId) throw new Error('Dealer viewer unavailable');
  return { userId: actor.userId, organizationId: config.organizationId, referral: actor.referral, email: actor.email, ...(typeof actor.personToken === 'string' ? { personToken: actor.personToken, participantClaim: binding.queryId === config.participantClaimQueryId } : {}) };
}


type NativeOptions = { method?: string; url?: string; body_toggle?: unknown; body?: unknown; raw_body?: unknown; json_body?: unknown };
const referralRoutes = new Set(['/v1/channel-partners/intakes/lookup', '/v1/channel-partners/intakes']);
const forbiddenInput = new Set(['referraltoken', 'parentid', 'userid', 'organizationid', 'orgid', 'actor', 'actorid', 'emailverified', 'personid', 'token']);

/** Apply only to the fixed saved native intake operations, after template resolution. */
export function bindDealerReferral<T extends NativeOptions>(saved: NativeOptions, parsed: T, actor: { referral: string; userId: string; email: string; personToken?: string; participantClaim?: boolean }): T {
  const claim = saved.method === 'post' && saved.url === '/v1/channel-partners/named-person-consent-handoffs/claim';
  const issue = saved.method === 'post' && saved.url === '/v1/channel-partners/intakes/{{parameters.draftId}}/person-consent-handoffs';
  const selfie = saved.method === 'post' && saved.url === '/v1/channel-partners/person-consents/{{parameters.consentId}}/selfie';
  const ownerKyc = saved.method === 'post' && /^\/v1\/channel-partners\/intakes\/\{\{parameters\.draftId\}\}\/people\/\{\{parameters\.personId\}\}\/kyc\/(start|sync|selfie)$/.test(saved.url ?? '');
  const ownerPacket = ownerKyc && saved.raw_body === '{{parameters.requestBody}}';
  const directorKyc = ownerKyc && saved.raw_body === '{"input":{}}' && !saved.url?.endsWith('/selfie');
  const sign = saved.method === 'post' && saved.url === '/v1/channel-partners/intakes/{{parameters.draftId}}/agreement/own-sign';
  const dossier = saved.method === 'post' && saved.url === '/v1/channel-partners/intakes/{{parameters.draftId}}/referral-dossier';
  const completion = saved.method === 'post' && saved.url === '/v1/channel-partners/intakes/{{parameters.draftId}}/referral-completion';
  const participantRoutes = new Set([
    'get /v1/channel-partners/person-consents/{{parameters.consentId}}',
    'post /v1/channel-partners/intakes/{{parameters.draftId}}/people/{{parameters.personId}}/kyc/start',
    'post /v1/channel-partners/intakes/{{parameters.draftId}}/people/{{parameters.personId}}/kyc/sync',
  ]);
  if (actor.personToken) {
    if (ownerKyc && !directorKyc) throw new Error('Invalid dealer participant query');
    if (directorKyc && (parsed.raw_body !== '{"input":{}}' || saved.body_toggle !== true || parsed.body_toggle !== true || !Array.isArray(saved.body) || saved.body.length || !Array.isArray(parsed.body) || parsed.body.length || saved.json_body !== undefined || parsed.json_body !== undefined)) throw new Error('Invalid dealer participant body');
    if (claim !== (actor.participantClaim === true) || (!claim && !selfie && !sign && !participantRoutes.has(`${saved.method} ${saved.url}`))) throw new Error('Invalid dealer participant query');
    if (!claim && !selfie && !sign) return parsed;
  } else if (claim || selfie || participantRoutes.has(`${saved.method} ${saved.url}`) && !ownerPacket || (ownerKyc && !ownerPacket)) throw new Error('Invalid dealer participant query');
  if (!claim && !issue && !selfie && !sign && !completion && !dossier && !ownerPacket && (saved.method !== 'post' || !referralRoutes.has(saved.url ?? ''))) return parsed;
  const validTransport = (options: NativeOptions) => options.body_toggle === true &&
    Array.isArray(options.body) && options.body.length === 0 && options.json_body === undefined;
  if (!validTransport(saved) || !validTransport(parsed) || typeof parsed.raw_body !== 'string') throw new Error('Invalid dealer intake body');
  let value: unknown;
  try { value = JSON.parse(parsed.raw_body); } catch { throw new Error('Invalid dealer intake body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, 'input')) throw new Error('Invalid dealer intake body');
  const input = (value as { input: unknown }).input;
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => forbiddenInput.has(key.toLowerCase().replace(/[_-]/g, '')))) throw new Error('Invalid dealer intake body');
  if (claim) {
    if (Object.keys(input).length !== 0) throw new Error('Invalid dealer participant body');
    return { ...parsed, raw_body: JSON.stringify({ input: { referral_token: actor.referral, token: actor.personToken } }) };
  }
  const validJpeg = (value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith('data:image/jpeg;base64,')) return false;
    const encoded = value.slice(23);
    if (encoded.length > 128 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    const bytes = Buffer.from(encoded, 'base64');
    return (
      bytes.length >= 5 &&
      bytes.toString('base64') === encoded &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255 &&
      bytes[bytes.length - 2] === 255 &&
      bytes[bytes.length - 1] === 217
    );
  };
  if (ownerPacket) {
    const packet = input as Record<string, unknown>;
    const isSelfie = saved.url?.endsWith('/selfie');
    if (!Number.isSafeInteger(packet.version) || (packet.version as number) < 1 || Object.keys(packet).length !== (isSelfie ? 2 : 1)) throw new Error('Invalid owner KYC body');
    if (isSelfie) {
      if (!validJpeg(packet.selfie)) throw new Error('Invalid owner KYC body');
    }
    return { ...parsed, raw_body: JSON.stringify({ input: { ...packet, referral_token: actor.referral } }) };
  }
  if (dossier) {
    const packet = input as Record<string, unknown>;
    const status = packet.action === 'STATUS';
    const fields = packet.fields;
    const noAuthority = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return true;
      if (Array.isArray(value)) return value.every(noAuthority);
      return Object.entries(value).every(([key, child]) => !forbiddenInput.has(key.toLowerCase().replace(/[_-]/g, '')) && noAuthority(child));
    };
    if (!['STATUS', 'SAVE_HISTORY', 'SAVE_OWN_DIN', 'SAVE_EXECUTION'].includes(packet.action as string) ||
      Object.keys(packet).length !== (status ? 1 : 3) || (!status && (!Number.isSafeInteger(packet.version) || (packet.version as number) < 1 ||
      !fields || typeof fields !== 'object' || Array.isArray(fields) || !noAuthority(fields)))) throw new Error('Invalid owner dossier body');
    if (!status) {
      const data = fields as Record<string, unknown>;
      const exactStrings = (value: unknown, required: string[], optional: string[] = []) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const row = value as Record<string, unknown>;
        return required.every((key) => Object.prototype.hasOwnProperty.call(row, key)) &&
          Object.entries(row).every(([key, item]) => [...required, ...optional].includes(key) && typeof item === 'string' && item.length <= 2000);
      };
      const executionKeys = ['legal_name', 'registered_address', 'additional_address', 'signatory_name', 'signatory_designation', 'bank_account_holder', 'bank_name', 'bank_account_number', 'confirm_account_number', 'bank_ifsc', 'approved_outlets'];
      const valid = packet.action === 'SAVE_OWN_DIN' ? exactStrings(data, ['din']) : packet.action === 'SAVE_EXECUTION' ?
        exactStrings(data, executionKeys, ['registration_details']) :
        Object.keys(data).length > 0 && Object.entries(data).every(([key, item]) =>
          key === 'bank' ? exactStrings(item, ['from', 'to'], ['opened_on']) : key === 'gst' && exactStrings(item, ['from', 'to'], ['registered_on']));
      if (!valid) throw new Error('Invalid owner dossier fields');
    }
    return { ...parsed, raw_body: JSON.stringify({ input: { ...packet, referral_token: actor.referral } }) };
  }
  if (sign || completion) {
    const packet = input as Record<string, unknown>;
    const status = completion && packet.action === 'STATUS';
    const validVersion = Number.isSafeInteger(packet.version) && (packet.version as number) >= 1;
    if (sign ? Object.keys(packet).length !== 1 || !validVersion :
      !['STATUS', 'PREPARE', 'FREEZE', 'REFRESH', 'VERIFY_BANK', 'SUBMIT'].includes(packet.action as string) ||
      Object.keys(packet).length !== (status ? 1 : 2) || (!status && !validVersion)) throw new Error('Invalid dealer signing body');
    return { ...parsed, raw_body: JSON.stringify({ input: { ...packet, referral_token: actor.referral } }) };
  }
  if (issue || selfie) {
    const packet = input as Record<string, unknown>;
    const key = issue ? 'slot_id' : 'selfie';
    if (Object.keys(packet).length !== 1 || typeof packet[key] !== 'string' || !(packet[key] as string).length || (selfie && !validJpeg(packet.selfie))) throw new Error('Invalid dealer intake body');
    return { ...parsed, raw_body: JSON.stringify({ input: { ...packet, referral_token: actor.referral } }) };
  }
  if (saved.url === '/v1/channel-partners/intakes') {
    const packet = input as Record<string, unknown>;
    const pan = typeof packet.pan === 'string' ? packet.pan.trim().toUpperCase() : '';
    const entity = pan[3];
    const keys = entity === 'F' ? ['pan', 'businessName', 'applicantName', 'firmType'] : ['pan', 'businessName', 'applicantName'];
    if (!/^[A-Z]{3}[CPF][A-Z][0-9]{4}[A-Z]$/.test(pan) || Object.keys(packet).length !== keys.length ||
      !keys.every((key) => Object.prototype.hasOwnProperty.call(packet, key)) ||
      ![packet.businessName, packet.applicantName].every((value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 255) ||
      (entity === 'F' && !['partnership', 'llp'].includes(packet.firmType as string))) throw new Error('Invalid dealer intake body');
    const details = { pan, partner_name: packet.businessName, email: actor.email,
      ...(entity === 'F' ? { firm_type: packet.firmType } : {}) };
    const person = { id: 'person1', user_id: actor.userId, name: packet.applicantName,
      role: entity === 'C' ? 'Director' : entity === 'P' ? 'Proprietor' : 'Partner', kyc_contact: actor.email };
    return { ...parsed, raw_body: JSON.stringify({ input: { dossier: { details, people: [person] }, referral_token: actor.referral } }) };
  }
  return { ...parsed, raw_body: JSON.stringify({ input: { ...input, referral_token: actor.referral } }) };
}

/** Strip caller-supplied identity for the public dealer source, including legacy phone headers. */
export function dealerViewerHeaders(headers: [string, unknown][] = []): [string, unknown][] {
  if (!Array.isArray(headers)) return [];
  return headers.filter((row) => {
    if (!Array.isArray(row) || typeof row[0] !== 'string') return false;
    const name = row[0].trim().toLowerCase();
    return !name.startsWith('x-gct-') && !name.startsWith('x-forwarded-') &&
      !['authorization', 'cookie', 'forwarded', 'x-real-ip', 'x-user-id', 'x-org-id', 'x-organization-id'].includes(name);
  });
}

import { privateServiceOrigin } from '@helpers/private-service-origin';
import { SessionUtilService } from '@modules/session/util.service';
import { getConfiguredOidcSettings, isHttpsUrl } from '@modules/auth/oauth/configured-oidc.config';
import {
  type OidcActorUser,
  positiveId,
  resolveThorActor,
  ThorActorError,
} from '@modules/auth/oauth/configured-oidc-workspace';
import type { RelayResult } from './staff-relay.service';

const readFields = ['partnerId', 'after'];
const operations = new Map([
  ['session', []],
  ['partners', readFields],
  ['borrowerApplications', readFields],
  ['borrowerDpd', [...readFields, 'applicationId']],
  ['dealerLink', ['partnerId']],
  ['borrowerLink', ['partnerId']],
  ['feeStatus', ['dealerId']],
  ['feeCheckout', ['dealerId']],
]);

const errors = new Map([
  [400, 'This action or its inputs are invalid.'],
  [401, 'Sign in with your organization account to continue.'],
  [403, 'You do not have access to this action.'],
  [404, 'This record is unavailable.'],
  [409, 'The record changed. Refresh and try again.'],
  [422, 'This record cannot be used for that action.'],
  [429, 'Too many requests. Try again later.'],
  [503, 'The operations service is unavailable. Try again later.'],
]);

function settings() {
  const oidc = getConfiguredOidcSettings();
  if (!oidc) return null;
  const destinyOrigin = privateServiceOrigin(process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN);
  const thorOrigin = privateServiceOrigin(process.env.TOOLJET_PARTNER_OPS_THOR_ORIGIN);
  if (!destinyOrigin || !thorOrigin) return null;
  return {
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    destinyOrigin,
    thorOrigin,
  };
}

function isDraftId(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
}

function validatedOperation(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { operation, ...fields } = body as Record<string, unknown>;
  if (typeof operation !== 'string') return null;
  const allowed = operations.get(operation);
  if (!allowed) return null;
  const values = Object.entries(fields);
  if (values.some(([key, value]) => !allowed.includes(key) || !positiveId(value))) return null;
  if (allowed.includes('dealerId') && !positiveId(fields.dealerId)) return null;
  if (allowed.includes('partnerId') && operation !== 'partners' && !positiveId(fields.partnerId)) return null;
  return Object.fromEntries([['operation', operation], ...values]) as Record<string, string>;
}

type CaseTarget = { id: string; name: string };
type PartnerSession = {
  display_name: string;
  directory_viewer?: boolean;
  permissions: { directory?: boolean; cases?: boolean; onboard?: boolean };
  channels: CaseTarget[];
  case_targets?: CaseTarget[];
  referral_targets?: { dealer?: CaseTarget[]; borrower?: CaseTarget[] };
};

type DestinyId = string | number;
type PartnerKey = { id: DestinyId; type: string; status: string };
type PartnerRow = PartnerKey & {
  name: string;
  parent_id: DestinyId | null;
  onboarding_status?: string;
  draft_id?: string;
};
type PartnerPage = { partners: PartnerRow[]; next_after?: DestinyId | null };

class UpstreamError extends Error {
  constructor(readonly status: number) {
    super();
  }
}

function destinyId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (!positiveId(id)) throw new UpstreamError(503);
  return id;
}

export async function runPartnerOps(
  sessions: SessionUtilService,
  user: OidcActorUser,
  body: unknown
): Promise<RelayResult> {
  const fail = (status: number) => ({ status, error: errors.get(status) });
  const config = settings();
  if (!config) return fail(404);
  const input = validatedOperation(body);
  if (!input) return fail(400);
  try {
    const { userId, organizationId } = await resolveThorActor(sessions, user, config);

    const forward = async <T>(path: string, payload?: object): Promise<T> => {
      const upstream = await fetch(new URL(path, config.destinyOrigin).href, {
        method: payload ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          'x-gct-user-id': userId,
          'x-gct-org-id': organizationId,
          ...(payload && { 'Content-Type': 'application/json' }),
        },
        body: payload && JSON.stringify(payload),
        signal: AbortSignal.timeout(input.operation === 'feeCheckout' ? 35_000 : 20_000),
      });
      if (!upstream.ok) throw new UpstreamError(errors.has(upstream.status) ? upstream.status : 503);
      const result = await upstream.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new UpstreamError(503);
      return result;
    };

    const { operation, dealerId, partnerId, after, applicationId } = input;
    const query = new URLSearchParams();
    if (operation === 'partners' && partnerId) query.set('parent_id', partnerId);
    if (after) query.set('after', after);
    if (applicationId) query.set('application_id', applicationId);
    const page = query.size ? `?${query}` : '';
    let data: object;

    switch (operation) {
      case 'session': {
        const session = await forward<PartnerSession>('/v1/channel-partners/session');
        const targets = (choices: CaseTarget[] = []) => choices.map(({ id, name }) => ({ id, name }));
        const dealerLink = targets(session.referral_targets?.dealer);
        const borrowerLink = targets(session.referral_targets?.borrower);
        const caseTargets = targets(session.case_targets ?? session.channels);
        const partnerDirectory = session.permissions.directory === true && !session.directory_viewer;
        data = {
          name: session.display_name,
          partnerDirectory,
          capabilities: [
            ...(partnerDirectory || caseTargets.length || dealerLink.length || borrowerLink.length ? ['partners'] : []),
            ...(session.permissions.cases && caseTargets.length ? ['borrowerApplications', 'borrowerDpd'] : []),
            ...(partnerDirectory && session.permissions.onboard ? ['feeStatus'] : []),
            ...(dealerLink.length ? ['dealerLink'] : []),
            ...(borrowerLink.length ? ['borrowerLink'] : []),
          ],
          caseTargets,
          linkTargets: { dealerLink, borrowerLink },
        };
        break;
      }
      case 'partners': {
        const result = await forward<PartnerPage>(`/v1/partners${page}`);
        data = {
          rows: result.partners.map(({ id, name, type, status, parent_id, onboarding_status, draft_id }) => ({
            id: destinyId(id),
            name,
            type,
            status,
            parentId: parent_id === null ? null : destinyId(parent_id),
            onboardingStatus: onboarding_status,
            canPayFee: type === 'dealer' && status === 'pending' && isDraftId(draft_id),
          })),
          ...(result.next_after != null && { nextAfter: destinyId(result.next_after) }),
        };
        break;
      }
      case 'borrowerApplications': {
        const result = await forward<{
          applications: { id: DestinyId; status: string; partner_id: DestinyId }[];
          next_after?: DestinyId | null;
        }>(`/v1/partners/${partnerId}/applications${page}`);
        data = {
          rows: result.applications.map(({ id, status, partner_id }) => ({
            id: destinyId(id),
            status,
            partnerId: destinyId(partner_id),
          })),
          ...(result.next_after != null && { nextAfter: destinyId(result.next_after) }),
        };
        break;
      }
      case 'borrowerDpd': {
        const result = await forward<{
          loans: { id: string; application_id: string; days_past_due: number | null; as_of: string }[];
          next_after?: DestinyId | null;
        }>(`/v1/partners/${partnerId}/dpd${page}`);
        data = {
          rows: result.loans.map(({ id, application_id, days_past_due, as_of }) => ({
            id,
            applicationId: destinyId(application_id),
            daysPastDue: days_past_due,
            asOf: as_of,
          })),
          ...(result.next_after != null && { nextAfter: destinyId(result.next_after) }),
        };
        break;
      }
      case 'dealerLink':
      case 'borrowerLink': {
        const { url } = await forward<{ url: string }>('/v1/channel-partners/referrals', {
          purpose: operation === 'dealerLink' ? 'dealer' : 'borrower',
          partner_id: partnerId,
        });
        const invite = new URL(url);
        const [token, ...extra] = new URLSearchParams(invite.hash.slice(1)).getAll('onboarding');
        if (
          !isHttpsUrl(invite.origin) ||
          invite.username ||
          invite.password ||
          invite.searchParams.has('onboarding') ||
          extra.length ||
          !/^v3\.[A-Za-z0-9_-]{39,1021}$/.test(token || '')
        ) {
          return fail(503);
        }
        data = { url: invite.href };
        break;
      }
      case 'feeStatus':
      case 'feeCheckout': {
        const dealer = await forward<PartnerKey>(`/v1/partners/${dealerId}`);
        if (destinyId(dealer.id) !== dealerId || dealer.type !== 'dealer' || dealer.status !== 'pending') {
          return fail(404);
        }

        // The scoped detail route omits draft_id. Resolve it through the directory's ID-ordered page.
        const directoryQuery = new URLSearchParams({ limit: '1' });
        if (dealerId !== '1') directoryQuery.set('after', (BigInt(dealerId) - BigInt(1)).toString());
        const { partners } = await forward<PartnerPage>(`/v1/partners?${directoryQuery}`);
        const candidate = partners[0];
        if (
          !candidate ||
          destinyId(candidate.id) !== dealerId ||
          candidate.type !== 'dealer' ||
          candidate.status !== 'pending' ||
          !isDraftId(candidate.draft_id)
        ) {
          return fail(404);
        }
        const action = operation === 'feeCheckout' ? 'checkout' : 'refresh';
        const fee = await forward<{
          status: string;
          total_paise: number | string | null;
          currency: string | null;
          invoice_number?: string;
          payment_url?: string;
        }>(`/v1/channel-partners/intakes/${candidate.draft_id}/fee/${action}`, {});
        const amount = fee.total_paise;
        if (
          amount != null &&
          (typeof amount === 'number' ? !Number.isSafeInteger(amount) || amount < 0 : !/^\d+$/.test(amount))
        ) {
          return fail(503);
        }
        data = {
          status: fee.status,
          amountPaise: amount == null ? null : String(amount),
          currency: fee.currency,
          ...(fee.invoice_number && { invoiceReference: fee.invoice_number }),
          ...(action === 'checkout' &&
            fee.status === 'unpaid' &&
            isHttpsUrl(fee.payment_url) && { checkoutUrl: fee.payment_url }),
        };
        break;
      }
      default:
        return fail(400);
    }
    return { status: 200, data };
  } catch (error) {
    return fail(error instanceof UpstreamError || error instanceof ThorActorError ? error.status : 503);
  }
}

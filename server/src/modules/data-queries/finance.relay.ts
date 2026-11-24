import { privateServiceOrigin } from '@helpers/private-service-origin';
import { getConfiguredOidcSettings } from '@modules/auth/oauth/configured-oidc.config';
import {
  type OidcActorUser,
  positiveId,
  resolveThorActor,
  ThorActorError,
} from '@modules/auth/oauth/configured-oidc-workspace';
import { SessionUtilService } from '@modules/session/util.service';
import type { RelayResult } from './staff-relay.service';
import { FINANCE_ENV } from './finance.config';

const errors = new Map([
  [400, 'This Finance action is invalid.'],
  [401, 'Sign in with your organization account to continue.'],
  [403, 'You do not have access to this Finance action.'],
  [409, 'Reconcile pending manual payouts before downloading the CSV.'],
  [429, 'Too many requests. Try again later.'],
  [503, 'Finance is unavailable. Try again later.'],
]);
const queuePath = '/v1/finance/disbursements';
const csvHeader = 'Payment Method Name,Debit Account No / IBAN,';

function financeOperation(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) return null;
  const { operation } = body as { operation?: unknown };
  return operation === 'queue' || operation === 'csv' ? operation : null;
}

function projectQueue(result: { products?: unknown } | null) {
  if (!Array.isArray(result?.products)) return null;

  const rows: { product: string; applicationId: string; loanId: string; status: string }[] = [];
  let canRequestCsv = false;
  for (const product of result.products) {
    if (!positiveId(product?.productId) || typeof product.productName !== 'string' || !Array.isArray(product.rows)) {
      return null;
    }
    for (const row of product.rows) {
      if (
        !positiveId(row?.applicationId) ||
        typeof row.loanId !== 'string' ||
        !row.loanId ||
        !['pending', 'initiated'].includes(row.disbursementStatus)
      ) {
        return null;
      }
      const pending = row.disbursementStatus === 'pending';
      if (pending && product.payoutMode === 'manual' && row.manualPayoutCandidate === true) canRequestCsv = true;
      rows.push({
        product: product.productName.trim() || product.productId,
        applicationId: row.applicationId,
        loanId: row.loanId,
        status: pending ? 'Pending payout' : 'Transfer initiated',
      });
    }
  }
  return { rows, canRequestCsv };
}

export async function runFinance(
  sessions: SessionUtilService,
  user: OidcActorUser,
  body: unknown
): Promise<RelayResult> {
  const fail = (status: number) => ({ status, error: errors.get(status) });
  const operation = financeOperation(body);
  if (!operation) return fail(400);

  const oidc = getConfiguredOidcSettings();
  const thorOrigin = privateServiceOrigin(process.env.TOOLJET_PARTNER_OPS_THOR_ORIGIN);
  const ironmanOrigin = privateServiceOrigin(process.env[FINANCE_ENV.origin]);
  const exportCsv = operation === 'csv';
  const key = process.env[exportCsv ? FINANCE_ENV.csvKey : FINANCE_ENV.readKey];
  if (!oidc || !thorOrigin || !ironmanOrigin || !key || !/^[a-f0-9]{64}$/.test(key)) return fail(503);
  if (exportCsv && key === process.env[FINANCE_ENV.readKey]) return fail(503);

  try {
    const { userId, organizationId } = await resolveThorActor(sessions, user, { ...oidc, thorOrigin });
    const headers = { 'x-gct-user-id': userId, 'x-gct-org-id': organizationId, 'api-secret': key };
    const result = await fetch(new URL(exportCsv ? `${queuePath}/export` : queuePath, ironmanOrigin).href, {
      method: exportCsv ? 'POST' : 'GET',
      redirect: 'error',
      headers: exportCsv ? { ...headers, 'Content-Type': 'application/json' } : headers,
      ...(exportCsv && { body: '{}' }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!result.ok) {
      if (result.status === 401 || result.status === 403) return fail(403);
      if (result.status === 429) return fail(429);
      if (exportCsv && result.status === 409) return fail(409);
      return fail(503);
    }
    if (exportCsv) {
      if (result.headers.get('content-type')?.split(';')[0].trim() !== 'text/csv') return fail(503);
      const csv = await result.text();
      return csv.startsWith(csvHeader) ? { status: 200, data: { csv } } : fail(503);
    }

    const data = projectQueue(await result.json());
    return data ? { status: 200, data } : fail(503);
  } catch (error) {
    return fail(error instanceof ThorActorError ? error.status : 503);
  }
}

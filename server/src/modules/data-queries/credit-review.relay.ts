import { createPrivateKey, sign } from 'node:crypto';
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
import { CREDIT_REVIEW_SIGNING_KEY_ENV } from './credit-review.config';

const errors = new Map([
  [400, 'This action or its inputs are invalid.'],
  [401, 'Sign in with your organization account to continue.'],
  [403, 'You do not have access to this action.'],
  [404, 'This record is unavailable.'],
  [409, 'The record changed. Refresh and try again.'],
  [422, 'This record cannot be used for that action.'],
  [429, 'Too many requests. Try again later.'],
  [503, 'Credit review is unavailable. Try again later.'],
]);

const actionFields = new Map([
  ['return', ['targetStepId', 'reason']],
  ['requestDocuments', ['targetStepId', 'reason']],
  ['reject', ['reason']],
  ['close', ['reason']],
  ['sanction', ['terms']],
]);

function settings() {
  const oidc = getConfiguredOidcSettings();
  const thorOrigin = privateServiceOrigin(process.env.TOOLJET_PARTNER_OPS_THOR_ORIGIN);
  const destinyOrigin = privateServiceOrigin(process.env.TOOLJET_PARTNER_OPS_UPSTREAM_ORIGIN);
  const encodedKey = process.env[CREDIT_REVIEW_SIGNING_KEY_ENV];
  if (!oidc || !thorOrigin || !destinyOrigin || !encodedKey) return null;
  try {
    const key = createPrivateKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return { issuer: oidc.issuer, clientId: oidc.clientId, thorOrigin, destinyOrigin, key };
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function reviewRequest(body: unknown) {
  if (!record(body) || !hasOnlyKeys(body, ['operation', 'fields']) || !record(body.fields)) return null;
  const { operation, fields } = body;
  if (operation === 'queue') {
    if (Object.keys(fields).length && (!hasOnlyKeys(fields, ['after']) || !positiveId(fields.after))) return null;
    return {
      contextId: 'queue',
      path: '/v1/applications/credit-review/queue',
      body: { action: 'queue', ...(fields.after !== undefined && { after: fields.after }) },
      signatureFields: ['queue', fields.after],
    };
  }

  const { applicationId, ...actionBody } = fields;
  if (!positiveId(applicationId)) return null;
  const path = `/v1/${applicationId}/credit-review`;
  if (operation === 'case' && Object.keys(actionBody).length === 0) {
    return {
      contextId: applicationId,
      path,
      body: { action: 'options' },
      signatureFields: ['options', null, null, null, null, null],
    };
  }

  const { action, reviewStepId, revision, targetStepId, reason, terms } = actionBody;
  const additional = typeof action === 'string' ? actionFields.get(action) : null;
  if (
    operation !== 'action' ||
    !additional ||
    !hasOnlyKeys(actionBody, ['action', 'reviewStepId', 'revision', ...additional]) ||
    !positiveId(reviewStepId) ||
    typeof revision !== 'string' ||
    !revision ||
    revision.length > 80 ||
    (additional.includes('targetStepId') && !positiveId(targetStepId)) ||
    (additional.includes('reason') && (typeof reason !== 'string' || !reason.trim() || reason.length > 500)) ||
    (additional.includes('terms') && !record(terms))
  ) {
    return null;
  }
  return {
    contextId: applicationId,
    path,
    body: actionBody,
    signatureFields: [action, reviewStepId, revision, targetStepId, reason, terms],
  };
}

export async function runCreditReview(
  sessions: SessionUtilService,
  user: OidcActorUser,
  body: unknown
): Promise<RelayResult> {
  const fail = (status: number) => ({ status, error: errors.get(status) });
  const config = settings();
  if (!config) return fail(404);
  const review = reviewRequest(body);
  if (!review) return fail(400);

  try {
    const { userId, organizationId } = await resolveThorActor(sessions, user, config);
    const expiry = String(Math.floor(Date.now() / 1000) + 30);
    const message = JSON.stringify([
      'destiny-borrower-credit-review-v2',
      review.contextId,
      userId,
      organizationId,
      review.signatureFields,
      expiry,
    ]);
    const signature = sign(null, Buffer.from(message, 'utf8'), config.key).toString('base64url');
    const result = await fetch(new URL(review.path, config.destinyOrigin).href, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'x-gct-user-id': userId,
        'x-gct-org-id': organizationId,
        'x-gct-credit-review-proof': `${userId}.${expiry}.${signature}`,
      },
      body: JSON.stringify(review.body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!result.ok) return fail(errors.has(result.status) ? result.status : 503);
    const data: unknown = await result.json();
    return record(data) ? { status: 200, data } : fail(503);
  } catch (error) {
    return fail(error instanceof ThorActorError ? error.status : 503);
  }
}

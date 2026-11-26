import { createHash, timingSafeEqual } from 'node:crypto';
import { privateServiceOrigin } from '../../helpers/private-service-origin';

export const DEALER_VOLTCRED_BRIDGE_ENV = 'TOOLJET_DEALER_VOLTCRED_BRIDGE';
const authorizeEndpoint = 'https://flash.voltcred.com/auth/dealer-onboarding/authorize';
const positiveId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[1-9][0-9]{0,18}$/.test(value) &&
  (value.length < 19 || value <= '9223372036854775807');

export type DealerVoltcredBridgeConfig = {
  actorOrganizationId: string;
  brokerSecret: string;
  destinyOrigin: string;
};

export type DealerVoltcredReceipt = {
  state: string;
  token: string;
  device: string;
  user_id: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function dealerVoltcredHandle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}

export function dealerVoltcredAuthorizeUrl(state: string) {
  if (!dealerVoltcredHandle(state)) throw new Error('Invalid dealer authorization state');
  const url = new URL(authorizeEndpoint);
  url.searchParams.set('state', state);
  return url.href;
}

export function parseDealerVoltcredBridge(value?: string): DealerVoltcredBridgeConfig | null {
  try {
    const input: unknown = JSON.parse(value ?? 'null');
    if (!record(input) || Object.keys(input).length !== 3) return null;
    const { actorOrganizationId, brokerSecret, destinyOrigin } = input;
    if (
      !positiveId(actorOrganizationId) ||
      typeof brokerSecret !== 'string' ||
      !/^[\x21-\x7e]{32,512}$/.test(brokerSecret) ||
      typeof destinyOrigin !== 'string' ||
      privateServiceOrigin(destinyOrigin) !== destinyOrigin
    )
      return null;
    return { actorOrganizationId, brokerSecret, destinyOrigin };
  } catch {
    return null;
  }
}

export function parseTrustedVoltcredReceipt(
  config: DealerVoltcredBridgeConfig,
  authorization: string | undefined,
  input: unknown
): DealerVoltcredReceipt | null {
  if (typeof authorization !== 'string' || authorization.length > 520) return null;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(authorization), digest(`Bearer ${config.brokerSecret}`))) return null;
  if (!record(input) || Object.keys(input).length !== 4) return null;
  const { state, token, device, user_id } = input;
  if (
    !dealerVoltcredHandle(state) ||
    !positiveId(user_id) ||
    typeof token !== 'string' ||
    token.length > 8192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
    typeof device !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(device)
  )
    return null;
  return { state, token, device, user_id };
}

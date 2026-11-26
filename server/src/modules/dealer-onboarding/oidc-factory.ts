import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { DealerOidcBroker, DealerOidcRedisStore } from './oidc-broker';

type Redis = { call(command: string, ...args: string[]): Promise<unknown> };
type Client = ConstructorParameters<typeof DealerOidcBroker>[2];
type RequestOptions = { headers?: Record<string, string> };
type Deps = {
  redis: Redis;
  requestJson?: (url: string, options: RequestOptions) => Promise<any>;
  createClient?: (
    metadata: Record<string, unknown>,
    config: DealerOidcFactoryConfig & { clientSecret: string }
  ) => Client;
};
export type DealerOidcFactoryConfig = {
  issuer: string;
  clientId: string;
  organizationId: string;
  redirectUri: string;
  viewerUrl: string;
  thorOrigin: string;
  destinyOrigin: string;
};
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && (v.length < 19 || v <= '9223372036854775807');
function url(value: unknown, httpsOnly: boolean, originOnly = false): string {
  if (typeof value !== 'string') throw new Error('Invalid dealer OIDC configuration');
  const u = new URL(value);
  if (
    (httpsOnly ? u.protocol !== 'https:' : !['http:', 'https:'].includes(u.protocol)) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (originOnly && value !== u.origin)
  )
    throw new Error('Invalid dealer OIDC configuration');
  return value;
}
function requestJson(target: string, options: RequestOptions): Promise<any> {
  const parsed = new URL(target);
  return new Promise((resolve, reject) => {
    const req = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(
      parsed,
      { method: 'GET', headers: options.headers, timeout: 5000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('Dealer identity service unavailable'));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 65536) req.destroy();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Invalid identity response'));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Identity request timeout')));
    req.on('error', reject);
    req.end();
  });
}
function createClient(
  metadata: Record<string, unknown>,
  config: DealerOidcFactoryConfig & { clientSecret: string }
): Client {
  const { Issuer, custom } = require('openid-client');
  const issuer = new Issuer(metadata);
  // openid-client 5.7.1 uses Node HTTP requests, which do not follow redirects.
  issuer[custom.http_options] = () => ({ timeout: 5000 });
  const client = new issuer.Client({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    token_endpoint_auth_method: 'client_secret_basic',
    id_token_signed_response_alg: 'RS256',
    redirect_uris: [config.redirectUri],
    response_types: ['code'],
  });
  client[custom.http_options] = () => ({ timeout: 5000 });
  return client;
}
export async function createDealerOidcBroker(
  env: NodeJS.ProcessEnv,
  deps: Deps
): Promise<{ broker: DealerOidcBroker; config: DealerOidcFactoryConfig }> {
  let raw: any;
  try {
    raw = JSON.parse(env.TOOLJET_DEALER_VN_OIDC || '');
  } catch {
    throw new Error('Invalid dealer OIDC configuration');
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof raw.clientId !== 'string' ||
    !/^[\x21-\x7e]{1,256}$/.test(raw.clientId) ||
    typeof raw.clientSecret !== 'string' ||
    !/^[\x21-\x7e]{24,512}$/.test(raw.clientSecret) ||
    !id(raw.organizationId) ||
    (raw.callback && raw.redirectUri && raw.callback !== raw.redirectUri)
  )
    throw new Error('Invalid dealer OIDC configuration');
  const issuer = url(raw.issuer, true);
  const issuerUrl = new URL(issuer);
  if (issuerUrl.pathname !== '/oidc' || issuer !== issuerUrl.origin + '/oidc')
    throw new Error('Invalid dealer OIDC configuration');
  const config: DealerOidcFactoryConfig = {
    issuer,
    clientId: raw.clientId,
    organizationId: raw.organizationId,
    redirectUri: url(raw.redirectUri || raw.callback, true),
    viewerUrl: url(raw.viewerUrl, true),
    thorOrigin: url(raw.thorOrigin, false, true),
    destinyOrigin: url(raw.destinyOrigin, false, true),
  };
  const secret = env.THOR_VN_DEALER_ENROLLMENT_SECRET || '';
  if (!/^[\x21-\x7e]{32,512}$/.test(secret)) throw new Error('Invalid dealer OIDC configuration');
  const get = deps.requestJson || requestJson;
  const metadata = await get(`${issuer}/.well-known/openid-configuration`, {});
  if (
    !metadata ||
    metadata.issuer !== issuer ||
    metadata.authorization_endpoint !== `${issuer}/auth` ||
    metadata.token_endpoint !== `${issuer}/token` ||
    metadata.jwks_uri !== `${issuer}/jwks`
  )
    throw new Error('Invalid dealer OIDC discovery');
  // Ignore all other discovery endpoints, so no provider-supplied URL can be used.
  const client = (deps.createClient || createClient)(
    { issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` },
    { ...config, clientSecret: raw.clientSecret }
  );
  const resolve = async (subject: string) => {
    if (!id(subject)) throw new Error('Invalid dealer subject');
    const result = await get(`${config.thorOrigin}/v1/users/oidc-subject/${subject}`, {
      headers: { 'x-gct-oidc-issuer': issuer, 'x-gct-oidc-client-id': config.clientId },
    });
    if (!result || result.sub !== subject || result.organization_id !== config.organizationId)
      throw new Error('Invalid dealer organization');
    return result;
  };
  return {
    broker: new DealerOidcBroker(
      {
        issuer,
        clientId: config.clientId,
        organizationId: config.organizationId,
        redirectUri: config.redirectUri,
        intentSecret: secret,
      },
      new DealerOidcRedisStore(deps.redis, config.organizationId, secret),
      client,
      resolve
    ),
    config,
  };
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const decorator = () => () => {};
const oidc = { origin: 'https://dealer.example', workspaceId: 'workspace', issuer: 'https://thor.example/oidc', subpath: '', clientId: 'other-client' };
let brokerConfig;
class Broker { constructor(config) { brokerConfig = config; } }
const mocked = {
  '@nestjs/common': { Controller: decorator, Get: decorator, Post: decorator, Req: decorator, Res: decorator, UseGuards: decorator },
  '@nestjs/config': {}, 'openid-client': { Issuer: { discover: async () => ({ issuer: oidc.issuer, authorization_endpoint: `${oidc.issuer}/auth`, token_endpoint: `${oidc.issuer}/token`, jwks_uri: `${oidc.issuer}/keys`, Client: class {} }) } },
  'typeorm': {}, '@modules/app/ability/guard': {}, '@modules/app/constants': { FEATURE_KEY: {} },
  '@modules/app/constants/modules': { MODULES: {} }, '@modules/app/decorators/init-feature.decorator': { InitFeature: decorator },
  '@modules/app/decorators/init-module': { InitModule: decorator }, '@modules/redis/service': {}, '@entities/app.entity': { App: class {} }, '@entities/app_version.entity': { AppVersion: class {} },
  '@modules/auth/oauth/configured-oidc.config': { getConfiguredOidcSettings: () => oidc }, '@helpers/private-service-origin': { privateServiceOrigin: (v) => v },
  '@modules/data-queries/oidc-rest': { getOidcRestSourceOrigin: () => 'http://destiny' }, '../applicant-session/store': { ApplicantSessions: class {} },
  './oidc-broker': { DealerOidcBroker: Broker, DealerOidcRedisStore: class {}, dealerOidcEndpointAllowed: () => true }, './viewer-login': { DealerViewerLogin: class {} },
  '@modules/data-queries/dealer-viewer': { DEALER_VIEWER_ENV: 'VIEWER', dealerViewerConfig: (raw) => raw && JSON.parse(raw) },
};
const source = fs.readFileSync(require('node:path').join(__dirname, '../../../../src/modules/dealer-onboarding/viewer-controller.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
const loaded = new Module('viewer-controller-test', module);
loaded.require = (id) => { if (!(id in mocked)) throw Error(`Unexpected import ${id}`); return mocked[id]; };
loaded._compile(code, 'viewer-controller-test');

test('constructs a broker using each configured tenant', async () => {
  for (const organizationId of ['731', '942']) {
    const scope = { origin: oidc.origin, organizationId, sourceId: 'source', appId: 'app', lspSecret: 's'.repeat(64) };
    const values = { VIEWER: JSON.stringify(scope), SECRET_KEY_BASE: 's'.repeat(32), TOOLJET_OIDC_THOR_ORIGIN: 'http://thor', TOOLJET_DEALER_ENROLLMENT_INTENT_SECRET: 's'.repeat(32), TOOLJET_DEALER_OIDC_CLIENT_ID: 'dealer', TOOLJET_DEALER_OIDC_CLIENT_SECRET: 'secret' };
    let count = 0;
    const db = { getRepository: () => ({ findOne: async () => ++count === 1 ? { id: 'app', currentVersionId: 'version', organizationId: 'workspace' } : { isPublic: true, slug: 'dealer' } }) };
    const controller = new loaded.exports.DealerViewerController({ get: (key) => values[key] }, {}, db);
    const context = await controller.context();
    assert.equal(context.scope.organizationId, organizationId);
    assert.equal(brokerConfig.organizationId, organizationId);
  }
});

test('forwards scalar issuer and rejects malformed issuer query values', async () => {
  const controller = new loaded.exports.DealerViewerController({}, {}, {});
  const calls = [];
  controller.context = async () => ({
    redirect: '/applications/dealer',
    login: {
      callback: async (...args) => {
        calls.push(args);
        return { id: 'session' };
      },
    },
  });
  const response = () => ({
    set() {},
    clearCookie() {},
    cookie() {},
    status(code) { this.statusCode = code; return this; },
    send() { return this; },
    redirect(code, path) { this.statusCode = code; this.path = path; return this; },
  });
  const state = 's'.repeat(43);
  const request = (iss) => ({
    query: { state, code: 'code', ...(iss === undefined ? {} : { iss }) },
    cookies: { '__Host-tj-dealer-flow': 'flow', '__Host-tj-dealer-state': state },
  });
  const ok = response();
  await controller.callback(request(oidc.issuer), ok);
  assert.equal(ok.statusCode, 303);
  assert.equal(ok.path, '/applications/dealer');
  assert.deepEqual(calls[0][0], { state, code: 'code', iss: oidc.issuer });

  const noIssuer = response();
  await controller.callback(request(undefined), noIssuer);
  assert.deepEqual(calls[1][0], { state, code: 'code' });

  for (const iss of [['https://thor.example/oidc', 'https://thor.example/oidc'], {}, '', null]) {
    const res = response();
    await controller.callback(request(iss), res);
    assert.equal(res.statusCode, 503);
  }
  assert.equal(calls.length, 2);
});

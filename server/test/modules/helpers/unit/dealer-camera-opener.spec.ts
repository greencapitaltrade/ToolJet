import { ConfigService } from '@nestjs/config';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import { setSecurityHeaders } from '@helpers/bootstrap.helper';
import { Request, Response } from 'express';
import * as request from 'supertest';

const origin = 'https://app.example.test';
const host = 'app.example.test';
const viewerPath = '/applications/e2aa7e52-1fe7-4aac-b6ac-137a0aba8151/dealer-admission';
const viewerUrl = `${origin}${viewerPath}`;
const header = 'Cross-Origin-Opener-Policy';

function fixture(viewer?: string, tooljetHost = origin, subpath?: string) {
  const app = new ExpressAdapter();
  const config = new ConfigService({
    TOOLJET_HOST: tooljetHost,
    TOOLJET_DEALER_CAMERA_VIEWER_URL: viewer,
    SUB_PATH: subpath,
  });
  setSecurityHeaders(app as unknown as NestExpressApplication, config, {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  app.use((_req: Request, res: Response) => res.status(200).send('viewer'));
  return request(app.getInstance());
}

/** @group platform */
describe('dealer camera viewer opener policy', () => {
  it('preserves the opener on the exact configured viewer with an invite query', async () => {
    await fixture(viewerUrl)
      .get(`${viewerPath}?onboarding=synthetic`)
      .set('Host', host)
      .expect(header, 'same-origin-allow-popups')
      .expect('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(self)');
  });

  it('supports the configured viewer under the server subpath', async () => {
    const subpath = '/tools/';
    const mountedPath = `/tools${viewerPath}`;
    await fixture(`${origin}${mountedPath}`, origin, subpath)
      .get(mountedPath)
      .set('Host', host)
      .expect(header, 'same-origin-allow-popups');
    await fixture(viewerUrl, origin, subpath).get(viewerPath).set('Host', host).expect(header, 'same-origin');
  });

  it.each([
    undefined,
    '',
    viewerPath,
    `http://${host}${viewerPath}`,
    `https://other.example.test${viewerPath}`,
    `https://someone@${host}${viewerPath}`,
    `${viewerUrl}?onboarding=synthetic`,
    `${viewerUrl}#onboarding=synthetic`,
    `${viewerUrl}/`,
    `${origin}/api/dealer-onboarding`,
    `${origin}/applications/dealership/login`,
    `${origin}/applications/dealership/signup`,
    `${origin}/applications/dealership/forgot-password`,
    `${origin}/applications/dealership/RESET-PASSWORD`,
    `${origin}/applications/dealership/nested/../dealer-admission`,
    `${origin}/applications/dealership/versions/synthetic/dealer-admission`,
  ])('keeps Helmet defaults when the configured viewer is %p', async (viewer) => {
    const path = typeof viewer === 'string' && URL.canParse(viewer) ? new URL(viewer).pathname : viewerPath;
    await fixture(viewer).get(path).set('Host', host).expect(header, 'same-origin');
  });

  it.each([
    '/applications/another-app/dealer-admission',
    '/applications/e2aa7e52-1fe7-4aac-b6ac-137a0aba8151/another-page',
    '/applications/e2aa7e52-1fe7-4aac-b6ac-137a0aba8151',
    '/apps/e2aa7e52-1fe7-4aac-b6ac-137a0aba8151/dealer-admission',
    '/api/dealer-onboarding',
    `${viewerPath}/`,
    `${viewerPath}-alternate`,
  ])('keeps Helmet defaults on %s', async (path) => {
    await fixture(viewerUrl).get(path).set('Host', host).expect(header, 'same-origin');
  });

  it('keeps Helmet defaults with a different host even if a header claims the canonical forwarded host', async () => {
    await fixture(viewerUrl)
      .get(viewerPath)
      .set('Host', 'other.example.test')
      .set('X-Forwarded-Host', host)
      .set('X-Forwarded-Proto', 'https')
      .expect(header, 'same-origin');
  });

  it('keeps Helmet defaults when the canonical host is configured for HTTP', async () => {
    await fixture(viewerUrl, `http://${host}`).get(viewerPath).set('Host', host).expect(header, 'same-origin');
  });

  it.each(['head', 'post'] as const)('keeps Helmet defaults on %s requests', async (method) => {
    await fixture(viewerUrl)[method](viewerPath).set('Host', host).expect(header, 'same-origin');
  });
});

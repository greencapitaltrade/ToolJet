import { isConfiguredOidcRequest, sanitizeOAuthRequest, sanitizeOAuthUrl } from '../../../../src/otel/sanitize';

describe('dealer viewer callback telemetry', () => {
  it('removes callback parameters and request data', () => {
    const url = '/api/dealer-onboarding/viewer/callback?code=secret&state=secret';
    expect(isConfiguredOidcRequest(url)).toBe(true);
    expect(sanitizeOAuthUrl(url)).toBe('/api/dealer-onboarding/viewer/callback');
    expect(sanitizeOAuthRequest({ id: 1, method: 'GET', url, headers: { cookie: 'secret' }, query: { code: 'secret' } }))
      .toEqual({ id: 1, method: 'GET', url: '/api/dealer-onboarding/viewer/callback' });
  });
});

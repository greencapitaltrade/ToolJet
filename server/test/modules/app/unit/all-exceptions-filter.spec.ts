import { randomUUID } from 'crypto';
import { AllExceptionsFilter } from '@modules/app/filters/all-exceptions-filter';
import { ArgumentsHost, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { sanitizeOAuthRequest, sanitizeOAuthUrl } from '@otel/sanitize';
import { Logger, PinoLogger } from 'nestjs-pino';

/** @group platform */
describe('AllExceptionsFilter logging', () => {
  const lines: string[] = [];
  const logger = new Logger(new PinoLogger({ pinoHttp: [{}, { write: (line: string) => lines.push(line) }] }), {});
  const filter = new AllExceptionsFilter(logger);
  const transactionId = '123456789012345';

  function report(exception: Error, url: string, headers: Record<string, string>) {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      locals: { tj_transactionId: transactionId },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url, headers }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    filter.catch(exception, host);
    return response;
  }

  beforeEach(() => {
    lines.length = 0;
  });

  it('logs a rejected OIDC callback without request credentials or exception contents', () => {
    const code = randomUUID();
    const state = randomUUID();
    const cookie = randomUUID();
    const authorization = randomUUID();
    const provider = randomUUID();
    const referer = randomUUID();
    const route = '/tooljet/api/oauth/oidc/callback';
    const url = `${route}?code=${code}&state=${state}`;
    const message = 'OIDC sign-in could not be completed';
    const exception = Object.assign(new UnauthorizedException(message), { providerResponse: provider });
    exception.stack = `Unexpected provider response: ${provider}`;

    const response = report(exception, url, {
      cookie: `tj_oidc_flow=${cookie}`,
      authorization: `Bearer ${authorization}`,
      referer: `https://tooljet.example${route}?error_description=${referer}`,
    });

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, message }));
    expect(lines.length).toBe(1);
    expect(
      [code, state, cookie, authorization, provider, referer].some((sensitive) => lines[0].includes(sensitive))
    ).toBe(false);
    expect(JSON.parse(lines[0])).toMatchObject({ method: 'GET', url: route, statusCode: 401, transactionId });
  });

  it('retains method, URL, status, correlation and exception diagnosis for ordinary failures', () => {
    const url = '/api/apps/example?view=summary';
    const cookie = randomUUID();
    const response = report(new NotFoundException('Application not found'), url, { cookie });

    expect(response.status).toHaveBeenCalledWith(404);
    expect(lines.length).toBe(1);
    expect(lines[0].includes(cookie)).toBe(false);
    expect(JSON.parse(lines[0])).toMatchObject({
      method: 'GET',
      url,
      statusCode: 404,
      transactionId,
      msg: expect.stringContaining('Application not found'),
    });
  });
});

/** @group platform */
describe('configured OIDC HTTP telemetry', () => {
  it.each(['/api/oauth/oidc/start', '/tooljet/api/oauth/oidc/callback/'])(
    'strips provider parameters from %s and its referer',
    (path) => {
      const value = randomUUID();
      const url = `${path}?error_description=${value}`;
      const referer = `https://tooljet.example${url}`;
      const request = {
        id: 1,
        method: 'GET',
        url,
        query: { error_description: value },
        headers: { referer, cookie: value, authorization: value },
      };
      const safeRequest = sanitizeOAuthRequest(request);

      expect(JSON.stringify(safeRequest).includes(value)).toBe(false);
      expect(safeRequest).toEqual({ id: 1, method: 'GET', url: path });
      const safeReferer = sanitizeOAuthUrl(referer);
      expect(String(safeReferer).includes(value)).toBe(false);
      expect(safeReferer).toBe(`https://tooljet.example${path}`);
    }
  );
});

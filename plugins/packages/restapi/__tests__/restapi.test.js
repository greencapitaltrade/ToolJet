'use strict';

jest.mock('got', () => ({
  __esModule: true,
  ...jest.requireActual('got'),
  default: jest.fn(),
}));

const got = require('got').default;
const RestAPI = require('../lib').default;

describe('restapi', () => {
  const origin = 'http://api.namespace.svc.cluster.local';
  const source = { url: origin, headers: [['api-secret', 'synthetic-secret']] };
  const query = { method: 'get', url: '/v1/records' };
  const context = { trustedRestOrigin: origin };

  beforeEach(() => got.mockReset());

  it('calls the stock REST connector without following redirects or exposing private request metadata', async () => {
    got.mockResolvedValue({ statusCode: 200, body: '{"records":[]}', headers: {} });
    await expect(new RestAPI().run(source, query, 'native-source', '', context)).resolves.toEqual({
      status: 'ok',
      data: { records: [] },
    });
    expect(got).toHaveBeenCalledWith(
      `${origin}/v1/records`,
      expect.objectContaining({
        followRedirect: false,
        retry: 0,
        headers: { 'api-secret': 'synthetic-secret' },
      })
    );
  });

  it('rejects a credentialed REST target different from its server-pinned origin', async () => {
    await expect(
      new RestAPI().run({ ...source, url: 'https://elsewhere.example.test' }, query, 'native-source', '', context)
    ).rejects.toMatchObject({ data: { status: 400 } });
    expect(got).not.toHaveBeenCalled();
  });

  it('returns only the upstream status for a redirect', async () => {
    got.mockResolvedValue({ statusCode: 302, body: 'sensitive upstream payload', headers: {} });
    const error = await new RestAPI().run(source, query, 'native-source', '', context).catch((failure) => failure);
    expect(error).toMatchObject({ data: { status: 302 } });
    expect(JSON.stringify(error)).not.toContain('sensitive upstream payload');
    expect(got).toHaveBeenCalledTimes(1);
  });
});

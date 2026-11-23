/** @group platform */
import * as express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleApplicantRequest } from '../../../../src/modules/applicant-session/http';
import { parseDealerUpload, parseDealerSelfie } from '../../../../src/modules/dealer-onboarding/upload';

const scope = {
  origin: 'https://app.example.test',
  organizationId: '39',
  furyUrl: 'https://gateway.example.test/v2/graphql',
  lspSecret: 'synthetic-service-credential',
};
const pdf = '%PDF-1.4 synthetic upload';
const jpeg = Uint8Array.from([255, 216, 255, 0, 255, 217]);
let server: Server;
let endpoint: string;
const parse = jest.fn(parseDealerUpload);
const parseSelfie = jest.fn(parseDealerSelfie);

beforeAll(async () => {
  const app = express();
  app.post('/', (req, res) =>
    handleApplicantRequest(
      req,
      res,
      scope,
      'dealer',
      async () => {
        const result = await parse(req, res);
        expect(result.code).toBe('bank_statement');
        expect(result.file.toString()).toBe(pdf);
        return { attached: true };
      },
      'multipart/form-data'
    )
  );
  app.post('/selfie', (req, res) =>
    handleApplicantRequest(
      req,
      res,
      scope,
      'dealer-participant',
      async () => {
        const frame = await parseSelfie(req, res);
        expect(frame).toEqual(Buffer.from(jpeg));
        return { state: 'action', status: 'verified' };
      },
      'multipart/form-data'
    )
  );
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve).once('error', reject);
  });
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

it('checks the selfie origin and rejects browser-supplied case fields and excess bytes', async () => {
  const form = new FormData();
  form.set('file', new Blob([jpeg], { type: 'image/jpeg' }), 'evidence.jpg');
  const send = (origin = scope.origin) =>
    fetch(`${endpoint}selfie`, { method: 'POST', body: form, headers: { origin } });
  expect((await send('https://other.example.test')).status).toBe(403);
  expect(parseSelfie).not.toHaveBeenCalled();
  const accepted = await send();
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get('cache-control')).toBe('no-store');
  expect(await accepted.json()).toEqual({ state: 'action', status: 'verified' });
  form.set('personId', 'client-choice');
  expect((await send()).status).toBe(400);
  form.delete('personId');
  form.set('file', new Blob([new Uint8Array(96 * 1024 + 1)], { type: 'image/jpeg' }), 'evidence.jpg');
  expect((await send()).status).toBe(413);
});

afterAll(
  async () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
);

it('parses one bounded same-origin multipart attachment without echoing file bytes', async () => {
  const form = new FormData();
  form.set('code', 'bank_statement');
  form.set('file', new Blob([pdf]), 'evidence');
  const blocked = await fetch(endpoint, {
    method: 'POST',
    body: form,
    headers: { origin: 'https://other.example.test' },
  });
  expect(blocked.status).toBe(403);
  expect(parse).not.toHaveBeenCalled();
  const accepted = await fetch(endpoint, { method: 'POST', body: form, headers: { origin: scope.origin } });
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get('cache-control')).toBe('no-store');
  expect(await accepted.json()).toEqual({ attached: true });
  form.append('file', new Blob([pdf]), 'second');
  const multiple = await fetch(endpoint, { method: 'POST', body: form, headers: { origin: scope.origin } });
  expect(multiple.status).toBe(400);
});

/**
 * A stand-in for the Google Sheets v4 API.
 *
 * The Sheets client lets `rootUrl` be overridden, so pointing it here exercises
 * the *real* client — real auth plumbing, real request serialization, real
 * error handling — and captures exactly what would have gone to Google.
 *
 * That matters because the claims worth testing are all about the wire format:
 * whether a zip is sent as a string or a number, whether 500 rows become one
 * request or 500, whether a 429 is retried. A hand-rolled fake of our own code
 * would prove none of it.
 */
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface MockSheets {
  readonly url: string;
  readonly requests: CapturedRequest[];
  /** Every cell ever appended, in order, as the API received it. */
  cells(): unknown[][];
  /** Fail the next `n` batchUpdate calls with this status. */
  failNext(count: number, status: number): void;
  close(): Promise<void>;
}

export async function startMockSheets(
  options: {
    existingTabs?: { title: string; sheetId: number; rows?: number; cols?: number }[];
  } = {},
): Promise<MockSheets> {
  const requests: CapturedRequest[] = [];
  const appended: unknown[][] = [];
  const tabs = [...(options.existingTabs ?? [])];
  let failures = 0;
  let failStatus = 429;
  let nextSheetId = 1000;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const path = req.url ?? '';
      let body: unknown;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? 'GET', path, body });

      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Token endpoint, for the fake service-account credentials.
      if (path.includes('/token') || path.includes('oauth2')) {
        send(200, { access_token: 'mock-token', expires_in: 3600, token_type: 'Bearer' });
        return;
      }

      if (req.method === 'GET') {
        send(200, {
          spreadsheetId: 'mock',
          sheets: tabs.map((t) => ({
            properties: {
              sheetId: t.sheetId,
              title: t.title,
              gridProperties: { rowCount: t.rows ?? 1000, columnCount: t.cols ?? 26 },
            },
          })),
        });
        return;
      }

      if (req.method === 'POST' && path.includes(':batchUpdate')) {
        if (failures > 0) {
          failures -= 1;
          send(failStatus, {
            error: { code: failStatus, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' },
          });
          return;
        }

        const requestList =
          (body as { requests?: Record<string, unknown>[] } | null)?.requests ?? [];
        const replies: unknown[] = [];

        for (const request of requestList) {
          const addSheet = request['addSheet'] as { properties?: { title?: string } } | undefined;
          if (addSheet !== undefined) {
            const sheetId = (nextSheetId += 1);
            tabs.push({ title: addSheet.properties?.title ?? 'Sheet', sheetId });
            replies.push({
              addSheet: { properties: { sheetId, title: addSheet.properties?.title } },
            });
            continue;
          }

          const append = request['appendCells'] as { rows?: { values?: unknown[] }[] } | undefined;
          if (append !== undefined) {
            for (const row of append.rows ?? []) appended.push(row.values ?? []);
            replies.push({});
            continue;
          }
          replies.push({});
        }

        send(200, { spreadsheetId: 'mock', replies });
        return;
      }

      send(404, { error: { code: 404, message: `no mock route for ${path}` } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    cells: () => appended,
    failNext: (count, status) => {
      failures = count;
      failStatus = status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * A syntactically valid service-account key.
 *
 * The client parses and signs with this before making any call, so it has to be
 * a real RSA key — but it authenticates only against the mock above.
 */
export function fakeServiceAccount(tokenUri: string): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return JSON.stringify({
    type: 'service_account',
    project_id: 'mock-project',
    private_key_id: 'mock-key-id',
    private_key: privateKey,
    client_email: 'gms-mock@mock-project.iam.gserviceaccount.com',
    client_id: '000000000000000000000',
    token_uri: tokenUri,
  });
}

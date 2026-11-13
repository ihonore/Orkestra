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
  /** What a tab holds right now, header included: appends minus clears. */
  rows(title: string): unknown[][];
  /** Fail the next `n` batchUpdate calls with this status. */
  failNext(count: number, status: number): void;
  /** Fail the next `n` appends only, letting other writes through. */
  failAppends(count: number, status: number): void;
  /** Runs before each append is answered, e.g. to change the data mid-export. */
  onAppend(callback: () => void): void;
  close(): Promise<void>;
}

export async function startMockSheets(
  options: {
    existingTabs?: {
      title: string;
      sheetId: number;
      rows?: number;
      cols?: number;
      /** Rows already in the tab, including its header. */
      values?: unknown[][];
    }[];
  } = {},
): Promise<MockSheets> {
  const requests: CapturedRequest[] = [];
  const appended: unknown[][] = [];
  const tabs = (options.existingTabs ?? []).map((tab) => ({
    ...tab,
    values: [...(tab.values ?? [])],
  }));
  let failures = 0;
  let failStatus = 429;
  let appendFailures = 0;
  let appendFailStatus = 403;
  let beforeAppend: () => void = () => undefined;
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

      // values.get: a block of rows (`1:2`) or of columns (`G2:G`), as plain
      // text, trimmed as Google trims it — no trailing blank cells or rows.
      const valuesRange = /\/values\/([^?]+)/.exec(path);
      if (req.method === 'GET' && valuesRange !== null) {
        const range = decodeURIComponent(valuesRange[1]!);
        const title = /^'?(.*?)'?!/.exec(range)?.[1]?.replace(/''/g, "'");
        const a1 = range.slice(range.lastIndexOf('!') + 1);
        const tab = tabs.find((t) => t.title === title);
        const text = (cell: unknown): string => {
          const value = (cell as { userEnteredValue?: Record<string, string | number | boolean> })
            ?.userEnteredValue;
          const first = value === undefined ? undefined : Object.values(value)[0];
          return first === undefined ? '' : String(first);
        };
        const column = (letters: string): number =>
          [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        let block: string[][];
        const byRows = /^(\d+):(\d+)$/.exec(a1);
        const byColumns = /^([A-Z]+)(\d+):([A-Z]+)(\d*)$/.exec(a1);
        const all = (tab?.values ?? []).map((row) => row.map(text));
        if (byRows !== null) {
          block = all.slice(Number(byRows[1]) - 1, Number(byRows[2]));
        } else if (byColumns !== null) {
          const [, from, firstRow, to, lastRow] = byColumns;
          block = all
            .slice(Number(firstRow) - 1, lastRow === '' ? undefined : Number(lastRow))
            .map((row) => row.slice(column(from!), column(to!) + 1));
        } else {
          block = all;
        }
        const trimmed = block.map((row) => {
          const out = [...row];
          while (out.length > 0 && out[out.length - 1] === '') out.pop();
          return out;
        });
        while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.length === 0) trimmed.pop();
        send(200, {
          range,
          majorDimension: 'ROWS',
          ...(trimmed.length > 0 && { values: trimmed }),
        });
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
            tabs.push({ title: addSheet.properties?.title ?? 'Sheet', sheetId, values: [] });
            replies.push({
              addSheet: { properties: { sheetId, title: addSheet.properties?.title } },
            });
            continue;
          }

          // Real Google's answer, measured against a live sheet: a tab with a
          // frozen header cannot lose every row beneath it. A mock that accepted
          // this let a rebuild ship that failed on every real attempt.
          const remove = request['deleteDimension'] as
            { range?: { sheetId?: number; startIndex?: number; endIndex?: number } } | undefined;
          if (remove !== undefined) {
            const tab = tabs.find((t) => t.sheetId === remove.range?.sheetId);
            const rowCount = tab?.rows ?? 1000;
            if ((remove.range?.startIndex ?? 0) <= 1 && (remove.range?.endIndex ?? 0) >= rowCount) {
              send(400, {
                error: {
                  code: 400,
                  message:
                    'Invalid requests[0].deleteDimension: Sorry, it is not possible to delete all non-frozen rows.',
                  status: 'INVALID_ARGUMENT',
                },
              });
              return;
            }
            replies.push({});
            continue;
          }

          // A column inserted: every row's cells from there move right.
          const insert = request['insertDimension'] as
            | {
                range?: {
                  sheetId?: number;
                  dimension?: string;
                  startIndex?: number;
                  endIndex?: number;
                };
              }
            | undefined;
          if (insert !== undefined && insert.range?.dimension === 'COLUMNS') {
            const tab = tabs.find((t) => t.sheetId === insert.range?.sheetId);
            const at = insert.range.startIndex ?? 0;
            const count = (insert.range.endIndex ?? at) - at;
            for (const row of tab?.values ?? []) {
              if (row.length > at) row.splice(at, 0, ...Array.from({ length: count }, () => ({})));
            }
            if (tab !== undefined) tab.cols = (tab.cols ?? 26) + count;
            replies.push({});
            continue;
          }

          // updateCells with `start` and `rows` writes cells in place.
          const write = request['updateCells'] as
            | {
                start?: { sheetId?: number; rowIndex?: number; columnIndex?: number };
                rows?: { values?: unknown[] }[];
              }
            | undefined;
          if (write?.start !== undefined && write.rows !== undefined) {
            const tab = tabs.find((t) => t.sheetId === write.start?.sheetId);
            const top = write.start.rowIndex ?? 0;
            const left = write.start.columnIndex ?? 0;
            write.rows.forEach((row, r) => {
              if (tab === undefined) return;
              while (tab.values.length <= top + r) tab.values.push([]);
              const target = tab.values[top + r]!;
              (row.values ?? []).forEach((cell, c) => {
                while (target.length < left + c) target.push({});
                target[left + c] = cell;
              });
            });
            replies.push({});
            continue;
          }

          const clear = request['updateCells'] as
            { range?: { sheetId?: number; startRowIndex?: number } } | undefined;
          if (clear !== undefined) {
            const tab = tabs.find((t) => t.sheetId === clear.range?.sheetId);
            tab?.values.splice(clear.range?.startRowIndex ?? 0);
            replies.push({});
            continue;
          }

          const append = request['appendCells'] as
            { sheetId?: number; rows?: { values?: unknown[] }[] } | undefined;
          if (append !== undefined) {
            if (appendFailures > 0) {
              appendFailures -= 1;
              send(appendFailStatus, {
                error: { code: appendFailStatus, message: 'The caller does not have permission' },
              });
              return;
            }
            beforeAppend();
            const tab = tabs.find((t) => t.sheetId === append.sheetId);
            for (const row of append.rows ?? []) {
              appended.push(row.values ?? []);
              tab?.values.push(row.values ?? []);
            }
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
    rows: (title) => tabs.find((t) => t.title === title)?.values ?? [],
    failNext: (count, status) => {
      failures = count;
      failStatus = status;
    },
    failAppends: (count, status) => {
      appendFailures = count;
      appendFailStatus = status;
    },
    onAppend: (callback) => {
      beforeAppend = callback;
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

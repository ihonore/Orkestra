/**
 * The Google Sheets setup check, shared by `gms doctor --sheets` and the
 * dashboard's "Test connection" button, so both say the same thing about the
 * same failure.
 */
import fs from 'node:fs';
import type { ResolvedConfig } from '../config/schema.js';
import { errorMessage } from '../core/errors/taxonomy.js';
import { displayPath, resolvePath } from '../core/util/paths.js';

export interface SheetsCheck {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
  readonly hint?: string;
}

/**
 * Verify the Google Sheets setup end to end.
 *
 * Every failure mode here has the same symptom — an export that does not work —
 * but a completely different fix, so they are distinguished explicitly. The
 * commonest by far is forgetting to share the sheet with the service account,
 * which returns a bare 403.
 */
export async function checkSheets(config: ResolvedConfig): Promise<SheetsCheck[]> {
  const settings = config.exporters.sheets;

  if (settings.spreadsheetId === undefined || settings.spreadsheetId === '') {
    return [
      {
        name: 'Google Sheets',
        status: 'warn',
        detail: 'not configured',
        hint:
          'Paste the sheet link in the dashboard (Control, step 7) and press Save,\n' +
          'or set exporters.sheets.spreadsheetId.',
      },
    ];
  }

  const results: SheetsCheck[] = [];
  const { SheetsExporter, MAX_CELLS_PER_SPREADSHEET } = await import('./sheets.js');
  const { VIEWS } = await import('../views/index.js');

  const credentials =
    settings.credentialsFile !== undefined
      ? resolvePath(settings.credentialsFile, config.paths.root)
      : undefined;

  if (credentials !== undefined) {
    if (!fs.existsSync(credentials)) {
      return [
        {
          name: 'Google Sheets',
          status: 'fail',
          detail: `credentials file not found: ${displayPath(credentials)}`,
          hint: 'Check exporters.sheets.credentialsFile, or remove it to use gcloud login.',
        },
      ];
    }
    // The service-account email is what the sheet must be shared with, and
    // nobody can guess it — so print it.
    try {
      const key = JSON.parse(fs.readFileSync(credentials, 'utf8')) as { client_email?: string };
      results.push({
        name: 'Sheets identity',
        status: 'ok',
        detail: key.client_email ?? 'service account',
        hint: `Share the sheet with ${key.client_email ?? 'this address'} as an Editor.`,
      });
    } catch {
      return [
        {
          name: 'Google Sheets',
          status: 'fail',
          detail: 'credentials file is not valid JSON',
          hint: 'Re-download the service-account key from the Google Cloud console.',
        },
      ];
    }
  } else {
    results.push({
      name: 'Sheets identity',
      status: 'ok',
      detail: 'application default credentials',
      hint: 'Run `gcloud auth application-default login` if this fails.',
    });
  }

  try {
    const exporter = new SheetsExporter({
      spreadsheetId: settings.spreadsheetId,
      sheetName: settings.sheetName,
      createIfMissing: settings.createIfMissing,
      ...(credentials !== undefined && { credentialsFile: credentials }),
    });

    const room = await exporter.prepare(VIEWS['leads-flat']!);
    const usedPercent = ((room.cellsUsed / MAX_CELLS_PER_SPREADSHEET) * 100).toFixed(1);

    results.push({
      name: 'Sheets access',
      status: 'ok',
      detail: `"${settings.sheetName}" is writable`,
    });
    results.push({
      name: 'Sheets capacity',
      status: room.cellsFree < 100_000 ? 'warn' : 'ok',
      detail: `${room.cellsUsed.toLocaleString()} cells used (${usedPercent}% of 10M)`,
      ...(room.cellsFree < 100_000 && {
        hint: 'Nearly full. Start a fresh spreadsheet, or export to CSV instead.',
      }),
    });
  } catch (error) {
    const message = errorMessage(error);
    const status =
      (error as { status?: number; code?: number }).status ?? (error as { code?: number }).code;

    // Each of these looks identical to a user but needs a different fix.
    const hint =
      status === 403
        ? 'The service account cannot see this sheet. Open the sheet, press Share, and add\n' +
          'the address shown above as an Editor. This is the usual cause.'
        : status === 404
          ? 'No spreadsheet with that id. Check exporters.sheets.spreadsheetId — it is the\n' +
            'long id from docs.google.com/spreadsheets/d/<THIS>/edit'
          : /API has not been used|disabled/i.test(message)
            ? 'Enable the Google Sheets API for this project in the Cloud console.'
            : credentials === undefined && /default credentials/i.test(message)
              ? 'No key file is set. Choose the service-account key in the dashboard (Control, step 7),\n' +
                'or set exporters.sheets.credentialsFile.'
              : 'Check the credentials and the spreadsheet id.';

    results.push({
      name: 'Sheets access',
      status: 'fail',
      detail: message.split('\n')[0] ?? message,
      hint,
    });
  }

  return results;
}

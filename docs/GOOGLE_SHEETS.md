# Sharing results in a Google Sheet

A one-time setup, about ten minutes. After it, new leads land in a sheet your
team can open, and re-running only sends what is new.

The database stays the source of truth. The sheet is a **view** onto it — so if
an export fails halfway, nothing is lost and the next run continues from where
it stopped.

---

## What you are setting up

The tool needs its own Google identity — a **service account** — because it runs
unattended and cannot click a login screen. You then share your sheet with that
identity, exactly as you would share it with a colleague.

---

## 1. Create the service account

1. Open <https://console.cloud.google.com/> and create a project (or pick one).
2. Enable the Sheets API: **APIs & Services → Library → "Google Sheets API" →
   Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account**.
   Give it a name like `gms-exporter`. No roles are needed — access comes from
   sharing the sheet, not from project permissions.
4. Open the new service account → **Keys → Add key → Create new key → JSON**.
   A file downloads.

Keep that file out of the repository. Something like:

```
~/gms-credentials/gms-exporter.json
```

> **If step 4 is blocked** with a message about key creation being disabled, your
> organisation enforces `iam.disableServiceAccountKeyCreation` — the default for
> Google Cloud organisations created since May 2024. Skip to
> [Without a key file](#without-a-key-file).

## 2. Create the sheet and share it

1. Make a new spreadsheet at <https://sheets.new>.
2. Copy its ID from the URL — the long part between `/d/` and `/edit`:

   ```
   docs.google.com/spreadsheets/d/1a2B3cD4eF5gH6iJ7kL8mN9oP0qR/edit
                                  └────────── this ──────────┘
   ```

3. Press **Share** and add the service account's address as an **Editor**. It
   looks like `gms-exporter@your-project.iam.gserviceaccount.com` and is the
   `client_email` field inside the JSON key.

   **This step is the one people miss.** Without it every export fails with a
   bare 403.

## 3. Tell the tool

In `gms.config.yaml`:

```yaml
exporters:
  sheets:
    spreadsheetId: 1a2B3cD4eF5gH6iJ7kL8mN9oP0qR
    sheetName: Leads
    credentialsFile: ~/gms-credentials/gms-exporter.json
```

## 4. Check it before you rely on it

```bash
gms doctor --sheets
```

This prints the service-account address to share with, confirms the tab is
writable, and reports how much of the sheet's capacity is used. Every failure
comes with the specific fix — a 403 means the sharing step, a 404 means the ID
is wrong.

## 5. Send the leads

```bash
gms export sheets
```

Or from the dashboard: `gms ui --control`, then **step 6**.

Run it as often as you like. It only ever sends what is new since last time.

### Why a business can appear twice

The sheet has one row per **email address**, because that is what a mail merge
needs — a firm with three addresses is three rows.

Addresses are found *after* the businesses are: `gms run` collects the listings,
`gms enrich emails` visits their websites. So a business often reaches the sheet
before its address does, on a row with the email column blank. When the address
turns up, the business appears again, this time with it.

That second row is new information, not a duplicate. If you only want the
reachable ones, sort or filter the sheet by the email column. The `business_id`
column is stable, so rows for the same business always share it.

---

## Without a key file

If your organisation blocks key creation, use your own Google login instead —
which is also the more secure option, since there is no key file to leak.

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/cloud-platform
```

Then omit `credentialsFile` entirely:

```yaml
exporters:
  sheets:
    spreadsheetId: 1a2B3cD4eF5gH6iJ7kL8mN9oP0qR
```

Share the sheet with **your own** Google account, which it already is if you
created it. The trade-off is that the credentials expire and need renewing, so
this suits an operator running exports by hand better than a scheduled job.

---

## Limits worth knowing in advance

**A spreadsheet holds 10 million cells** — across every tab, not per tab. At ~20
columns that is roughly 500,000 rows. A full 15,725-job sweep will produce more
leads than that, so `gms export sheets` refuses an export that would not fit
rather than failing partway and leaving a half-written sheet. Use
`gms export csv` for the bulk data and keep the sheet as the working view.

**Writes are capped at 60 per minute** for the whole service account. That is a
Google limit on the *identity*, so adding workers does not help. Rows are sent
in large batches to stay well inside it — 500 rows cost one write, not 500 — and
the command estimates the duration before it starts.

**Zips and phone numbers keep their leading zeros.** Each value is sent with an
explicit type, so `02108` stays `02108` and a 20-digit Google CID keeps every
digit. This is the one thing the old spreadsheet got wrong, and it is why the
exporter uses `appendCells` rather than the simpler `values.append`.

**Nothing is ever deleted or overwritten.** Rows are only appended. If you want
to start clean, delete the tab yourself and run `gms export sheets --full`.

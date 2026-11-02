# Installing on a Windows VPS

One file does the whole job: `scripts/windows/install.cmd`. Run it once to
install, and again any time to update.

## Install

1. On your Mac, copy `scripts/windows/install.cmd` from this project.
2. Connect to the VPS with Remote Desktop and paste the file onto its desktop.
   Remote Desktop copies files through the clipboard.
3. Double-click it. Approve the administrator prompt if one appears.
4. When the GitHub sign-in window opens, sign in. The repository is private, and
   Git remembers the sign-in for later updates.

It takes about five minutes. The installer:

- installs **Node.js 24** and **Git** if they are missing, and checks every
  download against its published SHA-256 checksum;
- downloads GMS to `C:\gms` (set `GMSINSTALL_DIR` first for another folder);
- installs dependencies, Chromium, and builds;
- creates the database, with the 185 cities and 85 services from `seeds/`;
- puts **GMS Dashboard** and **Update GMS** on the desktop, and starts the
  dashboard when you sign in;
- finishes by launching Chromium once to prove scraping can work.

Then double-click **GMS Dashboard**. It opens the dashboard in the browser.

## Bring your existing leads (optional)

The installer starts with an empty queue. To carry over the leads and progress
from your Mac instead:

```bash
gms db backup gms-backup.sqlite      # on the Mac
```

Paste `gms-backup.sqlite` onto the VPS desktop **next to `install.cmd`** before
running it. It is used only when the VPS has no database yet, so an update can
never overwrite real data.

## Google Sheets export

All from the dashboard, in step 7 (**Share with your team**) on the Control page:

1. Paste the sheet's link into **Sheet**, choose the **Layout** (one row per
   business is the default, in its own tab "Leads by business"), check the
   **Tab** name, and press **Save**.
2. **Choose key file** and pick the service account's `.json` key. It is
   checked, stored in `C:\Users\<you>\gms-credentials\`, and recorded in
   `gms.config.local.yaml`. The page then shows the account's address.
3. In the sheet, press **Share** and add that address as an **Editor**.
4. **Test connection** shows what works and what to fix. Then **Send to Sheet**.

No restart is needed. Creating the service account and its key is covered in
[GOOGLE_SHEETS.md](GOOGLE_SHEETS.md).

## Update

Double-click **Update GMS**. It pulls the latest version, rebuilds and migrates
the database. Stop any scrape and close the dashboard window first; the
installer refuses to run under a live copy.

Keep machine-specific settings in `gms.config.local.yaml` (the dashboard's
Settings page writes there). Editing `gms.config.yaml` on the VPS would make
the update's `git pull` fail.

Some updates correct data already scraped. When one does, the update queues
the searches to re-read by itself, and autopilot holds the sheet until they
have run. There is nothing to do but click **Update GMS**.

## Day to day

**Turn on Autopilot** at the top of the Control page and leave it. It keeps
the scrape running, finds emails as websites come in, and sends new leads with
an email to the sheet every 500 rows or every 2 hours. Its recommended
settings are sized for this VPS. It turns back on by itself after a reboot,
once the dashboard starts at sign-in.

- **Keep the "GMS dashboard" window open.** Minimise it, don't close it:
  closing it stops the dashboard and any scrape it started.
- **Disconnecting from Remote Desktop is fine.** Scrapes keep running. Signing
  out of Windows stops them.
- **Stop** in the dashboard is graceful on Windows: in-flight searches finish
  and save their place, and the browser closes. Then the scrape exits.
- The dashboard only answers on `127.0.0.1`, so it is reachable from the VPS
  itself, or through a tunnel: `ssh -L 4600:127.0.0.1:4600 you@vps`.

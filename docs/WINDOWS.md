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

The service-account key is a secret and is not in the repository. Copy it to
the path `exporters.sheets.credentialsFile` names in `gms.config.yaml`, under
your user folder on the VPS (`~` is `C:\Users\<you>`). Then run
`gms doctor --sheets`. See [GOOGLE_SHEETS.md](GOOGLE_SHEETS.md).

## Update

Double-click **Update GMS**. It pulls the latest version, rebuilds and migrates
the database. Stop any scrape and close the dashboard window first; the
installer refuses to run under a live copy.

Keep machine-specific settings in `gms.config.local.yaml` (the dashboard's
Settings page writes there). Editing `gms.config.yaml` on the VPS would make
the update's `git pull` fail.

## Day to day

- **Keep the "GMS dashboard" window open.** Minimise it, don't close it:
  closing it stops the dashboard and any scrape it started.
- **Disconnecting from Remote Desktop is fine.** Scrapes keep running. Signing
  out of Windows stops them.
- **Stop** in the dashboard is graceful on Windows: in-flight searches finish
  and save their place, and the browser closes. Then the scrape exits.
- The dashboard only answers on `127.0.0.1`, so it is reachable from the VPS
  itself, or through a tunnel: `ssh -L 4600:127.0.0.1:4600 you@vps`.

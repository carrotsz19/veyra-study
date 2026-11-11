# Veyra Study

A study app for tracking tasks and progress per subject, taking notes, planning deadlines and timing focus sessions. It is part of the Veyra family, and its look comes from the Veyra design system (`carrotsz19/veyra`, `live/ui-standard.md`).

## Run it

Needs [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev      # app with live reload
npm run build    # typecheck + production build
npm start        # run the production build
npm run dist     # Windows installer in release/
```

Data lives in SQLite files under `%APPDATA%\veyra-study\`. It uses Electron's built-in `node:sqlite`, so there is nothing native to compile:
- `veyra.db` is used without an account.
- `accounts\<folder>\veyra.db` is one file per Veyra account (see `accounts.json`).

## What's in it (phase 1)

- **Today:** what's due or overdue, what's coming up, study time today, progress per subject.
- **Subjects:** a colour, a progress bar, and the subject's own tasks, notes and study time.
- **Tasks:** due dates, priority, details, quick add, and filters (open, overdue, done).
- **Notes:** a document page with an icon, a cover and a font choice, and four layouts: Page, Cornell (cues, notes, summary), Lined and Grid.
  - Type `/` to add headings, lists, checklists, callouts, question toggles, tables, quotes, code or dividers.
  - Select text to format it, including five highlighter colours.
  - Notes save as you type and are searchable.
- **Calendar:** a month view of deadlines plus your Google Calendar events. Click a day to add a task due that day.
- **Accounts:** sign in with your Veyra account (the same one as IronLog and Cashline), or use the app without one.
- **Google Calendar:** shows events from the calendars you pick, and adds task deadlines as all-day events to a "Veyra Study" calendar. Set it up in Settings.
- **Focus timer:** Pomodoro-style, tied to a subject. It keeps running while you move around the app, and finished blocks are logged.
- **Stats:** study time per day, daily average, tasks finished, streak, and time per subject.
- **Theme:** follows the system by default, or set light or dark.

## Roadmap

1. ~~Desktop app~~ (done)
2. Android app and sync. The phone runs the sync server, and Tailscale lets the PC reach it from anywhere.
3. Voice: record and import audio, play it back, and transcribe it offline on the PC with whisper.cpp.
4. Handwriting in notes, plus reminder notifications.

## How the data is shaped (and why)

Every item is a **record**: `{ id (UUID), kind, data (JSON), createdAt, updatedAt, deletedAt, deviceId }` in a single `records` table. That shape was chosen for syncing in phase 2:

- Devices exchange records changed since their last sync (`changesSince`).
- When two devices change the same record, the newer `updatedAt` wins, with `deviceId` breaking ties.
- Deletes set `deletedAt` instead of removing the row, so a delete reaches the other device too.

The UI only talks to storage through `src/renderer/src/data/store.ts` (the `VeyraDb` interface in `src/shared/types.ts`). The Android build can then provide the same interface without the screens changing.

## Accounts

The app signs in through the Veyra Worker's existing endpoints (`getLoginSalt`, `veyraLogIn`, `veyraSignUp`, `launcherWhoAmI`, `logOut`), with no server changes:
- Passwords are hashed in the app exactly as `live/index.html` does it (PBKDF2-SHA256, 310,000 rounds, `v2$` + base64).
- The session cookie and handle stay in the main process, encrypted with Windows' secure storage (`safeStorage`). The UI never sees them.
- The first account to sign in on a computer takes over the data that was there before. Signing out keeps each account's data on disk.
- `VEYRA_SERVER` points the app at another server, such as staging.

## Google Calendar

**Connect (both ways).** Veyra Study has its own Google OAuth client (a Desktop app client in the owner's Google Cloud project), built in at build time. Users click **Connect** in Settings and approve in their browser. The redirect goes to a loopback address (`127.0.0.1`) and uses PKCE.
- Scopes:
  - `calendar.app.created`: create and manage only the Veyra Study calendar.
  - `calendar.calendarlist.readonly` and `calendar.events.readonly`: read calendars and events.
- Event IDs come from task IDs, so pushing a deadline again never creates a duplicate.
- Until Google verifies the app, users see an "unverified app" warning, and at most 100 can connect.

The client comes from `google-client.json` in the project folder: the JSON downloaded from Google Cloud → Clients. It is **git-ignored and never committed**. You can also set `VEYRA_GOOGLE_CLIENT_ID` and `VEYRA_GOOGLE_CLIENT_SECRET`. Without either, the Connect button is hidden and people can enter their own client under "Advanced".

**Calendars by link (read-only, no sign-in).** Paste a calendar's "Secret address in iCal format", or any `.ics` link. Repeating events, moved or cancelled occurrences and time zones are handled by `ical.js`. Links are stored encrypted.

## Group work

Shared tasks, chat, notes and deadlines live on a small server running on a
spare Android phone (Termux). The phone gets a free Cloudflare quick-tunnel
address that changes when it restarts, so it publishes the address to a tiny
relay Worker (`relay/`), and the app looks it up there. The relay also checks
who you are with Veyra and hands the phone a signed 15-minute pass, so your
Veyra session never reaches the phone.

**PC, once:**

```
npx wrangler login
npm run relay:setup
```

This makes the secrets on your PC, writes `server/.env` (git ignores it),
creates the relay's storage, deploys the relay and gives it the secrets.

**Phone (Termux, from F-Droid, plus Termux:Boot):**

```
pkg install -y nodejs cloudflared
termux-setup-storage
mkdir -p ~/veyra-group ~/.termux/boot
```

Copy `server/group-server.mjs`, `server/.env` and `server/start-phone.sh` to
the phone's Download folder, then:

```
cp ~/storage/downloads/group-server.mjs ~/storage/downloads/.env ~/veyra-group/
cp ~/storage/downloads/start-phone.sh ~/.termux/boot/ && chmod +x ~/.termux/boot/start-phone.sh
~/.termux/boot/start-phone.sh &
```

Delete `.env` from the Download folder afterwards. `tail ~/veyra-group/server.log`
should show the tunnel address being published.

Testing on the PC: `npm test` runs the server and relay tests; `TUNNEL=off npm run group-server` runs a local server.

## Layout

```
src/main/        Electron main process: window, SQLite store (db.ts), IPC,
                 Veyra accounts (account.ts), Google Calendar (gcal.ts),
                 iCal links (ical.ts)
src/preload/     exposes window.veyra.db to the UI
src/shared/      types shared by both sides
src/renderer/    React UI: views/, components/, data/, lib/, styles.css
```

Dev-check environment variables:

| Variable | Effect |
|---|---|
| `VEYRA_USERDATA=dir` | Uses a separate profile (sign-in and data) |
| `VEYRA_DB=path` | Pins one database |
| `VEYRA_ROUTE=stats` | Opens on that screen |
| `VEYRA_THEME=light` or `dark` | Forces the theme |
| `VEYRA_EVAL=js` | Runs a script before the screenshot |
| `VEYRA_SCREENSHOT=out.png` | Saves a screenshot, then quits |
| `VEYRA_FAKE_GOOGLE=1` | Shows sample Google events |

Use `VEYRA_USERDATA` for any test that signs in, so your real profile stays untouched.

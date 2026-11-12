# Veyra Study

Your tasks, notes, timetable and study time in one calm app, on **Windows** and **Android**, synced through your Veyra account (the same account as IronLog and Cashline). Its look comes from the Veyra design system (`carrotsz19/veyra`, `live/ui-standard.md`).

**Download:** [the latest release](https://github.com/carrotsz19/veyra-study/releases/latest)
- **Windows:** run `Veyra-Study-Setup-<version>.exe`.
- **Android:** install `Veyra-Study-<version>.apk` from the matching `android-v<version>` release.
- After the first install, both update themselves.

## What it does

- **Today:** what's due and what's next, your focus time and streak. You can rearrange the widgets.
- **Tasks:** subjects, due dates, priorities and reminders; steps inside a task; repeating tasks; quick add. On the phone, swipe to tick a task off or delete it.
- **Notes:** a rich editor with headings, checklists, callouts, question toggles, tables, code, drawings and files.
  - Voice notes are transcribed on your computer (whisper.cpp).
  - Page, Cornell, Lined and Grid layouts.
  - Tags, pins, archive, and a trash that keeps deleted notes for 30 days.
  - Search looks through every word.
- **Calendar:** your month at a glance, with your tasks next to your Google Calendar or any iCal link.
- **Focus timer:** focus and break blocks per subject. They carry on through restarts, and the time feeds Stats.
- **Stats:** study time per day and per subject, daily average, tasks finished, streak.
- **Group work:** shared tasks, chat, notes and deadlines with classmates.
- **Ctrl+K:** jump anywhere, find anything, or start something new.
- **AI:** your notes, tasks and timetable can be opened in Claude, Gemini or other MCP apps, read-only unless you allow changes. AI help is built into notes, using local AI or your own key.
- **Google Drive:** an optional backup of your notes, and importing from Drive.
- **Made to feel right:** Veyra's own title bar and menus on Windows, acrylic glass, spring animations, light and dark, and a lot to customise in Settings, with a whole section for the phone.

## Run it from the code

Needs [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev        # the app with live reload (uses its own data, never the installed app's)
npm run build      # typecheck + production build
npm test           # group server and relay tests
```

Android, once: `npm run android:setup` installs a JDK and the Android SDK under `C:\dev\tools`. Then:

```bash
npm run android:build      # build the APK
npm run android:install    # build it and put it on the phone plugged in by USB
```

## Dev and Prod

There are two builds, and they install side by side:

- **Veyra Study** is what everyone uses.
- **Veyra Study Dev** is for trying changes first. It has a DEV badge, its own data, and its own updates, which come from the private repo `carrotsz19/veyra-study-dev`.

```bash
npm run release:dev        # a Dev test build, Windows + Android (no version bump needed)
npm run release            # Prod for Windows: bump package.json and add a CHANGELOG.md section first
npm run release:android    # Prod for Android, the same version
```

[RELEASING.md](RELEASING.md) explains the whole workflow and the rules that keep Prod safe. [CHANGELOG.md](CHANGELOG.md) lists what changed in each version, and the app shows it as "What's new".

## Data and sync

- **Where it lives:** in SQLite through Electron's built-in `node:sqlite`, so nothing native has to be compiled. Prod uses `%APPDATA%\veyra-study\`, and Dev and `npm run dev` use `%APPDATA%\veyra-study-dev\`.
  - Without an account, everything is in `veyra.db`.
  - With an account, there's one `accounts\<folder>\veyra.db` per account.
- **On the phone:** IndexedDB, behind the same interface.
- **What a record is:** every item is a record, `{ id, kind, data (JSON), createdAt, updatedAt, deletedAt, deviceId }`. The UI only reaches storage through `src/renderer/src/data/store.ts` (`VeyraDb` in `src/shared/types.ts`).
- **How sync works** (`src/shared/sync-core.ts`):
  - Each device pulls what the others changed, then pushes its own.
  - When two devices change the same record, the newer `updatedAt` wins, with `deviceId` breaking ties.
  - Deletes are kept as markers, so they reach the other devices too.
  - Settings and attached files stay on each device.

## Accounts

The app signs in through the Veyra Worker's existing endpoints (`getLoginSalt`, `veyraLogIn`, `veyraSignUp`, `launcherWhoAmI`, `logOut`):
- Passwords are hashed in the app exactly as `live/index.html` does it (PBKDF2-SHA256, 310,000 rounds, `v2$` + base64).
- The session stays in the main process, encrypted with Windows' secure storage (`safeStorage`) or Android's secure storage. The UI never sees it.
- The first account to sign in on a device takes over the data that was there before. Signing out keeps each account's data on disk.
- `VEYRA_SERVER` points the app at another server, such as staging.

## Google Calendar and Drive

Veyra Study has its own Google OAuth client (a Desktop app client), built in at build time. People click **Connect** in Settings and approve in their browser, through a loopback redirect with PKCE.
- **Calendar scopes:** `calendar.app.created` (only the Veyra Study calendar) plus read-only access to calendars and events. Deadlines become all-day events, and their IDs come from the task IDs, so they never duplicate.
- **The client:** comes from `google-client.json` (downloaded from Google Cloud → Clients), which is **git-ignored and never committed**. `VEYRA_GOOGLE_CLIENT_ID` / `VEYRA_GOOGLE_CLIENT_SECRET` work too. Without either, people can enter their own client under "Advanced".
- **Calendars by link:** paste any `.ics` link, read-only, with no sign-in. `ical.js` handles repeats and time zones, and links are stored encrypted.

## Group work and sync server

Group work and sync run on a small server on a spare Android phone (Termux), `server/group-server.mjs`:
- **Reaching it:** the phone gets a free Cloudflare quick-tunnel address and publishes it to a tiny relay Worker (`relay/`), where the apps look it up.
- **Checking who you are:** the relay checks you with Veyra and hands the phone a signed 15-minute pass, so your Veyra session never reaches the phone.
- **Backups:** the server keeps compressed daily backups.

**On the PC, once:**

```
npx wrangler login
npm run relay:setup
```

This makes the secrets, writes `server/.env` (git-ignored), creates the relay's storage, and deploys the relay.

**On the phone** (Termux and Termux:Boot from F-Droid):

```
pkg install -y nodejs cloudflared
termux-setup-storage
mkdir -p ~/veyra-group ~/.termux/boot
```

Copy `server/group-server.mjs`, `server/.env` and `server/start-phone.sh` to the phone's Download folder, then:

```
cp ~/storage/downloads/group-server.mjs ~/storage/downloads/.env ~/veyra-group/
cp ~/storage/downloads/start-phone.sh ~/.termux/boot/ && chmod +x ~/.termux/boot/start-phone.sh
~/.termux/boot/start-phone.sh &
```

Delete `.env` from the Download folder afterwards. `tail ~/veyra-group/server.log` should show the tunnel address being published. To test on the PC, run `TUNNEL=off npm run group-server`.

## Layout

```
src/main/        Electron main process: window and title bar, SQLite store, accounts,
                 updates, Google, sync, group work, voice, AI, MCP, tray and reminders
src/preload/     the bridge (window.veyra) between the main process and the UI
src/renderer/    React UI: views/, components/, data/, lib/, styles
src/mobile/      the Android app's stand-in for the main process (Capacitor)
src/shared/      shared by everything: types, settings, sync, repeating tasks, Dev/Prod channel
android/         the Android project (Capacitor 8)
server/          the group and sync server (runs on the phone)
relay/           the Cloudflare Worker that finds the server
tools/           build, release and setup scripts
build/           installer additions (NSIS)
```

## Checking things during development

| Variable | Effect |
|---|---|
| `VEYRA_USERDATA=dir` | A separate profile (sign-in and data) |
| `VEYRA_DB=path` | Pins one database |
| `VEYRA_ROUTE=stats` | Opens on that screen |
| `VEYRA_THEME=light` or `dark` | Forces the theme |
| `VEYRA_EVAL=js` | Runs a script before the screenshot |
| `VEYRA_SCREENSHOT=out.png` | Saves a screenshot, then quits |
| `VEYRA_FAKE_GOOGLE=1` | Shows sample Google events |
| `VEYRA_NO_UPDATE=1` | Skips update checks |
| `VEYRA_UPDATE_URL=url` | Uses a stand-in update server |
| `VEYRA_UPDATE_DRYRUN=1` | Downloads updates but never installs them |

Use `VEYRA_USERDATA` for any test that signs in, so a real profile stays untouched.

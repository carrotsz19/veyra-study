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

Your data lives in a SQLite file at `%APPDATA%\veyra-study\veyra.db`. It uses Electron's built-in `node:sqlite`, so there is nothing native to compile.

## What's in it (phase 1)

- **Today:** what's due or overdue, what's coming up, study time today, progress per subject.
- **Subjects:** a colour, a progress bar, and the subject's own tasks, notes and study time.
- **Tasks:** due dates, priority, details, quick add, and filters (open, overdue, done).
- **Notes:** a rich-text editor with headings, highlights, checklists, quotes and code. Notes save as you type and are searchable.
- **Calendar:** a month view of deadlines. Click a day to add a task due that day.
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

## Layout

```
src/main/        Electron main process: window, SQLite store (db.ts), IPC
src/preload/     exposes window.veyra.db to the UI
src/shared/      types shared by both sides
src/renderer/    React UI: views/, components/, data/, lib/, styles.css
```

Dev checks: `VEYRA_DB=path` uses a different database, `VEYRA_ROUTE=stats` opens on a given screen, and `VEYRA_SCREENSHOT=out.png` saves a screenshot and quits.

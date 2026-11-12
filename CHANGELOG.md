# What's new in Veyra Study

Each version's section becomes its notes on GitHub, and the "What's new" text
in Settings → Software update. `npm run release` won't publish a version
without one.

## 0.2.3

- **The focus timer survives a restart.** A running or paused block carries on if Veyra is closed, or if Android stops it in the background, and its study time is still saved.
- **Android: alerts on time.** Focus timer and reminder notifications now arrive at the minute they're due (Android 12 and later could delay them).
- **Android: Settings search** no longer leads to sections that only exist in the computer app.

## 0.2.2

- **Software update in Settings.** See your version, check for updates, download with progress and restart to update, all from Settings → Software update. You can also turn off the check at start-up. After an update, Veyra tells you what's new.
- **AI apps get full control.** Claude, Gemini and other AI apps connected to Veyra can now create, rename and delete subjects; edit, move and delete notes and tasks; log study time; read your calendar; and add to group work. Writes still need "Let AI apps make changes" turned on.
- **Android: export and import.** Export everything, export notes as Markdown, and import a backup, through the phone's share sheet and file picker.
- **Android: focus timer alerts** arrive when a block ends, even when Veyra is in the background.
- **Android: notes save when you switch apps,** so nothing typed just before is lost.
- **Android: no dead ends.** Buttons for things that only work on the computer (AI study tools, Google Docs and Drive, calendar connections, syllabus planning) are no longer shown on the phone.

## 0.2.1

- Fixed: the installed app closed itself instead of opening when there was no update.

## 0.2.0

- **Windows installer.** Veyra Study installs like any other app and checks for updates each time it starts, with a start-up window that shows the check, the download and the install.
- **Transcription with Subtitle Maker.** If Subtitle Maker is installed, voice recordings are transcribed with it (with punctuation and your own fixes), so nothing extra has to be downloaded.

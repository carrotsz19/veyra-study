# What's new in Veyra Study

Each version's section becomes its notes on GitHub, and the "What's new" text
in Settings → Software update. `npm run release` won't publish a version
without one.

## 0.2.6

- **Updates arrive even if Veyra stays in the tray.** Closing the window keeps Veyra running, so it used to stay on an old version. Now it checks every few hours and whenever you open it, downloads new versions quietly, offers **Restart**, and installs the update when you close the window, coming back in the tray.
- **Settings → Phone** (Android): choose the screens in the navigation bar and their order; names under icons always, for the current screen only, or never; a floating or docked bar; what the round button makes, or turn it off; hide the bar while typing; the running timer above the bar; large One UI titles; pure black dark mode; vibration on taps; keep the screen on while focusing; and the note formatting bar at the top or bottom.

## 0.2.5

- **Group work on phones** is a list of your groups; tap one and it opens as its own page. The page stays still: only the tasks, messages or notes scroll, and the message box stays put above the navigation.
- **Calendar on phones** fills the screen: the month never scrolls.
- **The navigation bar stays put.** The round button is on every screen now, so the bar no longer changes width as you move around, and it steps aside while you type.
- **Slim scroll bars on the computer.** A thin bar shows while you scroll and grows thicker when you point at it, so it's easy to grab.
- **Android:** updates now come from inside the app (Settings → Software update), and the app has the Veyra icon.

## 0.2.4

- **Notes, reworked.** On Windows, the list and the page sit side by side on one clean surface, with notes grouped by date (Pinned, Today, Yesterday, Previous 7 days…), subject and tag filters, and previews that no longer repeat the title. The toolbar fits on one row, with blocks, files and voice notes under Insert.
- **Notes on Android** open as their own full-screen page: the navigation steps aside while you write, and the formatting bar sits at the bottom, within reach of your thumb.
- **Group work and sync recover by themselves** when the group server gets a new address. Before, an app could hold on to an address that no longer worked and keep saying "answered 405".
- Clearer messages when the group server is offline for a moment.

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

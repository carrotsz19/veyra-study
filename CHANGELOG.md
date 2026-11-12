# What's new in Veyra Study

Each version's section becomes its notes on GitHub, and the "What's new" text
in Settings → Software update. `npm run release` won't publish a version
without one.

## Unreleased (in Veyra Study Dev)

- **Folders for notes:** group notes into folders, and folders inside folders; open one to see its folders and notes, and new notes start there. Move notes and folders by dragging them onto a folder (or onto the back link to go up a level), from the right-click menu, or several notes at once. Searching still looks through everything.
- **Folders for subjects:** group subjects in the sidebar, with folders inside folders; click a folder to fold it away.
- **Drag and drop in the sidebar:** drag a subject onto a folder to put it in, onto another subject to place it there, or onto the Subjects heading to take it out; drag folders into folders; drag notes from the list onto a subject to give them that subject. Everything can be undone.
- **Spelling suggestions:** misspelled words in notes get a wavy red line; right-click one for fixes ("consilting" → "consulting") or to add it to your dictionary. British and American English, offline.
- **Right-click menus in text:** Cut, Copy, Paste, Undo and Select all wherever you type.
- **Updates come by themselves:** Veyra looks for an update every 10 minutes and when you come back to it, downloads it quietly, and shows "Restart to update" in the title bar.
- **Window buttons:** Windows' own (the default, with Snap layouts) or Mac-style dots, in Settings → Appearance.
- **Focus timer:** breaks and the next focus block now start by themselves (you can turn this off).
- **Full screen** keeps the glass look without flickering.

## 1.0.0

**Veyra Study 1.0.** Your tasks, notes, timetable and study time in one calm app, on Windows and Android, synced through your Veyra account.

- **Today:** what's due, what's next, your focus time and streak, on a page you can arrange yourself.
- **Tasks:** subjects, due dates, priorities and reminders; steps inside tasks; repeating tasks; swipe to tick off or delete on your phone.
- **Notes:** a rich editor with headings, checklists, tables, drawings, files and voice notes (transcribed on your computer); Cornell, lined and grid pages; tags, pins, archive and a 30-day trash; search through every word.
- **Calendar:** your month at a glance, with your tasks and your Google Calendar side by side.
- **Focus timer:** focus and break blocks that carry on through restarts, with your study time saved to Stats.
- **Group work:** shared tasks, chat, notes and deadlines with your classmates.
- **Ctrl+K:** jump anywhere, find anything, or start something new.
- **Made to feel right:** Veyra's own title bar, menus and pickers, acrylic glass, spring animations, light and dark, and lots to customise in Settings.
- **Your data:** stays on your devices and syncs through your account; export it any time.
- **Still being built:** you may run into bugs. Tell the owner (@carrotsz19) at igreenrobotz@gmail.com, or open a bug report on GitHub (Help → Report a bug).

## 0.2.13

- **A calmer calendar.** The month fills the window instead of scrolling, so the month name and the ‹ Today › controls are always in view. Events read as clean lines (a dot in their calendar's colour, the title, the time on the right), all-day events and birthdays as soft tinted bars, tasks with a small box in their subject's colour, and as many fit in each day as the window allows before "+ more".
- The window is called Veyra Study in the taskbar and Alt+Tab.

## 0.2.12

- **The title bar's menus are real acrylic now.** They open in a little window of their own that Windows blurs behind, like its own menus, so what's underneath is softly blurred rather than just showing through. (The browser engine Veyra runs on can't blur inside a see-through window, which is why 0.2.11's menus only looked faded.)

## 0.2.11

- **Menus are acrylic.** The title bar menus, drop-downs, date and time pickers, and right-click and toolbar menus are now see-through and blurred, like Windows 11 menus, in light and dark.

## 0.2.10

- **Fixed: moving between screens could light up two items in the sidebar and make the window look washed out** for a moment.
- **A title bar of Veyra's own on Windows:** the Veyra mark and name, then File, Edit, View and Help menus (new task or note, import and export, undo and copy, every screen with Ctrl+1 to Ctrl+7, light or dark, bigger or smaller text, full screen, what's new, updates), with Windows' own minimise, maximise and close at the right. The name no longer appears twice.
- **No more flashing.** Screens switch at once instead of fading in from blank, lists keep what they showed last time instead of starting empty, and switching between groups is instant (every group loads in the background).
- **Animations never get in your way.** Nothing freezes while it moves, and clicking somewhere else mid-way simply goes there.
- **The sidebar's highlight slides** to the screen or subject you pick, on a spring, and changes course if you pick something else before it arrives. The phone's tab bar does the same.
- On phones, a note, a settings page or a group slides in from the right and back out, and stays usable while it moves.

## 0.2.9

- **Fixed: updates on Windows could fail and leave Veyra unable to open.** Versions 0.2.6 to 0.2.8 accidentally included some Android files buried so deep that Windows couldn't move them during an update ("Failed to uninstall old application files" or "Veyra Study cannot be closed"), and since Veyra installs waiting updates as it starts, it could get stuck there. The files are gone, the installer now clears them out of older versions and closes any copy of Veyra still running in the tray, and if an update ever fails to install, Veyra opens as it was and says so in Settings → Software update instead of trying again every time.
- **Fixed on Android: deleting didn't work.** Deleting a task, note or subject on the phone was quietly undone. It sticks now.
- **Swipe tasks on your phone:** right to tick one off, left to delete it (with Undo). The row follows your finger, resists past the end, and a quick flick is enough.
- **Date and time pickers that match Veyra:** a month calendar with Today, Tomorrow and Next week, and a time list you can also type into ("7:45 pm"). For due dates, reminders, group deadlines and reminder times in Settings.
- **Smoother movement:** screens crossfade into each other; on the phone, notes, settings pages and groups slide in from the right and back out; dialogs, sheets and the search box sink away when closed instead of vanishing.

## 0.2.8

- **Drop-downs that match Veyra.** Every drop-down (text style, subject, repeat, sort, settings) is now Veyra's own instead of the system one, which showed a white list with faint text in dark mode. On the computer it springs open under the button with a tick by your choice; arrow keys, typing a letter, Enter and Esc all work. On phones it's a sheet from the bottom that you can swipe away.
- **Motion that feels physical.** Animations now follow real spring curves: dialogs rise in, menus spring out from where they open, the chosen segment in switches like Open / Done / All slides across, toggles stretch as you press them, and ticking a task off pops the check in.
- **Press feedback everywhere.** Buttons, chips, menu rows and list rows give a little as you press them.

## 0.2.7

- **Search everything with Ctrl+K.** One box finds notes (every word in them), tasks and their steps, subjects, screens and settings, and runs actions: new task or note, start or pause the focus timer, change the theme. If what you type isn't there, it offers to make it a task or a note. On the computer there's also a Search button at the top of the sidebar; on phones it's at the top of More.
- **Steps inside tasks.** Break a task into smaller steps in its editor (Enter adds the next one, Alt+↑/↓ reorders). The list shows how many are done, like 2/4, and you can tick steps right there without opening the task. When the last step is done, Veyra offers to tick off the whole task.
- **Repeating tasks.** Every day, every weekday, every week, every 2 weeks, every month, every year, or your own rule (for example every 2 weeks on Monday and Thursday). Ticking one off makes the next one, with its reminder moved along and its steps unticked. Unticking it takes the new one back.
- **A trash for notes.** Deleting a note moves it to Notes → Trash, where it waits 30 days before it's gone, so you can restore it. You can also delete it for good or empty the trash.
- **Notes search looks through whole notes,** not just the title and first lines, and shows where your words appear.
- AI apps (MCP) can add steps and repeats to tasks, and ticking off a repeating task there carries the series on too.
- Older copies of Veyra on your other devices show notes in the trash as normal notes, and don't make the next repeating task when you tick one off there, until they update.

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

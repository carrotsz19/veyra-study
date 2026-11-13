# Dev and Prod

Veyra Study comes in two builds:

| | **Prod: Veyra Study** | **Dev: Veyra Study Dev** |
|---|---|---|
| Who | Everyone | You, for trying changes first |
| Windows | `app.veyra.study`, "Veyra Study" | `app.veyra.study.dev`, "Veyra Study Dev" (DEV badge, violet dot on the taskbar icon) |
| Android | `app.veyra.study`, "Veyra Study" | `app.veyra.study.dev`, "Veyra Dev" |
| Data on the device | `%APPDATA%\veyra-study` | `%APPDATA%\veyra-study-dev` (its own) |
| Updates from | Public releases (`v<version>`, `android-v<version>`) | The private repo **carrotsz19/veyra-study-dev** only |
| Who can see the builds | Everyone | Only you (a private repo) |
| Account | Your account | Your account too, with a warning: a test build's changes sync to your real data |

The two install side by side; neither ever updates into the other.

`npm run dev` (running the code directly) counts as Dev as well: it uses `veyra-study-dev`, so it never touches the real app's data.

## Trying a change: a Dev build

```
npm run release:dev
```

- No version bump or changelog needed, and uncommitted work is fine.
- It builds Windows and Android as version `<next version>-dev.<date and time>` and publishes them as a release in the **private** repo carrotsz19/veyra-study-dev (the newest 10 are kept).
- Installed Dev apps pick it up by themselves (Windows at its next check; Android in Settings → Software update).
- `--windows-only` skips Android.
- First install: `Veyra-Study-Dev-Setup.exe` and `Veyra-Study-Dev.apk` from https://github.com/carrotsz19/veyra-study-dev/releases (sign in to GitHub to see it).
- Dev apps read that private repo with a **read-only token for that one repo**, kept outside the code at `C:\dev\tools\veyra-dev-feed.token` and built into Dev builds only (never Prod). If it ever leaks, delete it on GitHub (Settings → Developer settings → Fine-grained tokens), make a new one, save it to that file, and run `npm run release:dev` again; Dev apps already installed then need the new installer once.

## Shipping: a Prod release

Only when the owner says to ship. Everyday changes go out as Dev builds.

1. Bump `"version"` in `package.json` (1.0.0 → 1.0.1).
2. Add a `## 1.0.1` section to `CHANGELOG.md`. It becomes the release notes and the "What's new" in the app.
3. Commit.
4. `npm run release` publishes Windows (`v1.0.1`, marked Latest).
5. `npm run release:android` publishes Android (`android-v1.0.1`, a pre-release, so the Windows updater ignores it).

Both refuse to run with uncommitted changes, or for a version that's already out.

## Rules that keep Prod safe

- Android releases are always pre-releases, and "Latest" on GitHub is always the Windows Prod release.
- Dev never reads the public releases, and Prod never reads the private test-build repo.
- Every APK is signed with the same key (`C:\dev\tools\veyra-signing.keystore`), so updates install over the last version. Back it up.

## When a version turns out bad: rolling back

Installed apps only move up a version. Windows follows the newest release, and Android won't install a lower version over a higher one. So a rollback re-publishes the good version's code under a **new, higher** version number, and every device moves to it through its normal update, Windows and Android alike.

```
npm run rollback -- 1.0.0              # Prod: v1.0.0's code goes out as the next version (e.g. 1.0.2 after a bad 1.0.1)
npm run rollback:dev -- <commit|tag>   # Dev: that commit goes out as a new Dev build
```

- **Prod is a release:** run it only when the owner says to.
  - It builds in a separate checkout next to this folder (`../veyra-rollback-<version>`) and pushes a branch `rollback/<version>`.
  - It publishes Windows (`v<next>`, Latest) and Android (`android-v<next>`), each with a changelog note.
  - It then moves `package.json` here to `<next>`, so the fixed release is numbered above the rollback.
- **Data:** older versions keep the fields they don't know about when they save (for example a note's folder), and they ignore record kinds they don't know. A rolled-back device doesn't damage newer data.
  - Keep it that way: always save records as `{ ...old.data, ...changes }`.
  - Never raise the phone's IndexedDB version (`indexedDB.open(name, 1)` in `src/mobile/idb.ts`). An older build can't open a database with a higher version, so a rollback would leave the phone app unable to load its data.
- **Upgrading again** after a rollback is an ordinary release: bump past the rollback's number, add the changelog section, run `npm run release` and then `npm run release:android`.
- **One device by hand:**
  - Windows: install any version's `Veyra-Study-Setup-<version>.exe` from the Releases page.
  - Android: you can't install an older APK over a newer one. Use a rollback release, or uninstall first. Uninstalling deletes the phone's data unless it's synced.

## How installed apps find a new version

- **Windows:** GitHub's newest full release (`releases/latest`) and its `latest.yml`.
- **Android:** GitHub's list of releases, falling back to the releases feed (`releases.atom`).
  - The feed shows only **one tag per commit**, and `v<version>` and `android-v<version>` would otherwise share one, so the Android tag was left out. That's why 0.2.x phones never saw 1.0.0.
  - `release:android` therefore puts the Android tag on a commit of its own, with the same files.

## The website

The phone app's code built for a browser (`mobile/vite.config.ts` with `VEYRA_WEB=1`), served by a Cloudflare Worker that only hosts the files.

```
npm run release:web:dev   # https://veyra-study-dev.igreenrobotz.workers.dev  (test site)
npm run release:web       # https://veyra-study-web.igreenrobotz.workers.dev  (Prod: only when the owner says so)
```

- **Sign-in, groups and sync:** the Worker (`web/worker.js`) passes them through the site's own address, because the account service only answers the apps.
  - **Sessions:** the Veyra session cookies stay in a token that only that Worker can decrypt, using the secret `WEB_SESSION_KEY`.
    - The publish script creates the secret once per site and pipes it straight into Cloudflare, so it's never shown.
    - If it's replaced, people on the website just sign in again.
  - **Connections:** the account service and the relay are reached through service bindings, and the group server through the relay's current address.
  - **Passwords:** the page hashes them before sending, except an account's first sign-in under the old password format, which sends the password once so the service can upgrade it. The Worker never stores or logs request bodies.
  - **Other websites:** requests from other sites, and any account request beyond the five the app uses, are refused.
  - **Limits:** each open tab long-polls the group server through the Worker, about 2,000 requests a day per tab. The free plan allows 100,000 a day.
- **The Dev feed token is never in the site:** web builds leave it out, and the script refuses to publish if it finds it.
- **Wrangler runs from a temporary folder.** Run inside this repo, it changes the project by itself (it adds packages, npm scripts, `vite.config.ts` and `wrangler.jsonc`).
- **Going back:** run `npx wrangler rollback --name veyra-study-dev`, pick an older deployment in the Cloudflare dashboard, or run the script from an older commit. The site is always whatever was published last, so there is nothing to update on people's devices.

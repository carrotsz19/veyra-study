# Dev and Prod

Veyra Study comes in two builds:

| | **Prod: Veyra Study** | **Dev: Veyra Study Dev** |
|---|---|---|
| Who | Everyone | You, for trying changes first |
| Branch & repo | `main` on **carrotsz19/veyra-study** (`origin`) | `main` on **carrotsz19/veyra-study-dev** (`dev-repo`), tracked locally as `dev` |
| Windows | `app.veyra.study`, "Veyra Study" | `app.veyra.study.dev`, "Veyra Study Dev" (DEV badge, violet dot on the taskbar icon) |
| Android | `app.veyra.study`, "Veyra Study" | `app.veyra.study.dev`, "Veyra Dev" |
| Data on the device | `%APPDATA%\veyra-study` | `%APPDATA%\veyra-study-dev` (its own) |
| Updates from | Public releases (`v<version>`, `android-v<version>`) | The private repo **carrotsz19/veyra-study-dev** only |
| Who can see the builds | Everyone | Only you (a private repo) |
| Account | Your account | Your account too, with a warning: a test build's changes sync to your real data |

The two install side by side; neither ever updates into the other.

`npm run dev` (running the code directly) counts as Dev as well: it uses `veyra-study-dev`, so it never touches the real app's data.

## Publishing flow (two-repo PR pipeline)

Changes move through two PR gates enforced by `tools/channels.mjs`:

```
feature branch ──(npm run pr:dev)──▶ carrotsz19/veyra-study-dev (main)
                                            │ merge PR, then npm run sync:dev
                                            ▼
                              Dev builds (npm run release:dev + release:web:dev)
                                            │ after testing & verification
                                            ▼
carrotsz19/veyra-study (dev) ──(npm run pr:prod)──▶ carrotsz19/veyra-study (main)
                                                           │ merge PR (owner says ship)
                                                           ▼
                                             Prod builds (npm run ship + release:web)
```

- **Enforced branch guards (`tools/channels.mjs`):**
  - Dev build scripts (`release:dev`, `release:web:dev`, `release:android -- --dev`) refuse to run on `main`, and by default require a clean `dev` branch synced with `carrotsz19/veyra-study-dev` `main` (so only accepted Dev PRs publish). Use `--local` for a one-off unmerged local experiment (still never from `main`), or `--pick` / `--ref` / `--commits` to build in an isolated temp worktree.
  - Prod scripts (`ship`, `release`, `release:android`, `release:web`) refuse to run anywhere except a clean `main` branch synced with `carrotsz19/veyra-study` `main`.

## Trying a change: a Dev build

1. Work on a feature branch off `dev` (`git checkout -b feat/my-change dev`), commit, and open a PR into `carrotsz19/veyra-study-dev` `main`:
   ```
   npm run pr:dev
   ```
2. Once the PR is accepted and merged into `carrotsz19/veyra-study-dev` `main`, sync `dev` and publish Dev builds:
   ```
   npm run sync:dev
   git checkout dev
   npm run release:dev          # Windows + Android → carrotsz19/veyra-study-dev
   npm run release:web:dev      # Dev website → veyra-study-dev.igreenrobotz.workers.dev
   ```
3. You can also build a specific commit, branch, Dev PR, or cherry-picked set in an isolated temp worktree without disturbing your checkout:
   ```
   npm run release:dev:pick                         # interactive picker
   npm run release:dev -- --ref <sha|branch|pr#12>  # specific commit, branch, or PR
   npm run release:dev -- --commits <a,b> --base dev-repo/main  # cherry-pick commits
   npm run release:dev -- --local                   # local uncommitted/unmerged experiment (never from main)
   ```

- No version bump or changelog needed for Dev builds.
- Windows and Android are published atomically as `<next version>-dev.<date and time>` in the **private** repo `carrotsz19/veyra-study-dev` (created as a draft until both Windows and Android are uploaded, then published as Latest; the newest 20 are kept).
- Installed Dev apps pick it up by themselves (Windows at its next check; Android in Settings → Software update), and **Settings → Software update → Dev builds** lets you switch between any of the published Dev builds by commit (switching to an older build on Windows pins automatic updates until you click **Follow latest**).
- `--windows-only` skips Android; `--web` also deploys the Dev website from the same selection; `--label "Billing rework"` adds a friendly name shown in the Dev build switcher.
- First install: `Veyra-Study-Dev-Setup.exe` and `Veyra-Study-Dev.apk` from https://github.com/carrotsz19/veyra-study-dev/releases (sign in to GitHub to see it).
- Dev apps read that private repo with a **read-only token for that one repo**, kept outside the code at `C:\dev\tools\veyra-dev-feed.token` and built into Dev builds only (never Prod). If it ever leaks, delete it on GitHub (Settings → Developer settings → Fine-grained tokens), make a new one, save it to that file, and run `npm run release:dev` again; Dev apps already installed then need the new installer once.

## Shipping: a Prod release

Only after testing and verifying Dev builds, and only when the owner says to ship.

1. Open the promotion PR from verified `carrotsz19/veyra-study-dev` `main` into `carrotsz19/veyra-study` `main` (mirrors verified `dev-repo/main` to `origin/dev` and opens `dev → main` on `carrotsz19/veyra-study`):
   ```
   npm run pr:prod
   ```
2. Once the PR is accepted and merged into `carrotsz19/veyra-study` `main`, switch to `main`, pull, and ship:
   ```
   git checkout main && git pull
   npm run ship
   npm run release:web
   ```

That's all. It:

1. Picks the next version itself. Versions are **year.month.release-in-that-month**: 26.11.1, 26.11.2, …, then 26.12.1 in December and 27.1.1 next year (`tools/version.mjs`). They count as newer than the old 1.0.x numbers, so installed apps update as usual.
2. Turns the `## Unreleased` section of `CHANGELOG.md` into that version's section, which becomes the release notes and the "What's new" in the app. With no Unreleased section, it lists the commit titles since the last release instead.
3. Sets the version in `package.json`, commits `Veyra Study <version>` and pushes.
4. Publishes Windows (`npm run release`: `v<version>`, marked Latest), then Android (`npm run release:android`: `android-v<version>`, a pre-release, so the Windows updater ignores it).

- `npm run ship -- --dry-run` shows the version and notes without changing anything.
- `npm run ship -- --windows-only` skips Android.
- It refuses to run with uncommitted changes, or when the branch is behind origin.
- If a step fails after the version commit is pushed, fix it and run `npm run release` / `npm run release:android` again: they publish the version already in `package.json`.
- Android's version code is yy·1000000 + month·10000 + n (26.11.1 → 26110001).

## Rules that keep Prod safe

- Android releases are always pre-releases, and "Latest" on GitHub is always the Windows Prod release.
- Dev never reads the public releases, and Prod never reads the private test-build repo.
- Every APK is signed with the same key (`C:\dev\tools\veyra-signing.keystore`), so updates install over the last version. Back it up.

## When a version turns out bad: rolling back

Installed apps only move up a version. Windows follows the newest release, and Android won't install a lower version over a higher one. So a rollback re-publishes the good version's code under a **new, higher** version number, and every device moves to it through its normal update, Windows and Android alike.

```
npm run rollback -- 26.11.1            # Prod: v26.11.1's code goes out as the next version (e.g. 26.11.3 after a bad 26.11.2)
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

## VirusTotal scans

- `npm run release` and `npm run release:android` scan the installer and the APK on VirusTotal after publishing. They add a "VirusTotal" section to the release notes, with a link, the number of engines that flagged the file, and its SHA-256.
- The API key lives in `C:\dev\tools\virustotal.key`, outside the repo, or in `VIRUSTOTAL_KEY`. Without a key the scan is skipped, and a failed scan never stops a release.
- **To scan again by hand:** `node tools/virustotal.mjs <tag> <file>`. Running it again replaces the section rather than adding a second one.

## Code signing (Windows)

Smart App Control and school/work PC policies block unsigned compiled files, and Veyra's
`.exe` is new to Windows, so it has no reputation to fall back on. Signing fixes that.

**Check on every release:** `tools/native-check.mjs` runs before anything is published. Unsigned,
it only allows Electron's own files, so a new native dependency can't slip in. Signed, it requires
every `.exe`/`.dll` to be signed.

**Setting up Azure Trusted Signing (once):**
1. In Azure: create a Trusted Signing account, complete identity validation, and create a
   *Public Trust* certificate profile.
2. Create an Entra app registration with a client secret, and give it the
   *Trusted Signing Certificate Profile Signer* role on the account.
3. Put its sign-in in `C:\dev\tools\azure-signing.json` (never in the repo):
   `{ "tenantId": "…", "clientId": "…", "clientSecret": "…" }`
4. Commit `build/signing.json` (nothing secret):
   `{ "publisherName": "<the name on the certificate, exactly>", "endpoint": "https://<region>.codesigning.azure.net", "codeSigningAccountName": "…", "certificateProfileName": "…" }`
5. Release Dev first and check the installer: right-click → Properties → Digital Signatures.

From then on, every release (Dev, Prod and rollbacks) is signed: the installer, the app and Electron's
DLLs. **There's no going back:** signed apps check that each update is signed by the same
publisher, so with `build/signing.json` in place a release without the sign-in stops instead of
going out unsigned. Keep the client secret renewed before it expires.

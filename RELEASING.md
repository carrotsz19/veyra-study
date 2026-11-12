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

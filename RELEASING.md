# Dev and Prod

Veyra Study comes in two builds:

| | **Prod: Veyra Study** | **Dev: Veyra Study Dev** |
|---|---|---|
| Who | Everyone | You, for trying changes first |
| Windows | `app.veyra.study`, "Veyra Study" | `app.veyra.study.dev`, "Veyra Study Dev" (DEV badge, violet dot on the taskbar icon) |
| Android | `app.veyra.study`, "Veyra Study" | `app.veyra.study.dev`, "Veyra Dev" |
| Data on the device | `%APPDATA%\veyra-study` | `%APPDATA%\veyra-study-dev` (its own) |
| Updates from | Public releases (`v<version>`, `android-v<version>`) | The `dev-latest` pre-release only |
| Account | Your account | Your account too, with a warning: a test build's changes sync to your real data |

The two install side by side; neither ever updates into the other.

`npm run dev` (running the code directly) counts as Dev as well: it uses `veyra-study-dev`, so it never touches the real app's data.

## Trying a change: a Dev build

```
npm run release:dev
```

- No version bump or changelog needed, and uncommitted work is fine.
- It builds Windows and Android as version `<next version>-dev.<date and time>` and replaces the files on the `dev-latest` pre-release.
- Installed Dev apps pick it up by themselves (Windows at its next check; Android in Settings → Software update).
- `--windows-only` skips Android.
- First install: `Veyra-Study-Dev-Setup.exe` and `Veyra-Study-Dev.apk` from https://github.com/carrotsz19/veyra-study/releases/tag/dev-latest

## Shipping: a Prod release

1. Bump `"version"` in `package.json` (0.2.13 → 0.2.14).
2. Add a `## 0.2.14` section to `CHANGELOG.md`. It becomes the release notes and the "What's new" in the app.
3. Commit.
4. `npm run release` publishes Windows (`v0.2.14`, marked Latest).
5. `npm run release:android` publishes Android (`android-v0.2.14`, a pre-release, so the Windows updater ignores it).

Both refuse to run with uncommitted changes, or for a version that's already out.

## Rules that keep Prod safe

- Android releases are always pre-releases, and "Latest" on GitHub is always the Windows Prod release.
- Dev never reads the public releases, and Prod never reads `dev-latest`.
- Every APK is signed with the same key (`C:\dev\tools\veyra-signing.keystore`), so updates install over the last version. Back it up.

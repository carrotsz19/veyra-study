# Working rules

The owner's standing rules for anyone (people or AI assistants) changing Veyra Study.
They apply to every change unless the owner says otherwise for that one change.
How releases work step by step is in [RELEASING.md](RELEASING.md).

## Releases

1. **Dev by default.** Every finished change goes out as a Dev build only:
   `npm run release:dev` (Windows and Android) and `npm run release:web:dev` (the Dev website).
2. **Prod only when the owner says so**, in words like "push to prod" or "ship it". A yes for one
   release doesn't cover the next one. Prod is `npm run ship` (Windows and Android), then
   `npm run release:web` (the website is separate).
3. **Never set a version by hand.** Versions are date-based (year.month.n, e.g. 26.11.2) and
   `npm run ship` picks them.
4. **Write the release notes as you go:** user-facing changes go under `## Unreleased` in
   [CHANGELOG.md](CHANGELOG.md), in plain words.
5. **Server first.** When an app change needs a newer group server, put that server on the phone
   and check its version before releasing the app.

## Commits

6. **No AI attribution:** no `Co-Authored-By: Claude` (or any Claude/Anthropic) line in commits or
   pull requests, even if a tool adds one by default.
7. **Never commit secrets.** This repo is public.

## Secrets: never print, commit or share these

8. `google-client.json`, `server/.env`, everything in `C:\dev\tools\` (tokens, the signing keystore,
   keys) and `WEB_SESSION_KEY`.
9. The Claude API key and the Cloudflare call-relay key live **only** in `~/veyra-group/.env` on the
   server phone: never in the repo or the apps.
10. A secret copied to a phone's Downloads to install it is deleted straight after.

## Other repositories

11. **Don't change `carrotsz19/veyra`** (IronLog and Cashline) or its account Worker. Reading them
    is fine.
12. Keep this repo in `C:\dev\veyra-study`, not in OneDrive.

## Testing

13. **Never test with the real app data** (`%APPDATA%\veyra-study` or `veyra-study-dev`). Use a
    scratch profile (`VEYRA_USERDATA=<scratch folder>`) and a mock server, and rebuild first.
14. **Never create accounts or sign up on production**, and never try passwords on real usernames.
    Ask before using staging.
15. **Security testing only against a local test server.**
16. **Don't run `electron-vite build` while the owner's `npm run dev` is running** (check first).
    Build test copies to `out-test` instead.
17. **Never run Wrangler inside this repo.**
18. **No real paid API calls** (e.g. Claude) without the owner's OK.

## Devices

19. **Don't operate the owner's everyday phone.**
20. **The server phone (Galaxy A54) has no lock code: unlock it yourself.** Deploying the group server
    to it is fine without asking. Wake it, swipe up, do the work in Termux, then put it back to sleep.

## The group server

21. **Server changes must be additive:** older Prod apps use the same server, so nothing they rely
    on may change or go away.
22. The server sleeps from about 12 am to 8 am. Group work, sync, Veyra AI and voice are off then.

## Privacy

23. **Don't open the owner's personal documents.**
24. **AI chat sync stays end-to-end encrypted.** The owner must never be able to read students' chats.

## Settled decisions (don't re-open unless the owner does)

25. **Code signing:** the Windows app stays unsigned for now. Don't bring signing up again.
26. **Google Drive for the Assistant** is opt-in (Settings → Connections) and uses `drive.readonly`.
27. **Voice-call relay cap:** 600 GB a month (`VOICE_CAP_GB` on the server). Past it, voice
    pauses until the 1st.
28. **Veyra AI budget:** about $100 a month for up to ~20 people. New AI features roll out to the
    owner first.

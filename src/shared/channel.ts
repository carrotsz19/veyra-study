/**
 * Which Veyra this is.
 *  - prod: the real app your users get (npm run release, npm run release:android).
 *  - dev: "Veyra Study Dev", test builds that install next to the real app, with
 *    their own name, data and update channel (npm run release:dev). Running the
 *    code with npm run dev counts as dev too, so it never touches the real data.
 * Set at build time from VEYRA_CHANNEL (electron.vite.config.ts, mobile/vite.config.ts).
 */
declare const __CHANNEL__: 'prod' | 'dev'
export const CHANNEL: 'prod' | 'dev' = typeof __CHANNEL__ !== 'undefined' && __CHANNEL__ === 'dev' ? 'dev' : 'prod'
export const IS_DEV = CHANNEL === 'dev'
export const APP_NAME = IS_DEV ? 'Veyra Study Dev' : 'Veyra Study'
/** Where Dev builds are published: one GitHub pre-release whose files are replaced each time. */
export const DEV_RELEASE = 'https://github.com/carrotsz19/veyra-study/releases/download/dev-latest'

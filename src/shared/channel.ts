/**
 * Which Veyra this is.
 *  - prod: the real app your users get (npm run release, npm run release:android).
 *  - dev: "Veyra Study Dev", test builds that install next to the real app, with
 *    their own name, data and update channel (npm run release:dev). Running the
 *    code with npm run dev counts as dev too, so it never touches the real data.
 * Set at build time from VEYRA_CHANNEL (electron.vite.config.ts, mobile/vite.config.ts).
 */
declare const __CHANNEL__: 'prod' | 'dev'
/** Dev builds only: a read-only token for the private repo the test builds live in (empty in Prod). */
declare const __DEV_FEED_TOKEN__: string

export const CHANNEL: 'prod' | 'dev' = typeof __CHANNEL__ !== 'undefined' && __CHANNEL__ === 'dev' ? 'dev' : 'prod'
export const IS_DEV = CHANNEL === 'dev'
/** The website build (mobile/vite.config.ts with VEYRA_WEB=1): the phone app's code, in a browser. */
declare const __WEB__: boolean
export const ON_WEB = typeof __WEB__ !== 'undefined' && __WEB__ === true
export const APP_NAME = IS_DEV ? 'Veyra Study Dev' : 'Veyra Study'

/**
 * Test builds are releases in a private GitHub repo, so only you see them. Dev
 * apps read it with a token that can only read that one repo
 * (C:\dev\tools\veyra-dev-feed.token, put in at build time; never in Prod).
 */
export const DEV_REPO = { owner: 'carrotsz19', repo: 'veyra-study-dev' }
export const DEV_FEED_TOKEN = IS_DEV && typeof __DEV_FEED_TOKEN__ !== 'undefined' ? __DEV_FEED_TOKEN__ : ''

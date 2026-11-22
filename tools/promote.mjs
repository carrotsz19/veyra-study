#!/usr/bin/env node
/**
 * Promotion & PR helpers for Veyra Study's two-repo publishing scheme:
 *
 *   npm run pr:dev    (node tools/promote.mjs dev)
 *     Pushes the current feature branch to carrotsz19/veyra-study-dev and opens a PR into its `main`.
 *     Once merged, run `npm run sync:dev`, then publish Dev builds (`npm run release:dev`, `npm run release:web:dev`).
 *
 *   npm run sync:dev  (node tools/promote.mjs sync-dev)
 *     Fast-forwards local `dev` to carrotsz19/veyra-study-dev `main` and mirrors it to origin/dev.
 *
 *   npm run pr:prod   (node tools/promote.mjs prod)
 *     After Dev builds are tested and verified, mirrors carrotsz19/veyra-study-dev `main` onto
 *     carrotsz19/veyra-study `dev` and opens a PR `dev -> main` on carrotsz19/veyra-study.
 *     Once merged (and when the owner says to ship), switch to `main`, pull, and run `npm run ship` + `npm run release:web`.
 */
import { execFileSync } from 'node:child_process'
import { DEV_BRANCH, DEV_REPO, PROD_BRANCH, PROD_REPO, ensureDevRemote, ensureProdRemote } from './channels.mjs'

const cmd = process.argv[2]
const rest = process.argv.slice(3)
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const gitInherit = (args) => execFileSync('git', args, { stdio: 'inherit' })
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' }).trim()

function readFlag(flag) {
  const i = rest.indexOf(flag)
  if (i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--')) return rest[i + 1]
  const eq = rest.find((a) => a.startsWith(`${flag}=`))
  return eq ? eq.slice(flag.length + 1) : ''
}

const draft = rest.includes('--draft')
const customTitle = readFlag('--title')
const customBody = readFlag('--body')

function existingPr(repo, head, base) {
  try {
    const raw = gh(['pr', 'list', '--repo', repo, '--state', 'open', '--head', head, '--base', base, '--json', 'number,url,title'])
    const list = JSON.parse(raw || '[]')
    return list[0] ?? null
  } catch {
    return null
  }
}

function openDevPr() {
  const branch = git(['symbolic-ref', '--short', 'HEAD'])
  if (!branch || branch === DEV_BRANCH || branch === PROD_BRANCH) {
    console.error(`Switch to a feature branch first (currently on '${branch || 'detached HEAD'}').\nExample: git checkout -b feat/my-change ${DEV_BRANCH}`)
    process.exit(1)
  }
  const trackedDirty = git(['status', '--porcelain', '-uno'])
  if (trackedDirty) {
    console.error(`Commit your changes first before opening a PR to Dev:\n${trackedDirty}`)
    process.exit(1)
  }

  const devRemote = ensureDevRemote()
  console.log(`Fetching ${DEV_REPO} main…`)
  gitInherit(['fetch', '--no-tags', devRemote, 'main'])

  const ahead = Number(git(['rev-list', '--count', `${devRemote}/main..HEAD`]) || 0)
  if (ahead === 0) {
    console.error(`Branch '${branch}' has no new commits ahead of ${DEV_REPO} main.`)
    process.exit(1)
  }

  console.log(`Pushing '${branch}' to ${DEV_REPO} (${devRemote})…`)
  gitInherit(['push', '-u', devRemote, branch])

  const found = existingPr(DEV_REPO, branch, 'main')
  if (found) {
    console.log(`\nPR already open on ${DEV_REPO} (#${found.number}): ${found.url}`)
  } else {
    const args = ['pr', 'create', '--repo', DEV_REPO, '--base', 'main', '--head', branch]
    if (draft) args.push('--draft')
    if (customTitle || customBody) {
      args.push('--title', customTitle || git(['log', '-1', '--format=%s']))
      args.push('--body', customBody || `Merges \`${branch}\` (${ahead} commit${ahead === 1 ? '' : 's'}) into ${DEV_REPO} \`main\` for Dev build testing.`)
    } else {
      args.push('--fill')
    }
    const url = gh(args)
    console.log(`\nOpened Dev PR on ${DEV_REPO}: ${url}`)
  }
  console.log(`\nNext steps:\n  1. Review and merge the PR into ${DEV_REPO} main.\n  2. Run: npm run sync:dev\n  3. Publish Dev builds: npm run release:dev  and  npm run release:web:dev`)
}

function syncDev() {
  const devRemote = ensureDevRemote()
  const prodRemote = ensureProdRemote()
  console.log(`Fetching ${DEV_REPO} main and ${PROD_REPO} main…`)
  gitInherit(['fetch', '--no-tags', devRemote, 'main'])
  gitInherit(['fetch', prodRemote, 'main', 'dev'])

  const cur = git(['symbolic-ref', '--short', 'HEAD'])
  if (cur === DEV_BRANCH) {
    const trackedDirty = git(['status', '--porcelain', '-uno'])
    if (trackedDirty) {
      console.error(`Working tree on '${DEV_BRANCH}' has uncommitted changes. Commit or stash them before syncing:\n${trackedDirty}`)
      process.exit(1)
    }
    gitInherit(['merge', '--ff-only', `${devRemote}/main`])
  } else {
    // Update local `dev` ref without leaving the current branch when fast-forwardable.
    gitInherit(['fetch', '--no-tags', devRemote, `main:${DEV_BRANCH}`])
  }

  console.log(`Mirroring ${DEV_REPO} main to ${PROD_REPO} (${prodRemote}/${DEV_BRANCH})…`)
  gitInherit(['push', prodRemote, `${devRemote}/main:refs/heads/${DEV_BRANCH}`])
  const sha = git(['rev-parse', '--short', `${devRemote}/main`])
  console.log(`\nSynced: local '${DEV_BRANCH}', ${prodRemote}/${DEV_BRANCH}, and ${DEV_REPO} main are all at ${sha}.`)
}

function openProdPr() {
  const devRemote = ensureDevRemote()
  const prodRemote = ensureProdRemote()
  console.log(`Fetching ${DEV_REPO} main and ${PROD_REPO} main…`)
  gitInherit(['fetch', '--no-tags', devRemote, 'main'])
  gitInherit(['fetch', prodRemote, 'main'])

  const behindProd = Number(git(['rev-list', '--count', `${devRemote}/main..${prodRemote}/main`]) || 0)
  if (behindProd > 0) {
    console.error(
      `${DEV_REPO} main is ${behindProd} commit(s) behind ${PROD_REPO} main (for example, a Prod version bump commit).\nMerge ${prodRemote}/main into a branch and open a PR into ${DEV_REPO} main first so the promotion PR is a clean fast-forward.`
    )
    process.exit(1)
  }

  const ahead = Number(git(['rev-list', '--count', `${prodRemote}/main..${devRemote}/main`]) || 0)
  if (ahead === 0) {
    console.error(`${DEV_REPO} main has no new commits ahead of ${PROD_REPO} main. Nothing to promote to Prod.`)
    process.exit(1)
  }

  // GitHub does not allow cross-repo PRs from a private repo to a public repo,
  // so mirror verified Dev main onto origin/dev and open dev -> main on carrotsz19/veyra-study.
  console.log(`Syncing verified ${DEV_REPO} main onto ${PROD_REPO} (${prodRemote}/${DEV_BRANCH})…`)
  gitInherit(['push', prodRemote, `${devRemote}/main:refs/heads/${DEV_BRANCH}`])

  const found = existingPr(PROD_REPO, DEV_BRANCH, PROD_BRANCH)
  if (found) {
    console.log(`\nProd promotion PR already open on ${PROD_REPO} (#${found.number}): ${found.url}`)
  } else {
    const subjects = git(['log', '--no-merges', '--format=- %h %s', `${prodRemote}/main..${devRemote}/main`])
    const sha = git(['rev-parse', '--short', `${devRemote}/main`])
    const title = customTitle || `Promote verified Dev (${sha}) to Prod`
    const body =
      customBody ||
      [
        `Promotes verified changes from \`${DEV_REPO}\` \`main\` (\`${sha}\`) into \`${PROD_REPO}\` \`main\`.`,
        '',
        '## Included commits',
        subjects || `- \`${sha}\``,
        '',
        '## After merging',
        '1. Switch to `main` and pull (`git checkout main && git pull`).',
        '2. When ready to ship Prod, run `npm run ship` and `npm run release:web`.'
      ].join('\n')
    const args = ['pr', 'create', '--repo', PROD_REPO, '--base', PROD_BRANCH, '--head', DEV_BRANCH, '--title', title, '--body', body]
    if (draft) args.push('--draft')
    const url = gh(args)
    console.log(`\nOpened Prod promotion PR on ${PROD_REPO}: ${url}`)
  }
  console.log(`\nNext steps:\n  1. Review and merge the PR into ${PROD_REPO} main.\n  2. Switch to main & pull: git checkout main && git pull\n  3. Ship Prod when ready: npm run ship  and  npm run release:web`)
}

if (cmd === 'dev') openDevPr()
else if (cmd === 'sync-dev') syncDev()
else if (cmd === 'prod') openProdPr()
else {
  console.error('Usage:\n  npm run pr:dev      # push feature branch and open PR to carrotsz19/veyra-study-dev main\n  npm run sync:dev    # sync local dev & origin/dev with carrotsz19/veyra-study-dev main\n  npm run pr:prod     # promote verified Dev main via PR to carrotsz19/veyra-study main')
  process.exit(1)
}

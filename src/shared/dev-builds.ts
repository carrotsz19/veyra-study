/**
 * Metadata and helpers for Veyra Study Dev test builds (carrotsz19/veyra-study-dev).
 *
 * Each Dev release embeds a small JSON marker at the end of its GitHub release body
 * (invisible on GitHub, returned in the single `/releases` list call so the in-app
 * Dev build switcher never needs per-release extra requests). Older Dev releases
 * without the marker are parsed gracefully from their "Test build from <sha>" line.
 */

export interface DevCommitInfo {
  sha: string
  subject: string
}

export interface DevBuildMeta {
  version: string
  tag?: string
  commit: string
  fullCommit?: string
  branch?: string
  label?: string
  dirty?: boolean
  base?: string
  commits?: DevCommitInfo[]
  createdAt?: string
}

export interface DevReleaseLike {
  tag_name: string
  name?: string | null
  body?: string | null
  published_at?: string | null
  created_at?: string | null
  draft?: boolean
  assets?: { name: string; url?: string; browser_download_url?: string }[]
}

export interface ParsedDevBuild {
  tag: string
  version: string
  publishedAt: string
  commit?: string
  branch?: string
  label?: string
  dirty?: boolean
  commits?: DevCommitInfo[]
  notes: string
  hasWindows: boolean
  hasAndroid: boolean
  current: boolean
}

const META_OPEN = '<!-- veyra-dev-meta:'
const META_CLOSE = ' -->'
const META_RE = /<!--\s*veyra-dev-meta:(\{[\s\S]*?\})\s*-->/

/** Encodes build metadata into an HTML comment safe to append to GitHub release notes. */
export function formatDevMetaComment(meta: DevBuildMeta): string {
  const safe = JSON.stringify(meta).replace(/-->/g, '--\\u003e')
  return `${META_OPEN}${safe}${META_CLOSE}`
}

/** Strips the hidden metadata comment from release notes shown to humans. */
export function stripDevMetaComment(body: string): string {
  return body.replace(META_RE, '').trim()
}

/** Extracts structured metadata from a Dev release body, falling back to legacy note parsing. */
export function parseDevMeta(body: string | null | undefined): Partial<DevBuildMeta> {
  const text = String(body ?? '')
  const m = META_RE.exec(text)
  if (m) {
    try {
      const parsed = JSON.parse(m[1]) as Partial<DevBuildMeta>
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* fall through to legacy regex */
    }
  }
  const legacy = /Test build from ([0-9a-f]{7,40})( \+ uncommitted changes)?/i.exec(text)
  if (legacy) {
    return {
      commit: legacy[1].slice(0, 7),
      dirty: Boolean(legacy[2])
    }
  }
  return {}
}

/**
 * Compares two Veyra versions (including Dev versions like "26.11.5-dev.202611210145").
 * Returns >0 if `a` is newer than `b`, <0 if older, 0 if equal.
 */
export function compareVeyraVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, rest = ''] = String(v).trim().replace(/^v/, '').split('-', 2)
    const nums = core.split('.').map((x) => parseInt(x, 10) || 0)
    const devStamp = /^dev\.(\d+)/.exec(rest)?.[1] ?? ''
    return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], devStamp, isDev: !!rest }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  }
  if (x.isDev !== y.isDev) return x.isDev ? -1 : 1
  if (x.devStamp !== y.devStamp) return x.devStamp.localeCompare(y.devStamp)
  return a.localeCompare(b)
}

/** Converts a GitHub release object from carrotsz19/veyra-study-dev into a DevBuild record. */
export function parseDevRelease(rel: DevReleaseLike, currentVersion: string): ParsedDevBuild | null {
  if (!rel || rel.draft || !rel.tag_name) return null
  const assets = Array.isArray(rel.assets) ? rel.assets : []
  const hasWindows = assets.some((a) => a.name === 'Veyra-Study-Dev-Setup.exe') && assets.some((a) => a.name === 'latest.yml')
  const hasAndroid = assets.some((a) => a.name === 'Veyra-Study-Dev.apk')
  if (!hasWindows && !hasAndroid) return null

  const meta = parseDevMeta(rel.body)
  const version = meta.version || rel.tag_name.replace(/^dev-/, '')
  const notes = stripDevMetaComment(String(rel.body ?? ''))
  return {
    tag: rel.tag_name,
    version,
    publishedAt: rel.published_at || rel.created_at || meta.createdAt || '',
    commit: meta.commit,
    branch: meta.branch,
    label: meta.label,
    dirty: meta.dirty,
    commits: Array.isArray(meta.commits) ? meta.commits : undefined,
    notes,
    hasWindows,
    hasAndroid,
    current: version === currentVersion
  }
}

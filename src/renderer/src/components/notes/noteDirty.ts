/**
 * Guards against marking a note as "edited" when it was only opened, clicked,
 * spellchecked, or hydrated with identical content.
 */

function isEmptyParagraph(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const n = node as { type?: unknown; content?: unknown; attrs?: Record<string, unknown> }
  if (n.type !== 'paragraph') return false
  if (n.attrs && Object.values(n.attrs).some((v) => v !== null && v !== undefined && v !== 'left')) return false
  return !Array.isArray(n.content) || n.content.length === 0
}

/** True for null/undefined/"" or an empty TipTap document (no content or a single blank paragraph). */
export function isEmptyNoteDoc(doc: unknown): boolean {
  if (doc === null || doc === undefined || doc === '') return true
  if (typeof doc !== 'object') return false
  const d = doc as { type?: unknown; content?: unknown }
  if (d.type !== 'doc') return false
  if (!Array.isArray(d.content) || d.content.length === 0) return true
  return d.content.length === 1 && isEmptyParagraph(d.content[0])
}

/**
 * True when an editor JSON snapshot represents the exact same saved note field,
 * including null/empty-doc equivalence.
 */
export function isSameNoteDoc(prev: unknown, next: unknown): boolean {
  if (prev === next) return true
  if (isEmptyNoteDoc(prev) && isEmptyNoteDoc(next)) return true
  try {
    return JSON.stringify(prev) === JSON.stringify(next)
  } catch {
    return false
  }
}

/**
 * Only treat an editor update as a user edit when the primary transaction itself
 * changed the document — not when a metadata/selection transaction (e.g. spellcheck
 * decorations on open, or clicking into a note) only triggered an appended
 * normalization like TrailingNode or fixTables.
 */
export function shouldSaveEditorUpdate(transaction: { docChanged?: boolean } | null | undefined): boolean {
  return Boolean(transaction?.docChanged)
}

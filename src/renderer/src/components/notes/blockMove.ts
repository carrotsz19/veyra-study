import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'

/** Whether a ProseMirror node is a PDF attachment (can be visually collapsed in notes). */
export function isPdfAttachmentNode(node: PMNode | null | undefined): boolean {
  if (!node || node.type.name !== 'attachment') return false
  const mime = String(node.attrs?.mime ?? '')
  const name = String(node.attrs?.name ?? '')
  return mime === 'application/pdf' || /\.pdf$/i.test(name)
}

/**
 * Finds the target insertion position to move the block at `fromPos` up (`-1`)
 * or down (`1`) by one visible sibling within its parent container.
 * Returns `null` if the block is already at the boundary in that direction.
 */
export function findStepTarget(
  doc: PMNode,
  fromPos: number,
  dir: -1 | 1,
  skipHiddenPdfs = false
): number | null {
  if (fromPos < 0 || fromPos >= doc.content.size) return null
  const node = doc.nodeAt(fromPos)
  if (!node) return null

  const $pos = doc.resolve(fromPos)
  const depth = $pos.depth
  const parent = $pos.parent
  const index = $pos.index(depth)
  if (index < 0 || index >= parent.childCount || parent.child(index) !== node) return null

  const starts: number[] = []
  let cursor = depth === 0 ? 0 : $pos.start(depth)
  for (let i = 0; i < parent.childCount; i++) {
    starts.push(cursor)
    cursor += parent.child(i).nodeSize
  }

  let targetIdx = index + dir
  while (targetIdx >= 0 && targetIdx < parent.childCount) {
    const sibling = parent.child(targetIdx)
    if (!skipHiddenPdfs || !isPdfAttachmentNode(sibling)) {
      return dir === -1 ? starts[targetIdx] : starts[targetIdx] + sibling.nodeSize
    }
    targetIdx += dir
  }

  return null
}

/**
 * Builds a single atomic, undoable transaction moving the block at `fromPos`
 * to the insertion boundary `targetPos` (in the original document's coordinates).
 * Returns `null` if the move is a no-op or would violate the document schema.
 */
export function buildMoveTr(
  state: EditorState,
  fromPos: number,
  targetPos: number
): Transaction | null {
  const doc = state.doc
  if (fromPos < 0 || fromPos >= doc.content.size) return null
  const node = doc.nodeAt(fromPos)
  if (!node) return null

  const fromEnd = fromPos + node.nodeSize
  if (targetPos < 0 || targetPos > doc.content.size) return null
  // Dropping immediately before or after itself is a no-op; dropping inside itself is invalid.
  if (targetPos >= fromPos && targetPos <= fromEnd) return null

  const $target = doc.resolve(targetPos)
  if (!$target.parent.canReplaceWith($target.index(), $target.index(), node.type)) return null

  const $from = doc.resolve(fromPos)
  const tr = state.tr
  const paragraph = state.schema.nodes.paragraph

  const leavesContainerEmpty =
    $from.depth > 0 &&
    $from.parent.childCount === 1 &&
    (targetPos < $from.start($from.depth) || targetPos > $from.end($from.depth))

  if (leavesContainerEmpty && paragraph && $from.parent.canReplaceWith(0, 1, paragraph)) {
    tr.replaceWith(fromPos, fromEnd, paragraph.create())
  } else {
    tr.delete(fromPos, fromEnd)
  }

  const mappedTarget = tr.mapping.map(targetPos, targetPos < fromPos ? -1 : 1)
  tr.insert(mappedTarget, node)

  try {
    tr.doc.check()
  } catch {
    return null
  }

  tr.scrollIntoView()
  return tr
}

/**
 * Builds a single atomic, undoable transaction removing the block at `fromPos`.
 * If removing the sole block inside a container (e.g. a callout) that requires
 * at least one block, replaces it with an empty paragraph instead of collapsing
 * the surrounding container.
 */
export function buildDeleteTr(state: EditorState, fromPos: number): Transaction | null {
  const doc = state.doc
  if (fromPos < 0 || fromPos >= doc.content.size) return null
  const node = doc.nodeAt(fromPos)
  if (!node) return null

  const fromEnd = fromPos + node.nodeSize
  const $from = doc.resolve(fromPos)
  const tr = state.tr
  const paragraph = state.schema.nodes.paragraph

  if (
    $from.depth > 0 &&
    $from.parent.childCount === 1 &&
    paragraph &&
    $from.parent.canReplaceWith(0, 1, paragraph)
  ) {
    tr.replaceWith(fromPos, fromEnd, paragraph.create())
  } else {
    tr.delete(fromPos, fromEnd)
  }

  try {
    tr.doc.check()
  } catch {
    return null
  }

  return tr
}

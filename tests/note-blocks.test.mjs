// Note block reorder & delete transaction helpers. Run: node --test tests/note-blocks.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { buildDeleteTr, buildMoveTr, findStepTarget, isPdfAttachmentNode } from '../src/renderer/src/components/notes/blockMove.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    callout: { group: 'block', content: 'block+', defining: true },
    attachment: {
      group: 'block',
      atom: true,
      attrs: {
        id: { default: '' },
        name: { default: 'File' },
        mime: { default: 'application/octet-stream' },
        size: { default: 0 }
      }
    },
    drawing: {
      group: 'block',
      atom: true,
      attrs: { strokes: { default: [] }, height: { default: 600 } }
    },
    text: { inline: true }
  }
})

const p = (text) => schema.nodes.paragraph.create(null, text ? [schema.text(text)] : [])
const pdf = (name = 'slides.pdf') => schema.nodes.attachment.create({ id: 'a1', name, mime: 'application/pdf', size: 100 })
const img = (name = 'pic.png') => schema.nodes.attachment.create({ id: 'a2', name, mime: 'image/png', size: 200 })
const drw = () => schema.nodes.drawing.create({ strokes: [], height: 400 })
const callout = (...children) => schema.nodes.callout.create(null, children)

function labels(doc) {
  const out = []
  for (let i = 0; i < doc.childCount; i++) {
    const c = doc.child(i)
    if (c.type.name === 'paragraph') out.push(`p:${c.textContent}`)
    else if (c.type.name === 'attachment') out.push(`att:${c.attrs.name}`)
    else if (c.type.name === 'callout') out.push(`callout(${labels(c).join(',')})`)
    else out.push(c.type.name)
  }
  return out
}

function posOfChild(doc, idx) {
  let pos = 0
  for (let i = 0; i < idx; i++) pos += doc.child(i).nodeSize
  return pos
}

test('identifies PDF attachments by mime or filename', () => {
  assert.equal(isPdfAttachmentNode(pdf('notes.pdf')), true)
  assert.equal(isPdfAttachmentNode(schema.nodes.attachment.create({ id: 'x', name: 'UPPER.PDF', mime: '' })), true)
  assert.equal(isPdfAttachmentNode(img('pic.png')), false)
  assert.equal(isPdfAttachmentNode(drw()), false)
})

test('moves a drawing up and down one sibling at a time', () => {
  let state = EditorState.create({ doc: schema.nodes.doc.create(null, [p('first'), drw(), p('last')]) })

  // Move drawing up before "first"
  const drwPos = posOfChild(state.doc, 1)
  const upTarget = findStepTarget(state.doc, drwPos, -1)
  assert.equal(upTarget, 0)
  const trUp = buildMoveTr(state, drwPos, upTarget)
  assert.ok(trUp)
  state = state.apply(trUp)
  assert.deepEqual(labels(state.doc), ['drawing', 'p:first', 'p:last'])

  // Already at top: moving up is a no-op
  assert.equal(findStepTarget(state.doc, 0, -1), null)

  // Move drawing down past "first"
  const downTarget = findStepTarget(state.doc, 0, 1)
  const trDown = buildMoveTr(state, 0, downTarget)
  assert.ok(trDown)
  state = state.apply(trDown)
  assert.deepEqual(labels(state.doc), ['p:first', 'drawing', 'p:last'])

  // Move drawing down past "last"
  const drwPos2 = posOfChild(state.doc, 1)
  const downTarget2 = findStepTarget(state.doc, drwPos2, 1)
  const trDown2 = buildMoveTr(state, drwPos2, downTarget2)
  assert.ok(trDown2)
  state = state.apply(trDown2)
  assert.deepEqual(labels(state.doc), ['p:first', 'p:last', 'drawing'])

  // Already at bottom: moving down is a no-op
  assert.equal(findStepTarget(state.doc, posOfChild(state.doc, 2), 1), null)
})

test('skips collapsed PDFs when stepping up or down', () => {
  const state = EditorState.create({
    doc: schema.nodes.doc.create(null, [p('intro'), pdf('lecture.pdf'), drw(), p('end')])
  })
  const drwPos = posOfChild(state.doc, 2)

  // With PDFs hidden, moving drawing up should jump past the hidden PDF to before "intro"
  const target = findStepTarget(state.doc, drwPos, -1, true)
  assert.equal(target, 0)
  const tr = buildMoveTr(state, drwPos, target)
  assert.ok(tr)
  assert.deepEqual(labels(state.apply(tr).doc), ['drawing', 'p:intro', 'att:lecture.pdf', 'p:end'])
})

test('drag-and-drop move supports arbitrary positions and rejects no-ops', () => {
  const state = EditorState.create({
    doc: schema.nodes.doc.create(null, [p('a'), img('photo.png'), p('b'), p('c')])
  })
  const imgPos = posOfChild(state.doc, 1)
  const imgEnd = imgPos + state.doc.child(1).nodeSize

  // Adjacent positions before/after itself are no-ops
  assert.equal(buildMoveTr(state, imgPos, imgPos), null)
  assert.equal(buildMoveTr(state, imgPos, imgEnd), null)

  // Move image to very end of doc
  const trEnd = buildMoveTr(state, imgPos, state.doc.content.size)
  assert.ok(trEnd)
  assert.deepEqual(labels(state.apply(trEnd).doc), ['p:a', 'p:b', 'p:c', 'att:photo.png'])
})

test('moving the sole block out of a callout keeps the callout schema-valid', () => {
  const state = EditorState.create({
    doc: schema.nodes.doc.create(null, [callout(drw()), p('after')])
  })
  const drwPos = 1 // inside callout (starts at 0, content starts at 1)
  const tr = buildMoveTr(state, drwPos, state.doc.content.size)
  assert.ok(tr)
  const next = state.apply(tr)
  assert.deepEqual(labels(next.doc), ['callout(p:)', 'p:after', 'drawing'])
})

test('deleting blocks handles normal blocks, sole doc block, and sole callout block cleanly', () => {
  // Normal delete
  const s1 = EditorState.create({ doc: schema.nodes.doc.create(null, [p('a'), pdf('doc.pdf'), p('b')]) })
  const tr1 = buildDeleteTr(s1, posOfChild(s1.doc, 1))
  assert.ok(tr1)
  assert.deepEqual(labels(s1.apply(tr1).doc), ['p:a', 'p:b'])

  // Deleting sole block in doc leaves a valid empty paragraph
  const s2 = EditorState.create({ doc: schema.nodes.doc.create(null, [drw()]) })
  const tr2 = buildDeleteTr(s2, 0)
  assert.ok(tr2)
  assert.deepEqual(labels(s2.apply(tr2).doc), ['p:'])

  // Deleting sole block inside a callout leaves an empty paragraph inside the callout
  const s3 = EditorState.create({ doc: schema.nodes.doc.create(null, [callout(img('only.png'))]) })
  const tr3 = buildDeleteTr(s3, 1)
  assert.ok(tr3)
  assert.deepEqual(labels(s3.apply(tr3).doc), ['callout(p:)'])
})

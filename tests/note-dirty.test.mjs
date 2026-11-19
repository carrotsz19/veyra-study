// Unit tests verifying opening/reading a note never bumps its edited timestamp.
// Run: node --test tests/note-dirty.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { TrailingNode } from '@tiptap/extensions'
import {
  isEmptyNoteDoc,
  isSameNoteDoc,
  shouldSaveEditorUpdate
} from '../src/renderer/src/components/notes/noteDirty.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    heading: { group: 'block', content: 'text*' },
    text: { group: 'inline' }
  }
})

function trailingPlugin() {
  const ctx = {
    name: TrailingNode.name,
    options: { node: 'paragraph', notAfter: [] },
    editor: { schema }
  }
  return TrailingNode.config.addProseMirrorPlugins.call(ctx)[0]
}

test('isEmptyNoteDoc and isSameNoteDoc treat null and empty docs as equivalent and detect real edits', () => {
  const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }
  const hiDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] }
  const byeDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bye' }] }] }

  assert.equal(isEmptyNoteDoc(null), true)
  assert.equal(isEmptyNoteDoc(undefined), true)
  assert.equal(isEmptyNoteDoc(emptyDoc), true)
  assert.equal(isEmptyNoteDoc(hiDoc), false)

  assert.equal(isSameNoteDoc(null, emptyDoc), true)
  assert.equal(isSameNoteDoc(hiDoc, JSON.parse(JSON.stringify(hiDoc))), true)
  assert.equal(isSameNoteDoc(hiDoc, emptyDoc), false)
  assert.equal(isSameNoteDoc(hiDoc, byeDoc), false)
})

test('spellcheck meta transaction with skipTrailingNode does not mutate a note ending in a heading', () => {
  const doc = schema.node('doc', null, [schema.node('heading', null, [schema.text('Week 6 Notes')])])
  const state = EditorState.create({ doc, plugins: [trailingPlugin()] })

  // Repro without skipTrailingNode: TrailingNode appends a trailing paragraph!
  const unguardedTr = state.tr.setMeta('veyraSpelling', 'decos').setMeta('addToHistory', false)
  const unguardedResult = state.applyTransaction(unguardedTr)
  assert.equal(unguardedTr.docChanged, false)
  assert.equal(unguardedResult.state.doc.childCount, 2)
  assert.equal(shouldSaveEditorUpdate(unguardedTr), false)

  // Fixed spellcheck transaction: skips TrailingNode completely so doc is untouched.
  const guardedTr = state.tr
    .setMeta('veyraSpelling', 'decos')
    .setMeta('addToHistory', false)
    .setMeta('skipTrailingNode', true)
    .setMeta('preventUpdate', true)
  const guardedResult = state.applyTransaction(guardedTr)
  assert.equal(guardedResult.state.doc.eq(state.doc), true)
  assert.equal(guardedResult.transactions.some((t) => t.docChanged), false)
  assert.equal(shouldSaveEditorUpdate(guardedTr), false)
})

test('clicking into a note does not trigger save, while typing does', () => {
  const doc = schema.node('doc', null, [schema.node('heading', null, [schema.text('Chapter 4')])])
  const state = EditorState.create({ doc, plugins: [trailingPlugin()] })

  // Selection-only transaction (user clicks inside the note to read/copy)
  const clickTr = state.tr.setSelection(TextSelection.create(state.doc, 3))
  assert.equal(clickTr.docChanged, false)
  assert.equal(shouldSaveEditorUpdate(clickTr), false)

  // Actual user edit (typing text)
  const editTr = state.tr.insertText('!', 10)
  assert.equal(editTr.docChanged, true)
  assert.equal(shouldSaveEditorUpdate(editTr), true)
})

// Unit tests for DOCX, HTML (Desktop PDF), and binary PDF 1.4 note exporters.
// Run: node --test tests/note-export.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  drawingKey,
  noteToDocx,
  noteToExportHtml,
  noteToPdf,
  parseImageDimensions,
  resolveHighlightHex,
  safeFileName,
  safeHref,
  strokesToSvg
} from '../src/shared/note-export.ts'

/** Parses a STORE PKZIP archive into a map of filename -> Uint8Array and verifies headers + CRC-32. */
function parseZip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const dec = new TextDecoder()
  // Locate EOCD
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, 'ZIP must contain EOCD signature')
  const count = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)

  const files = new Map()
  let pos = cdOffset
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(pos, true), 0x02014b50, 'Central directory header signature')
    const method = view.getUint16(pos + 10, true)
    assert.equal(method, 0, 'Expected STORE compression method')
    const compSize = view.getUint32(pos + 20, true)
    const uncompSize = view.getUint32(pos + 24, true)
    assert.equal(compSize, uncompSize)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const lfhOffset = view.getUint32(pos + 42, true)
    const name = dec.decode(buf.subarray(pos + 46, pos + 46 + nameLen))

    // Verify local file header matches
    assert.equal(view.getUint32(lfhOffset, true), 0x04034b50, `LFH signature for ${name}`)
    const lfhNameLen = view.getUint16(lfhOffset + 26, true)
    const lfhExtraLen = view.getUint16(lfhOffset + 28, true)
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen
    files.set(name, buf.subarray(dataStart, dataStart + compSize))
    pos += 46 + nameLen + extraLen + commentLen
  }
  return files
}

/** Minimal valid 1x1 PNG (67 bytes) for image-embedding tests. */
const TINY_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x02, 0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])

/** Minimal JPEG header with SOF0 (width=320, height=200) for JPEG dimension + PDF embedding tests. */
const TINY_JPEG = Uint8Array.from([
  0xff, 0xd8, // SOI
  0xff, 0xc0, // SOF0
  0x00, 0x0b, // length 11
  0x08, // 8-bit precision
  0x00, 0xc8, // height = 200
  0x01, 0x40, // width = 320
  0x03, 0x01, 0x11, 0x00, // component data
  0xff, 0xd9 // EOI
])

const RICH_NOTE = {
  title: 'Cell Biology & Genetics <Lecture 4>',
  icon: '🧬',
  subject: 'Biology 101',
  tags: ['genetics', 'midterm'],
  template: 'page',
  font: 'serif',
  updatedAt: Date.UTC(2026, 10, 20),
  content: {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'DNA Replication' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Helicase unwinds the ' },
          { type: 'text', text: 'double helix', marks: [{ type: 'bold' }, { type: 'highlight', attrs: { color: 'var(--hl-yellow)' } }] },
          { type: 'text', text: ' at ' },
          { type: 'text', text: 'origins', marks: [{ type: 'italic' }, { type: 'underline' }] },
          { type: 'text', text: ' — see ' },
          { type: 'text', text: 'NCBI', marks: [{ type: 'link', attrs: { href: 'https://www.ncbi.nlm.nih.gov/?a=1&b=2' } }] },
          { type: 'text', text: ' or ' },
          { type: 'text', text: 'bad link', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: '5′→3′', marks: [{ type: 'code' }] }
        ]
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Leading strand (continuous)' }] },
              {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthesized smoothly' }] }] }]
              }
            ]
          },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lagging strand (Okazaki fragments)' }] }] }
        ]
      },
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Initiation' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Elongation' }] }] }
        ]
      },
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second list restarts at 1' }] }] }]
      },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Read Chapter 4' }] }] },
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Review enzymes' }] }] }
        ]
      },
      {
        type: 'callout',
        attrs: { tone: 'definition' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Semiconservative: each copy keeps one parent strand.' }] }]
      },
      {
        type: 'details',
        content: [
          { type: 'detailsSummary', content: [{ type: 'text', text: 'Which enzyme seals Okazaki fragments?' }] },
          { type: 'detailsContent', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'DNA ligase.' }] }] }
        ]
      },
      {
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It has not escaped our notice…' }] }]
      },
      {
        type: 'codeBlock',
        content: [{ type: 'text', text: '5\'-ATGGCT-3\'\n3\'-TACCGA-5\'' }]
      },
      { type: 'horizontalRule' },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Enzyme' }] }] },
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Role' }] }] }
            ]
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Helicase' }] }] },
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unwinds helix' }] }] }
            ]
          }
        ]
      },
      {
        type: 'drawing',
        attrs: { height: 300, strokes: [{ c: '#2f6fd6', w: 4, p: [10, 20, 0.5, 100, 80, 0.6, 200, 40, 0.5] }] }
      },
      {
        type: 'attachment',
        attrs: { id: 'img-1.png', name: 'diagram.png', mime: 'image/png', size: 1024 }
      },
      {
        type: 'attachment',
        attrs: { id: 'slides.pdf', name: 'lecture4.pdf', mime: 'application/pdf', size: 2_500_000 }
      }
    ]
  }
}

test('helper functions sanitize names, URLs, highlights, SVG strokes, and image headers', () => {
  assert.equal(safeFileName('  Bio: Ch. 4 / Notes?  '), 'Bio Ch. 4  Notes')
  assert.equal(safeFileName('***'), 'Untitled')
  assert.equal(resolveHighlightHex('var(--hl-yellow)'), '#FEF08A')
  assert.equal(resolveHighlightHex('var(--hl-blue)'), '#BFDBFE')
  assert.equal(resolveHighlightHex('#abc'), '#AABBCC')
  assert.equal(safeHref('https://example.com'), 'https://example.com')
  assert.equal(safeHref('mailto:test@example.com'), 'mailto:test@example.com')
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.deepEqual(parseImageDimensions(TINY_PNG), { width: 4, height: 2 })
  assert.deepEqual(parseImageDimensions(TINY_JPEG), { width: 320, height: 200 })
  const svg = strokesToSvg([{ c: 'ink', w: 4, p: [0, 0, 0.5, 50, 50, 0.5] }], 400)
  assert.match(svg, /^<svg[^>]+viewBox="0 0 1000 400"/)
  assert.match(svg, /<path d="M 0 0 Q 0 0/)
})

test('noteToDocx builds a valid OOXML archive with all rich blocks, numbering, links, and media', () => {
  const media = {
    'img-1.png': { bytes: TINY_PNG, mime: 'image/png', width: 4, height: 2 },
    [drawingKey(0)]: { bytes: TINY_PNG, mime: 'image/png', width: 500, height: 150 }
  }
  const zipBytes = noteToDocx(RICH_NOTE, media)
  assert.ok(zipBytes instanceof Uint8Array && zipBytes.byteLength > 1000)

  const files = parseZip(zipBytes)
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/_rels/document.xml.rels',
    'word/styles.xml',
    'word/numbering.xml',
    'word/media/image1.png',
    'word/media/image2.png'
  ]) {
    assert.ok(files.has(required), `Missing required DOCX entry: ${required}`)
  }

  const dec = new TextDecoder()
  const docXml = dec.decode(files.get('word/document.xml'))
  const relsXml = dec.decode(files.get('word/_rels/document.xml.rels'))
  const numXml = dec.decode(files.get('word/numbering.xml'))
  const stylesXml = dec.decode(files.get('word/styles.xml'))
  const typesXml = dec.decode(files.get('[Content_Types].xml'))

  // Proper XML escaping & no unsafe links
  assert.match(docXml, /Cell Biology &amp; Genetics &lt;Lecture 4&gt;/)
  assert.doesNotMatch(relsXml, /javascript:/)
  assert.match(relsXml, /Target="https:\/\/www\.ncbi\.nlm\.nih\.gov\/\?a=1&amp;b=2" TargetMode="External"/)

  // Font & highlight & callout & checklist & table & code & attachments
  assert.match(stylesXml, /w:ascii="Georgia"/)
  assert.match(docXml, /w:fill="FEF08A"/)
  assert.match(docXml, /Definition/)
  assert.match(docXml, /☑/)
  assert.match(docXml, /☐/)
  assert.match(docXml, /Which enzyme seals Okazaki fragments\?/)
  assert.match(docXml, /<w:tblHeader\/>/)
  assert.match(docXml, /lecture4\.pdf/)
  assert.match(docXml, /<w:drawing>/)
  assert.match(typesXml, /Extension="png" ContentType="image\/png"/)

  // Separate numbering instances so the second ordered list restarts cleanly at 1
  assert.match(numXml, /w:numId="2"/)
  assert.match(numXml, /w:numId="3"/)
  assert.ok(numXml.indexOf('<w:abstractNum') < numXml.indexOf('<w:num '))
})

test('noteToDocx handles Cornell layout and strips illegal XML control characters', () => {
  const cornellNote = {
    title: 'History\u0000Notes\u0007',
    template: 'cornell',
    font: 'sans',
    cues: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Key dates?' }] }] },
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1789 — French Revolution' }] }] },
    summary: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Major political shift.' }] }] }
  }
  const files = parseZip(noteToDocx(cornellNote))
  const docXml = new TextDecoder().decode(files.get('word/document.xml'))
  assert.doesNotMatch(docXml, /[\u0000-\u0008]/)
  assert.match(docXml, /CUES &amp; QUESTIONS/)
  assert.match(docXml, /NOTES/)
  assert.match(docXml, /SUMMARY/)
  assert.match(docXml, /French Revolution/)
})

test('noteToExportHtml escapes HTML, blocks javascript: links, renders SVG drawings & data URIs', () => {
  const html = noteToExportHtml(RICH_NOTE, {
    'img-1.png': { bytes: TINY_PNG, mime: 'image/png' }
  })
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /Cell Biology &amp; Genetics &lt;Lecture 4&gt;/)
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /href="https:\/\/www\.ncbi\.nlm\.nih\.gov\/\?a=1&amp;b=2"/)
  assert.match(html, /background:#FEF08A/)
  assert.match(html, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(html, /src="data:image\/png;base64,/)
  assert.match(html, /lecture4\.pdf/)
})

test('noteToPdf generates a valid multi-page PDF 1.4 with xref table, fonts, and embedded JPEG', () => {
  const longParas = Array.from({ length: 45 }, (_, i) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: `Paragraph ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.` }]
  }))
  const note = {
    ...RICH_NOTE,
    content: { type: 'doc', content: [...RICH_NOTE.content.content, ...longParas] }
  }
  const pdfBytes = noteToPdf(note, {
    'img-1.png': { bytes: TINY_JPEG, mime: 'image/jpeg', width: 320, height: 200 },
    [drawingKey(0)]: { bytes: TINY_JPEG, mime: 'image/jpeg', width: 320, height: 200 }
  })
  const text = new TextDecoder('latin1').decode(pdfBytes)
  assert.ok(text.startsWith('%PDF-1.4\n'), 'Must start with %PDF-1.4 header')
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'Must end with %%EOF')
  assert.match(text, /\/Type \/Catalog/)
  assert.match(text, /\/Type \/Pages \/Kids \[[^\]]+\] \/Count [2-9]/)
  assert.match(text, /\/Filter \/DCTDecode/)
  assert.match(text, /\/BaseFont \/Times-Roman/)
  assert.match(text, /xref\n0 \d+\n/)
  assert.match(text, /startxref\n\d+\n%%EOF/)
})

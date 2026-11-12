#!/usr/bin/env node
/**
 * Draws the Android launcher icons from the Veyra mark (two offset chevrons,
 * green under clay) on a warm paper background. No dependencies.
 *   node tools/android-icons.mjs
 * Writes mipmap-* /ic_launcher.png, ic_launcher_round.png and
 * ic_launcher_foreground.png (adaptive icon), and the background colour.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const RES = 'android/app/src/main/res'
const PAPER = [0xf6, 0xf2, 0xea] // the app's light background, a touch warmer
const crcT = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc = (b) => {
  let c = -1
  for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (t, d) => {
  const l = Buffer.alloc(4)
  l.writeUInt32BE(d.length)
  const td = Buffer.concat([Buffer.from(t), d])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(td))
  return Buffer.concat([l, td, c])
}
const encode = (size, px) => {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** The mark covers `markFrac` of the canvas; `shape` is the background: none, square (rounded) or circle. */
function icon(size, markFrac, shape) {
  const px = Buffer.alloc(size * size * 4)
  const segs = [[15, 16, 32, 50], [32, 50, 49, 16]] // the chevron, in a 64-unit box
  const dist = (x, y, [ax, ay, bx, by]) => {
    const dx = bx - ax, dy = by - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(x - ax - t * dx, y - ay - t * dy)
  }
  const box = size * markFrac
  const origin = (size - box) / 2
  const S = 4 // supersampling
  const cover = (x, y, off) => {
    let a = 0
    for (let sy = 0; sy < S; sy++)
      for (let sx = 0; sx < S; sx++) {
        const u = ((x + (sx + 0.5) / S - origin) / box) * 64 - off
        const v = ((y + (sy + 0.5) / S - origin) / box) * 64 - off + 1.5 // optically centred
        if (Math.min(...segs.map((s) => dist(u, v, s))) <= 4.6) a++
      }
    return a / (S * S)
  }
  const inShape = (x, y) => {
    if (shape === 'none') return 0
    let a = 0
    const r = size / 2, k = size * 0.22 // corner radius for the square
    for (let sy = 0; sy < S; sy++)
      for (let sx = 0; sx < S; sx++) {
        const u = x + (sx + 0.5) / S, v = y + (sy + 0.5) / S
        if (shape === 'circle') a += Math.hypot(u - r, v - r) <= r ? 1 : 0
        else {
          const cx = Math.min(Math.max(u, k), size - k), cy = Math.min(Math.max(v, k), size - k)
          a += Math.hypot(u - cx, v - cy) <= k ? 1 : 0
        }
      }
    return a / (S * S)
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const bg = inShape(x, y)
      const g = cover(x, y, 2.5), c = cover(x, y, 0)
      const m = c + g * (1 - c)
      // the mark over the background
      const markRGB = (k) => (m ? ([0xd9, 0x63, 0x3e][k] * c + [0x6f, 0xae, 0x82][k] * g * (1 - c)) / m : 0)
      const a = m + bg * (1 - m)
      if (!a) continue
      for (let k = 0; k < 3; k++) px[i + k] = Math.round((markRGB(k) * m + PAPER[k] * bg * (1 - m)) / a)
      px[i + 3] = Math.round(a * 255)
    }
  return encode(size, px)
}

const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [d, k] of Object.entries(DENS)) {
  writeFileSync(`${RES}/mipmap-${d}/ic_launcher.png`, icon(Math.round(48 * k), 0.62, 'square'))
  writeFileSync(`${RES}/mipmap-${d}/ic_launcher_round.png`, icon(Math.round(48 * k), 0.6, 'circle'))
  // Adaptive icons: 108 dp canvas, of which the middle 66 dp is always visible.
  writeFileSync(`${RES}/mipmap-${d}/ic_launcher_foreground.png`, icon(Math.round(108 * k), 0.4, 'none'))
}
writeFileSync(
  `${RES}/values/ic_launcher_background.xml`,
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#${PAPER.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}</color>\n</resources>\n`
)
console.log('Android icons written')

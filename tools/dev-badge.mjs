#!/usr/bin/env node
// Draws resources/dev-badge.png: the small badge Veyra Study Dev puts on its taskbar icon
// (a violet dot with a white ring), so the test app is never mistaken for the real one.
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const N = 32
const px = Buffer.alloc(N * (N * 4 + 1))
for (let y = 0; y < N; y++) {
  px[y * (N * 4 + 1)] = 0 // filter: none
  for (let x = 0; x < N; x++) {
    const d = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2)
    const edge = (r) => Math.max(0, Math.min(1, r - d + 0.5)) // anti-aliased disc of radius r
    const ring = edge(15)
    const fill = edge(12)
    // white ring, violet middle
    const r = Math.round(255 * (ring - fill) + 0x7c * fill)
    const g = Math.round(255 * (ring - fill) + 0x4d * fill)
    const b = Math.round(255 * (ring - fill) + 0xff * fill)
    const i = y * (N * 4 + 1) + 1 + x * 4
    px[i] = ring ? Math.round(r / ring) : 0
    px[i + 1] = ring ? Math.round(g / ring) : 0
    px[i + 2] = ring ? Math.round(b / ring) : 0
    px[i + 3] = Math.round(255 * ring)
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0)
ihdr.writeUInt32BE(N, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))])
writeFileSync('resources/dev-badge.png', png)
console.log('resources/dev-badge.png')

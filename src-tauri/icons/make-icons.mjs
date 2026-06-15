/**
 * Generates placeholder app icons (icon.png 256x256 + icon.ico) with zero
 * dependencies — tauri-build requires them to exist on Windows. Run once:
 *   node src-tauri/icons/make-icons.mjs
 * Replace with real branded icons later (`npx @tauri-apps/cli icon <src.png>`).
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// ── tiny PNG writer (truecolor+alpha, no interlace) ─────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

const W = 256
const H = 256
// Raw image: per scanline 1 filter byte + W RGBA pixels. A flat violet tile
// with a simple darker diagonal "cut" stripe so it reads as an editor mark.
const raw = Buffer.alloc(H * (1 + W * 4))
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 4)
  raw[row] = 0 // filter: none
  for (let x = 0; x < W; x++) {
    const off = row + 1 + x * 4
    const onStripe = Math.abs(x - y) < 22
    raw[off] = onStripe ? 49 : 124      // R
    raw[off + 1] = onStripe ? 16 : 58   // G
    raw[off + 2] = onStripe ? 129 : 237 // B
    raw[off + 3] = 255                  // A
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync(join(here, 'icon.png'), png)

// ── ICO container embedding the PNG (valid since Vista) ────────────────────
const ico = Buffer.alloc(6 + 16)
ico.writeUInt16LE(0, 0) // reserved
ico.writeUInt16LE(1, 2) // type: icon
ico.writeUInt16LE(1, 4) // count
ico[6] = 0 // width 256 → 0
ico[7] = 0 // height 256 → 0
ico[8] = 0 // palette
ico[9] = 0 // reserved
ico.writeUInt16LE(1, 10) // planes
ico.writeUInt16LE(32, 12) // bpp
ico.writeUInt32LE(png.length, 14) // data size
ico.writeUInt32LE(22, 18) // data offset
writeFileSync(join(here, 'icon.ico'), Buffer.concat([ico, png]))

console.log(`wrote icon.png (${png.length} bytes) + icon.ico (${22 + png.length} bytes)`)

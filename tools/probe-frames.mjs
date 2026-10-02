/** Diagnostic: locate zstd frame boundaries inside one session log. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = join(process.env.USERPROFILE, '.dsh', 'sessions')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(path)
  }
  return out
}

const files = walk(ROOT).sort((a, b) => readFileSync(a).length - readFileSync(b).length)
const sample = files[files.length - 1]
const raw = readFileSync(sample)
console.log('file   :', sample)
console.log('bytes  :', raw.length)
console.log('head   :', raw.subarray(0, 32).toString('hex'))
console.log('tail   :', raw.subarray(-32).toString('hex'))

// Standard zstd frame magic.
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
let at = raw.indexOf(MAGIC, 0)
while (at !== -1 && offsets.length < 40) {
  offsets.push(at)
  at = raw.indexOf(MAGIC, at + 4)
}
console.log('magic count (first 40) :', offsets.length)
console.log('first offsets          :', offsets.slice(0, 12).join(', '))

// Try decoding from each of the first few magic offsets.
for (const offset of offsets.slice(0, 4)) {
  try {
    const out = zstdDecompressSync(raw.subarray(offset))
    console.log(`  decode @${offset} -> ${out.length} bytes :: ${out.subarray(0, 80).toString('utf8').replace(/\n/g, '\\n')}`)
  } catch (error) {
    console.log(`  decode @${offset} -> FAILED ${String(error).slice(0, 90)}`)
  }
}

// Is there a length-prefixed chunk layout? Inspect bytes around the first frame end.
console.log()
console.log('--- bytes 190..230 (just past the first frame) ---')
console.log(raw.subarray(190, 230).toString('hex'))
console.log('--- printable at 190..400 ---')
console.log(JSON.stringify(raw.subarray(190, 400).toString('utf8')))

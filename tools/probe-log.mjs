/** Diagnostic: how is a session log actually framed and encoded? */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync, createZstdDecompress } from 'node:zlib'

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
console.log('sample:', sample)
const raw = readFileSync(sample)
console.log('compressed bytes:', raw.length)

const sync = zstdDecompressSync(raw)
console.log('sync  -> bytes:', sync.length, ' newlines:', (sync.toString('utf8').match(/\n/g) ?? []).length)

const streamed = await new Promise((resolve, reject) => {
  const chunks = []
  const dec = createZstdDecompress()
  dec.on('data', chunk => chunks.push(chunk))
  dec.on('end', () => resolve(Buffer.concat(chunks)))
  dec.on('error', reject)
  dec.end(raw)
})
console.log('stream-> bytes:', streamed.length, ' newlines:', (streamed.toString('utf8').match(/\n/g) ?? []).length)

console.log()
console.log('--- first 400 chars (streamed) ---')
console.log(streamed.toString('utf8').slice(0, 400))
console.log()
console.log('--- event types seen (streamed) ---')
const types = new Map()
for (const line of streamed.toString('utf8').split('\n')) {
  if (line.length === 0) continue
  try {
    const event = JSON.parse(line)
    const type = event.type ?? '(header)'
    types.set(type, (types.get(type) ?? 0) + 1)
  } catch {
    types.set('(unparseable)', (types.get('(unparseable)') ?? 0) + 1)
  }
}
for (const [type, count] of [...types].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(count).padStart(6)}  ${type}`)
}

/**
 * Undeclared-identifier audit for this plugin's two halves.
 *
 * Catches the bug class that blanked the settings panel: a `const` was renamed
 * in one place while a later usage kept the old name. `node --check` cannot see
 * it — the file stays syntactically valid and the reference only throws when the
 * branch containing it finally renders.
 *
 * This is a SCOPE AUDIT, not a renderer. It reads text, blanks out literals and
 * comments, then compares names used as values against names bound anywhere in
 * the file. It proves nothing about appearance.
 *
 * Usage: node tools/check-identifiers.mjs <file.js> [...]
 */

import { readFileSync } from 'node:fs'

/** Reserved words that are never bindings but survive the literal strip. */
const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'of', 'in',
  'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch',
  'finally', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'void', 'async',
  'await', 'yield', 'class', 'extends', 'super', 'import', 'export', 'from', 'as',
  'this', 'true', 'false', 'null', 'undefined', 'static', 'get', 'set', 'with',
  'debugger', 'enum',
])

/** Names that exist without being bound in the file under audit. */
const GLOBALS = new Set([
  'window', 'document', 'globalThis', 'console', 'Math', 'JSON', 'Object', 'Array',
  'Number', 'String', 'Boolean', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'RegExp', 'Infinity', 'NaN',
  'undefined', 'this', 'arguments', 'fetch', 'Response', 'Request', 'Headers',
  'ReadableStream', 'WritableStream', 'TextEncoder', 'TextDecoder', 'AbortController',
  'AbortSignal', 'URL', 'URLSearchParams', 'Intl', 'Symbol', 'BigInt', 'Proxy',
  'Reflect', 'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'require', 'module', 'exports',
  'process', 'global', 'Buffer',
])

/**
 * Blank out string, template and regex literals plus comments.
 *
 * Template substitutions are kept, because `${...}` holds real code that must
 * still be scanned.
 * @param text - raw source.
 * @returns source of the same length-ish shape with literal contents removed.
 */
function stripLiterals(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === '/') {
      // Regex literal vs division: a regex may only start where a value cannot
      // already have ended, which is the classic heuristic for this split.
      const previous = out.replace(/\s+$/, '').slice(-1)
      const startsRegex = previous === '' || /[([{,;:=!&|?+\-*%<>~^]/.test(previous)
      if (startsRegex && next !== '/' && next !== '*') {
        i += 1
        let inClass = false
        while (i < text.length) {
          if (text[i] === '\\') {
            i += 2
            continue
          }
          if (text[i] === '[') inClass = true
          else if (text[i] === ']') inClass = false
          else if (text[i] === '/' && !inClass) {
            i += 1
            break
          } else if (text[i] === '\n') break
          i += 1
        }
        out += ' 0 '
        continue
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === quote) {
          i += 1
          break
        }
        if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
          i += 2
          const start = i
          let depth = 1
          while (i < text.length && depth > 0) {
            if (text[i] === '{') depth += 1
            else if (text[i] === '}') depth -= 1
            if (depth > 0) i += 1
          }
          out += ` ${stripLiterals(text.slice(start, i))} `
          i += 1
          continue
        }
        i += 1
      }
      out += ' "" '
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Split a parameter or destructuring list into bound names. */
function bindList(fragment, names) {
  // Braces and brackets only group; the names inside are what bind.
  for (const raw of fragment.replace(/[{}[\]]/g, ' ').split(',')) {
    const piece = raw.trim().replace(/^\.\.\./, '')
    if (piece.length === 0) continue
    // `{ a: alias }` binds alias; `{ a = 1 }` and `{ a }` bind a.
    const parts = piece.split(':')
    const candidate = (parts.length > 1 ? parts[1] : parts[0]).split('=')[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(candidate)) names.add(candidate)
  }
}

/** Every name the file binds, at any depth. Over-collecting is deliberate:
 *  a name bound anywhere is treated as known, so this check stays free of
 *  false alarms at the cost of not reporting shadowing mistakes. */
function declaredNames(clean) {
  const names = new Set()
  const patterns = [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s*\[([^\]]*)\]\s*(?:=|of|in)/g,
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
    /\bfunction\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s*\(([^)]*)\)/g,
    /\(([^()]*)\)\s*=>/g,
    /(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*=>/g,
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
    // Method shorthand and plain declarations: `name(a, b) {` and `name: (a) =>`.
    /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g,
    /([A-Za-z_$][\w$]*)\s*:\s*\(([^()]*)\)\s*=>/g,
    // ESM bindings: `import { a, b } from '…'`, `import d from '…'`,
    // `import * as ns from '…'`. The halves used to take no imports at all, so
    // this audit never needed to know about them; the Host half imports
    // `node:` builtins now, and a regex that ignores them reports false alarms.
    /(?:^|[\s;])import\s*\{([^}]*)\}\s*from\s*['"]/g,
    /(?:^|[\s;])import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]/g,
    /(?:^|[\s;])import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      for (let group = 1; group < match.length; group += 1) {
        if (match[group] === undefined) continue
        bindList(match[group], names)
      }
    }
  }
  return names
}

/** Identifiers read as values: not a property after `.`, not an object key. */
function usedNames(clean) {
  const used = new Map()
  for (const match of clean.matchAll(/(?<![\w$.\\])[A-Za-z_$][\w$]*/g)) {
    const name = match[0]
    const before = clean[match.index - 1]
    // `1e6` and `\u00d7` look like identifiers to a regex but are not reads.
    if (before !== undefined && /[0-9]/.test(before)) continue
    if (before === '.' || before === '#' || before === '@') continue
    const rest = clean.slice(match.index + name.length)
    if (/^\s*:/.test(rest)) continue
    if (!used.has(name)) {
      used.set(name, clean.slice(0, match.index).split('\n').length)
    }
  }
  return used
}

let failed = false
for (const file of process.argv.slice(2)) {
  const clean = stripLiterals(readFileSync(file, 'utf8'))
  const declared = declaredNames(clean)
  const suspicious = []
  for (const [name, line] of usedNames(clean)) {
    if (declared.has(name) || GLOBALS.has(name) || KEYWORDS.has(name)) continue
    suspicious.push({ name, line })
  }
  if (suspicious.length === 0) {
    console.log(`${file}: clean (${declared.size} bound names)`)
  } else {
    failed = true
    console.log(`${file}: ${suspicious.length} name(s) used but never bound`)
    for (const entry of suspicious.sort((a, b) => a.line - b.line)) {
      console.log(`  line ${String(entry.line).padStart(5)}  ${entry.name}`)
    }
  }
}
process.exitCode = failed ? 1 : 0

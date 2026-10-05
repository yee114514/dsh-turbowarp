import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The bridge talks to the editor by sending JavaScript source as a string, so
 * `src/bridge/ops.mjs` and friends are full of large template literals holding page
 * code. A backtick inside one of those — even inside a `//` comment — closes the
 * literal early and produces a confusing "missing ) after argument list" tens of
 * lines away. That happened twice while writing this plugin, so it is a test now.
 */

const root = fileURLToPath(new URL('..', import.meta.url))

/** Every .mjs file under a directory, recursively. */
const sourceFiles = (directory) => {
  const found = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path))
    else if (entry.endsWith('.mjs')) found.push(path)
  }
  return found
}

test('no page-source template literal contains a backtick in a comment', () => {
  const offenders = []

  // tools/ too: the probe and cleanup scripts embed page source the same way, and
  // a violation there is just as hard to read as one in src/. (This happened three
  // times while building the plugin, which is why the guard covers both.)
  for (const directory of ['src', 'tools']) {
    for (const file of sourceFiles(join(root, directory))) {
      const lines = readFileSync(file, 'utf8').split('\n')
      let insideTemplate = false
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        const ticks = (line.match(/`/g) ?? []).length
        const hadOddTicks = ticks % 2 === 1
        // Toggling on odd counts is exact for this codebase: it uses no nested
        // template literals and no escaped backticks inside page source.
        if (hadOddTicks) insideTemplate = !insideTemplate
        if (!insideTemplate && !hadOddTicks) continue
        if (insideTemplate && line.includes('`') && line.includes('//')) {
          offenders.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`)
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `backtick inside a comment in a page-source template:\n${offenders.join('\n')}`)
})

test('every plugin source file is importable', async () => {
  // A syntax error in a page-source template only shows up when the module is
  // imported, which for a plugin means at DSH start-up. Ask for it here instead.
  //
  // Deliberately only src/: importing a tools/ script EXECUTES it (they are
  // top-level programs that attach to a live editor), which is not something a unit
  // test may do. The backtick guard above is static and does cover tools/.
  for (const file of sourceFiles(join(root, 'src'))) {
    const url = new URL(`file://${file.replace(/\\/g, '/')}`)
    await assert.doesNotReject(
      () => import(url.href),
      `${relative(root, file)} must be importable`
    )
  }
})

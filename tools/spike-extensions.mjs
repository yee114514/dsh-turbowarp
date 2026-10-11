/**
 * How extensions actually behave, in one runnable place.
 *
 * This is the consolidated evidence behind `src/scratch/extensions.mjs`,
 * `listExtensions` / `loadExtensions` in `src/bridge/ops.mjs`, and the extension
 * section of `docs/spike.md`. It replaces five throwaway probes that each answered
 * one question while discovering it.
 *
 * Read-only apart from loading built-in extensions, which cannot be undone (the VM
 * has no "unload"), so run it on a disposable editor — not on a project you care
 * about. It deliberately does NOT try a `data:` URL: that strands a worker forever
 * (see the note below), and the failure mode is bad enough to be worth avoiding
 * rather than reproducing.
 *
 *   node tools/spike-extensions.mjs [--port 9222]
 *
 * What it establishes, and why each one matters:
 *
 *   A. `extensionManager.loadExtensionURL` takes a built-in id OR a URL, and is the
 *      only entry point. Built-ins load synchronously.
 *   B. A category names its blocks WITHOUT the extension prefix (`clear`), while the
 *      running opcode carries it (`pen_clear`). Writing the bare name applies cleanly
 *      and silently never runs.
 *   C. A project's `extensions` array is DERIVED from the opcodes in use, not from
 *      what is loaded — so offline writes have to maintain it by hand.
 *   D. A custom extension's URL is saved at the document's TOP LEVEL as
 *      `extensionURLs`, NOT under `meta` — and only for an extension that some block
 *      actually uses. Putting it under `meta` is ignored by both the serializer and
 *      the deserializer, which is a silent, project-breaking mistake.
 *   E. Pen state lives in `target.getCustomState('Scratch.pen')`, which is how a test
 *      proves a pen block RAN (a screenshot proves nothing on a white stage).
 */

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { loadExtensions, listExtensions, syncProjectExtensions } from '../src/bridge/ops.mjs'

const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const port = Number(portFlag === -1 ? (process.env.TW_PORT ?? '9222') : portFlag + 1)
const CUSTOM_URL = 'https://extensions.turbowarp.org/lab/text.js'

const targets = await listTargets(port)
const page = targets.find((t) => typeof t.url === 'string' && t.url.startsWith('tw-editor://'))
if (page === undefined) throw new Error('no tw-editor:// page target found')
const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)

// ── A. the manager's surface ─────────────────────────────────────────────────
const api = await evaluate(connection, `JSON.stringify((() => {
  const manager = window.vm.extensionManager
  return {
    builtinIds: Object.keys(manager.builtinExtensions).sort(),
    methods: Object.getOwnPropertyNames(Object.getPrototypeOf(manager)).sort(),
    vmHasLoadExtensionURL: typeof window.vm.loadExtensionURL,
    // Loaded extensions are NEVER unloaded, so this may be non-empty from earlier runs.
    loadedAlready: [...manager._loadedExtensions.keys()]
  }
})())`, { timeoutMs: 30000 })
console.log('A. manager surface')
console.log(api)

// ── A2. loading a built-in id, and failing on nonsense ───────────────────────
const loaded = await loadExtensions(connection, { extensions: ['pen', 'music', 'definitelyNotReal'], timeoutMs: 15000 })
console.log('\nA2. loadExtensions')
for (const result of loaded.results) {
  console.log(`  ${result.id}: ok=${result.ok} loaded=${result.loaded} opcodes=${result.opcodes.length}${result.error ? `  error=${result.error}` : ''}`)
}
console.log(`  strandedWorkers=${loaded.strandedWorkers} stillLoading=${loaded.stillLoading}`)

// ── B. the prefix rule ───────────────────────────────────────────────────────
const state = await listExtensions(connection)
const pen = state.loaded.find((extension) => extension.id === 'pen')
console.log('\nB. prefix rule (category name -> running opcode)')
console.log(`  category: ${pen.categoryOpcodes.slice(0, 4).join(', ')}`)
console.log(`  opcodes:  ${pen.opcodes.slice(0, 4).join(', ')}`)

// ── C. the extensions array is derived from opcodes in use ───────────────────
const derived = await evaluate(connection, `JSON.stringify((() => {
  const vm = window.vm
  const runtime = vm.runtime
  const target = runtime.targets.find((t) => !t.isStage)
  if (!target) return { error: 'no sprite to experiment on' }
  vm.setEditingTarget(target.id)
  vm.stopAll()
  const savedScripts = [...target.blocks.getScripts()]
  for (const id of savedScripts) target.blocks.deleteBlock(id)

  const withPenLoaded = JSON.parse(vm.toJSON()).extensions
  target.blocks.createBlock({ id: 'spikePen', opcode: 'pen_clear', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0 })
  const withOnePenBlock = JSON.parse(vm.toJSON()).extensions
  target.blocks.deleteBlock('spikePen')

  return {
    loadedIds: [...vm.extensionManager._loadedExtensions.keys()],
    extensionsWithPenLoadedButUnused: withPenLoaded,
    extensionsWithOnePenBlock: withOnePenBlock,
    verdict: withPenLoaded.length === 0 && withOnePenBlock.includes('pen')
      ? 'derived from opcodes in use; loading alone leaves no trace'
      : 'NOT derived — investigate'
  }
})())`, { timeoutMs: 30000 })
console.log('\nC. is the project extensions array derived?')
console.log(derived)

// ── D. a custom extension by URL, and where its URL is recorded ──────────────
const custom = await loadExtensions(connection, { extensions: [CUSTOM_URL], timeoutMs: 30000 })
console.log('\nD. custom extension by URL')
console.log('  ' + JSON.stringify(custom.results[0]))
console.log(`  getExtensionURLs -> ${JSON.stringify(custom.extensionURLs)}`)
const synced = await syncProjectExtensions(connection)
console.log(`  document extensionURLs (top level) -> ${JSON.stringify(synced.extensionURLs)}`)
console.log(`  manager knows -> ${JSON.stringify(synced.managerExtensionURLs)}`)
console.log(`  not saved because no block uses it -> ${JSON.stringify(synced.customIds.filter((id) => !(id in synced.extensionURLs)))}`)

// ── E. does a pen block actually run? ───────────────────────────────────────
const penRun = await evaluate(connection, `(async () => {
  const vm = window.vm
  const runtime = vm.runtime
  const target = runtime.targets.find((t) => !t.isStage)
  vm.setEditingTarget(target.id)
  vm.stopAll()
  for (const id of [...target.blocks.getScripts()]) target.blocks.deleteBlock(id)

  target.blocks.createBlock({ id: 'sHat', opcode: 'event_whenflagclicked', next: 'sSize', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 40, y: 40 })
  target.blocks.createBlock({ id: 'sSize', opcode: 'pen_setPenSizeTo', next: 'sDown', parent: 'sHat', inputs: { SIZE: { name: 'SIZE', block: 'sNum', shadow: 'sNum' } }, fields: {}, shadow: false, topLevel: false })
  target.blocks.createBlock({ id: 'sDown', opcode: 'pen_penDown', next: 'sMove', parent: 'sSize', inputs: {}, fields: {}, shadow: false, topLevel: false })
  target.blocks.createBlock({ id: 'sMove', opcode: 'motion_changexby', next: null, parent: 'sDown', inputs: { DX: { name: 'DX', block: 'sNum2', shadow: 'sNum2' } }, fields: {}, shadow: false, topLevel: false })
  target.blocks.createBlock({ id: 'sNum', opcode: 'math_number', next: null, parent: 'sSize', inputs: {}, fields: { NUM: { name: 'NUM', value: '9' } }, shadow: true, topLevel: false })
  target.blocks.createBlock({ id: 'sNum2', opcode: 'math_number', next: null, parent: 'sMove', inputs: {}, fields: { NUM: { name: 'NUM', value: '50' } }, shadow: true, topLevel: false })

  const startX = target.x
  let error = null
  try {
    vm.greenFlag()
    for (let i = 0; i < 6; i++) runtime._step()
  } catch (e) { error = String(e && e.message) }
  runtime.stopAll?.()

  const penState = target.getCustomState('Scratch.pen')
  return JSON.stringify({
    error,
    movedBy: target.x - startX,
    penStateLocation: penState ? 'target.getCustomState("Scratch.pen")' : 'MISSING',
    penDown: penState ? penState.penDown : null,
    diameter: penState && penState.penAttributes ? penState.penAttributes.diameter : null
  }, null, 1)
})()`, { awaitPromise: true, timeoutMs: 60000 })
console.log('\nE. did the pen block actually run?')
console.log(penRun)

console.log(`
NOTE: extensions are never unloaded. If this probe left pen/music/text on, every later
      run in this editor session sees them as "already loaded", and only a TurboWarp
      restart gives a truly clean slate. A data: URL would additionally strand a worker
      permanently — do not add one to this file.`)

connection.close()

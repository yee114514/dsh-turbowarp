/**
 * Extensions: what they are, which ones are built in, and how their blocks are named.
 *
 * This module is deliberately pure. Everything here is knowledge about the extension
 * SYSTEM rather than about a running editor, so it can be tested offline and used by
 * the offline (file-only) path too.
 *
 * Three facts drive the design, all established by probing a live editor
 * (`tools/spike-extensions*.mjs`) and by reading upstream
 * (`scratch-vm/src/extension-support/extension-manager.js`):
 *
 *   1. A built-in extension has an ID (`pen`, `music`, ...) which is ALSO how
 *      `loadExtensionURL` is called for it. Custom extensions are loaded by URL.
 *   2. An extension block's runtime opcode is `<extensionId>_<opcode>`, but the
 *      category metadata reports the BARE opcode. Building `pen_clear` from the
 *      category requires adding the prefix yourself — reading `clear` and expecting
 *      it to run silently does nothing.
 *   3. A project's `extensions` array is DERIVED: the serializer collects the
 *      extension IDs actually used by the blocks in the project. Loading an extension
 *      and not using it therefore leaves no trace, and using one whose extension is
 *      not loaded produces a project that cannot run. Both directions matter.
 */

import { ProjectError } from './project.mjs'

/**
 * The built-in extensions this VM ships, from
 * `extension-manager.js` `defaultBuiltinExtensions`.
 *
 * `coreExample` is omitted on purpose: upstream describes it as a reference sample
 * that is not loaded with the other core blocks, so offering it to a model would be
 * offering a dead end.
 *
 * @type {ReadonlyArray<{id: string, name: string, summary: string}>}
 */
export const BUILTIN_EXTENSIONS = Object.freeze([
  { id: 'pen', name: 'Pen', summary: 'draw lines and stamp the sprite onto the stage' },
  { id: 'music', name: 'Music', summary: 'play notes and drums, change tempo' },
  { id: 'text2speech', name: 'Text to Speech', summary: 'speak words out loud' },
  { id: 'translate', name: 'Translate', summary: 'translate text between languages' },
  { id: 'videoSensing', name: 'Video Sensing', summary: 'react to the camera image and its motion' },
  { id: 'makeymakey', name: 'Makey Makey', summary: 'react to a Makey Makey board' },
  { id: 'microbit', name: 'micro:bit', summary: 'talk to a micro:bit over Bluetooth' },
  { id: 'wedo2', name: 'LEGO WeDo 2.0', summary: 'drive LEGO WeDo 2.0 motors and sensors' },
  { id: 'ev3', name: 'LEGO EV3', summary: 'drive a LEGO EV3 brick' },
  { id: 'boost', name: 'LEGO BOOST', summary: 'drive LEGO BOOST motors and sensors' },
  { id: 'gdxfor', name: 'Go Direct Force & Acceleration', summary: 'read a Vernier force sensor' },
  { id: 'tw', name: 'TurboWarp', summary: 'TurboWarp extras: custom reporters, cloud, and more' }
])

/** Extension IDs that are built in, as a Set for membership tests. */
const BUILTIN_IDS = new Set(BUILTIN_EXTENSIONS.map((extension) => extension.id))

/**
 * The prefixes an opcode can carry while belonging to CORE Scratch rather than an
 * extension.
 *
 * Derived rather than guessed. The rule that makes this decidable: an extension
 * opcode is always `<id>_<something>` (upstream builds it that way in
 * `runtime._registerExtensionPrimitives`), while core opcodes either have no
 * underscore at all or use one of the namespaces below.
 *
 * The trap is `text`: Scratch's text INPUT is the opcode `text` with no underscore,
 * so `text_...` is not core — it is the Animated Text extension, whose ID happens to
 * be `text`. An earlier version listed `text` here and therefore failed to notice the
 * extension. `colour_picker` is likewise a whole opcode, not a namespace.
 *
 * @type {ReadonlySet<string>}
 */
const CORE_PREFIXES = new Set([
  'motion', 'looks', 'sound', 'event', 'control', 'sensing', 'operator',
  'data', 'procedures', 'argument', 'math', 'colour'
])

/** Other extension IDs that exist in the wider Scratch world but not in this VM. */
const KNOWN_UNSUPPORTED_IDS = new Set([
  'speech', 'videoSensingOld', 'gdxforOld', 'arduino', 'pico', 'hid',
  'faceSensing', 'sensing', 'soundMachine', 'clipboard', 'fetch', 'files',
  'localStorage', 'runtimeOptions', 'stretch', 'internet', 'debugger',
  'bitty', 'xhr', 'skins', 'animatedText', 'text'
])

/**
 * Whether an extension ID is built into this VM.
 * @param {string} id the extension ID
 * @returns {boolean} true when `loadExtensionURL(id)` would load it
 */
export const isBuiltinExtension = (id) => BUILTIN_IDS.has(String(id))

/**
 * The built-in extension whose ID an opcode belongs to, or null for core blocks.
 *
 * The mapping is not always "prefix === id" in the wider Scratch ecosystem, but in
 * THIS VM every extension's opcodes are prefixed with its own ID — the `tw` extension
 * included (`tw_...`). Custom extensions follow the same rule with their own `id`
 * field, which is why the prefix is the only reliable signal available offline.
 *
 * @param {string} opcode a block opcode
 * @returns {string|null} the extension ID, or null when this looks like a core block
 */
export const extensionOfOpcode = (opcode) => {
  if (typeof opcode !== 'string') return null
  const cut = opcode.indexOf('_')
  if (cut <= 0) return null
  const prefix = opcode.slice(0, cut)
  if (CORE_PREFIXES.has(prefix)) return null
  return prefix
}

/**
 * The runtime opcode for a block as an extension's own category metadata names it.
 *
 * Extension categories list `clear`, but the block that runs is `pen_clear`. This
 * function is the whole reason the plugin can tell a model "the category says
 * `penDown`; write `pen_penDown`".
 *
 * @param {string} extensionId the extension ID
 * @param {string} opcode the bare opcode from the category
 * @returns {string} the opcode as it appears in a compiled project
 */
export const qualifyOpcode = (extensionId, opcode) => {
  const bare = String(opcode)
  // Some categories already include the prefix; do not double it.
  return bare.startsWith(`${extensionId}_`) ? bare : `${extensionId}_${bare}`
}

/**
 * Strip an extension prefix from an opcode, giving the bare form a category uses.
 * @param {string} extensionId the extension ID
 * @param {string} opcode the qualified opcode
 * @returns {string} the bare opcode
 */
export const bareOpcode = (extensionId, opcode) => {
  const prefix = `${extensionId}_`
  return String(opcode).startsWith(prefix) ? String(opcode).slice(prefix.length) : String(opcode)
}

/**
 * Every extension a project's block graph depends on, with what is known about each.
 *
 * This is the offline counterpart of asking the VM. It answers "will this project run
 * here?" without opening anything, and it is what `scratch_inspect {path}` reports.
 *
 * @param {any} project parsed project document
 * @returns {{id: string, builtin: boolean, blocks: number, samples: string[], url: string|null}[]} the extensions in use
 */
export const extensionsUsedByProject = (project) => {
  const counts = new Map()
  for (const target of project?.targets ?? []) {
    for (const block of Object.values(target.blocks ?? {})) {
      // A top-level primitive is a bare array and carries no opcode of its own.
      if (Array.isArray(block)) continue
      const id = extensionOfOpcode(block?.opcode)
      if (id === null) continue
      const entry = counts.get(id) ?? { blocks: 0, samples: [] }
      entry.blocks++
      if (entry.samples.length < 4 && !entry.samples.includes(block.opcode)) entry.samples.push(block.opcode)
      counts.set(id, entry)
    }
  }

  // A project also DECLARES extensions it depends on. That list is what the serializer
  // writes, so it can name an extension whose blocks were since deleted; report the
  // union so a stale declaration is visible rather than invisible.
  for (const declared of project?.extensions ?? []) {
    if (typeof declared !== 'string' || declared.length === 0) continue
    if (!counts.has(declared)) counts.set(declared, { blocks: 0, samples: [] })
  }
  for (const target of project?.targets ?? []) {
    for (const id of Object.keys(target.extensionStorage ?? {})) {
      if (!counts.has(id)) counts.set(id, { blocks: 0, samples: [] })
    }
  }

  // Custom extension URLs live at the document's TOP LEVEL (see recordExtensionURL).
  const urls = project?.extensionURLs ?? {}
  return [...counts.entries()]
    .map(([id, entry]) => ({
      id,
      builtin: isBuiltinExtension(id),
      blocks: entry.blocks,
      samples: entry.samples,
      url: typeof urls[id] === 'string' ? urls[id] : null
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The extension declarations a project is missing for the blocks it contains.
 *
 * @param {any} project parsed project document
 * @returns {string[]} extension IDs in use but not declared
 */
export const missingDeclarations = (project) => {
  const declared = new Set(
    (project?.extensions ?? []).filter((id) => typeof id === 'string' && id.length > 0)
  )
  return extensionsUsedByProject(project)
    .filter((extension) => extension.blocks > 0 && !declared.has(extension.id))
    .map((extension) => extension.id)
}

/**
 * Add an extension to a project document's `extensions` list.
 *
 * Editing this list is normally unnecessary — the live serializer derives it from the
 * blocks in use — but the OFFLINE path writes the document itself, so it has to keep
 * the list honest or the resulting `.sb3` would claim to need nothing.
 *
 * @param {any} project parsed project document (mutated in place)
 * @param {string} id the extension ID
 * @returns {boolean} whether the list changed
 */
export const declareExtension = (project, id) => {
  const name = String(id)
  if (name.length === 0) throw new ProjectError('an extension id cannot be empty')
  project.extensions = Array.isArray(project.extensions) ? project.extensions : []
  if (project.extensions.includes(name)) return false
  project.extensions.push(name)
  return true
}

/**
 * Record where a CUSTOM extension's code came from.
 *
 * Built-in extensions have no URL — they are part of the VM. A custom one needs its
 * URL stored so the project can load the extension again on another machine.
 *
 * The location is the document's TOP-LEVEL `extensionURLs`, not `meta`. Verified in
 * `scratch-vm/src/serialization/sb3.js`: `serialize` writes `obj.extensionURLs`
 * (line 740-743) and `deserialize` reads `json.extensionURLs` (line 1546). Putting it
 * under `meta` looks tidy and is silently ignored by both.
 *
 * Note also that the serializer only writes an entry for an extension that some block
 * USES (`getExtensionURLsToSave(extensionIDs, runtime)`, line 301-322), so a custom
 * extension that is loaded but unused is not recorded — which is consistent with the
 * `extensions` array and means loading one is only half the job.
 *
 * @param {any} project parsed project document (mutated in place)
 * @param {string} id the extension ID
 * @param {string} url the URL its code came from
 * @returns {boolean} whether anything changed
 */
export const recordExtensionURL = (project, id, url) => {
  if (typeof url !== 'string' || url.length === 0) return false
  if (isBuiltinExtension(id)) return false
  project.extensionURLs = project.extensionURLs ?? {}
  if (project.extensionURLs[id] === url) return false
  project.extensionURLs[id] = url
  declareExtension(project, id)
  return true
}

/**
 * Describe the extensions a project needs, for tool output.
 *
 * @param {any} project parsed project document
 * @returns {string[]} human-readable lines
 */
export const describeExtensions = (project) => {
  const used = extensionsUsedByProject(project)
  if (used.length === 0) return ['extensions: (none)']
  const lines = ['extensions:']
  for (const extension of used) {
    const origin = extension.builtin
      ? 'built into TurboWarp'
      : (extension.url === null ? 'custom — URL not recorded, so it cannot be reloaded' : `custom from ${extension.url}`)
    const usage = extension.blocks === 0
      ? 'declared but no blocks use it'
      : `${extension.blocks} block(s), e.g. ${extension.samples.join(', ')}`
    lines.push(`  ${extension.id} — ${origin}; ${usage}`)
  }
  return lines
}
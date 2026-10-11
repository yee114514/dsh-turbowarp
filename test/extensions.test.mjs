import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILTIN_EXTENSIONS,
  bareOpcode,
  declareExtension,
  describeExtensions,
  extensionOfOpcode,
  extensionsUsedByProject,
  isBuiltinExtension,
  missingDeclarations,
  qualifyOpcode,
  recordExtensionURL
} from '../src/scratch/extensions.mjs'
import { ProjectError } from '../src/scratch/project.mjs'

/**
 * Extensions, offline.
 *
 * The point of these tests is the two facts a tool gets wrong by guessing: that an
 * extension category names its blocks WITHOUT the prefix while the compiled opcode
 * carries it, and that a project's `extensions` list is derived from the blocks in
 * use rather than from what the VM has loaded.
 */

test('knows the built-in extensions this VM ships', () => {
  const ids = BUILTIN_EXTENSIONS.map((extension) => extension.id)
  assert.deepEqual(ids, [
    'pen', 'music', 'text2speech', 'translate', 'videoSensing', 'makeymakey',
    'microbit', 'wedo2', 'ev3', 'boost', 'gdxfor', 'tw'
  ])
  // coreExample is upstream's reference sample, not something to offer a model.
  assert.ok(!ids.includes('coreExample'))
  for (const extension of BUILTIN_EXTENSIONS) {
    assert.ok(extension.name.length > 0, `${extension.id} needs a name`)
    assert.ok(extension.summary.length > 0, `${extension.id} needs a summary`)
  }
})

test('isBuiltinExtension answers for the known ids only', () => {
  assert.equal(isBuiltinExtension('pen'), true)
  assert.equal(isBuiltinExtension('tw'), true)
  assert.equal(isBuiltinExtension('coreExample'), false)
  assert.equal(isBuiltinExtension('someCustomThing'), false)
  assert.equal(isBuiltinExtension(''), false)
})

test('extensionOfOpcode separates extension blocks from core blocks', () => {
  assert.equal(extensionOfOpcode('pen_clear'), 'pen')
  assert.equal(extensionOfOpcode('tw_getTime'), 'tw')
  assert.equal(extensionOfOpcode('someCustomExtension_doThing'), 'someCustomExtension')
  // Core namespaces are not extensions.
  for (const opcode of [
    'motion_movesteps', 'looks_say', 'sound_play', 'event_whenflagclicked',
    'control_repeat', 'sensing_touchingobject', 'operator_add', 'data_setvariableto',
    'procedures_call', 'argument_reporter_string_number'
  ]) {
    assert.equal(extensionOfOpcode(opcode), null, opcode)
  }
  // Degenerate inputs must not throw or produce nonsense.
  assert.equal(extensionOfOpcode('noUnderscore'), null)
  assert.equal(extensionOfOpcode('_leading'), null)
  assert.equal(extensionOfOpcode(''), null)
  assert.equal(extensionOfOpcode(undefined), null)
})

test("a core opcode with no underscore is not mistaken for an extension", () => {
  // The trap this guards: Scratch's text input is the opcode `text`, with NO
  // underscore, while the Animated Text extension's blocks are `text_*`. Listing
  // "text" as a core prefix therefore hides a real extension dependency.
  assert.equal(extensionOfOpcode('text'), null, 'the text input primitive is core')
  assert.equal(extensionOfOpcode('text_setText'), 'text', 'but text_* is the extension')
  assert.equal(extensionOfOpcode('colour_picker'), null, 'colour_picker is a whole opcode')
  assert.equal(extensionOfOpcode('math_number'), null)
  assert.equal(extensionOfOpcode('data_variable'), null)
  assert.equal(extensionOfOpcode('event_broadcast_menu'), null)
})

test('qualifyOpcode adds the prefix the category leaves off', () => {
  // This is the trap: the pen category lists `penDown`, the running block is `pen_penDown`.
  assert.equal(qualifyOpcode('pen', 'penDown'), 'pen_penDown')
  assert.equal(qualifyOpcode('pen', 'clear'), 'pen_clear')
  assert.equal(qualifyOpcode('text', 'setText'), 'text_setText')
  // Already qualified: leave it alone rather than doubling the prefix.
  assert.equal(qualifyOpcode('pen', 'pen_clear'), 'pen_clear')
})

test('bareOpcode is the inverse', () => {
  assert.equal(bareOpcode('pen', 'pen_penDown'), 'penDown')
  assert.equal(bareOpcode('pen', 'pen_clear'), 'clear')
  assert.equal(bareOpcode('pen', 'motion_movesteps'), 'motion_movesteps')
})

test('extensionsUsedByProject counts the blocks that need each extension', () => {
  const project = {
    extensions: ['pen'],
    targets: [{
      isStage: false,
      blocks: {
        hat: { opcode: 'event_whenflagclicked', inputs: {}, fields: {}, next: 'a' },
        a: { opcode: 'pen_clear', inputs: {}, fields: {} },
        b: { opcode: 'pen_penDown', inputs: {}, fields: {} },
        c: { opcode: 'motion_movesteps', inputs: {}, fields: {} },
        // A top-level primitive is a bare array and has no opcode.
        d: [12, 'score', 'v1', 10, 20]
      }
    }]
  }
  const used = extensionsUsedByProject(project)
  assert.equal(used.length, 1)
  assert.deepEqual(used[0], {
    id: 'pen',
    builtin: true,
    blocks: 2,
    samples: ['pen_clear', 'pen_penDown'],
    url: null
  })
})

test('reports an extension that is declared but unused', () => {
  const project = { extensions: ['music'], targets: [{ isStage: false, blocks: {} }] }
  const used = extensionsUsedByProject(project)
  assert.equal(used.length, 1)
  assert.equal(used[0].id, 'music')
  assert.equal(used[0].blocks, 0)
})

test('picks up extensions from blocks even when the declaration is missing', () => {
  // This is the dangerous case: the project uses pen but does not list it.
  const project = {
    targets: [{ isStage: false, blocks: { a: { opcode: 'pen_stamp', inputs: {}, fields: {} } } }]
  }
  const used = extensionsUsedByProject(project)
  assert.deepEqual(used.map((extension) => extension.id), ['pen'])
  assert.deepEqual(missingDeclarations(project), ['pen'])
})

test('missingDeclarations is empty when the project is consistent', () => {
  const project = {
    extensions: ['pen'],
    targets: [{ isStage: false, blocks: { a: { opcode: 'pen_stamp', inputs: {}, fields: {} } } }]
  }
  assert.deepEqual(missingDeclarations(project), [])
})

test('reads a custom extension URL out of the top-level extensionURLs', () => {
  // NOT meta.extensionURLs: the serializer writes and the deserializer reads
  // the document's top-level `extensionURLs` (sb3.js:740 and :1546). Putting it
  // under `meta` is ignored by both, which is a silent, project-breaking mistake.
  const project = {
    extensions: ['text'],
    extensionURLs: { text: 'https://extensions.turbowarp.org/lab/text.js' },
    targets: [{ isStage: false, blocks: { a: { opcode: 'text_setText', inputs: {}, fields: {} } } }]
  }
  const used = extensionsUsedByProject(project)
  assert.equal(used[0].builtin, false)
  assert.equal(used[0].url, 'https://extensions.turbowarp.org/lab/text.js')
  assert.deepEqual(missingDeclarations(project), [])
})

test('does NOT look for the URL under meta', () => {
  const project = {
    extensions: ['text'],
    meta: { extensionURLs: { text: 'https://example.com/wrong-place.js' } },
    targets: [{ isStage: false, blocks: { a: { opcode: 'text_setText', inputs: {}, fields: {} } } }]
  }
  assert.equal(extensionsUsedByProject(project)[0].url, null, 'meta is the wrong place')
})

test('sees extension state kept on a target', () => {
  const project = {
    targets: [{ isStage: false, blocks: {}, extensionStorage: { someExt: { value: 1 } } }]
  }
  assert.deepEqual(extensionsUsedByProject(project).map((extension) => extension.id), ['someExt'])
})

test('declareExtension adds once and rejects an empty id', () => {
  const project = {}
  assert.equal(declareExtension(project, 'pen'), true)
  assert.equal(declareExtension(project, 'pen'), false)
  assert.deepEqual(project.extensions, ['pen'])
  assert.throws(() => declareExtension(project, ''), ProjectError)
})

test('recordExtensionURL stores the URL at the top level and declares the extension', () => {
  const project = {}
  const url = 'https://example.com/ext.js'
  assert.equal(recordExtensionURL(project, 'myExt', url), true)
  assert.equal(project.extensionURLs.myExt, url, 'top level, where the serializer looks')
  assert.equal(project.meta, undefined, 'and NOT under meta')
  assert.deepEqual(project.extensions, ['myExt'])
  // Idempotent.
  assert.equal(recordExtensionURL(project, 'myExt', url), false)
})

test('recordExtensionURL ignores built-ins', () => {
  // A built-in has no URL: it is part of the VM, so recording one would be a lie.
  const project = {}
  assert.equal(recordExtensionURL(project, 'pen', 'https://example.com/pen.js'), false)
  assert.equal(project.extensionURLs, undefined)
})

test('describeExtensions says what a human needs to know', () => {
  const project = {
    extensions: ['pen', 'text', 'music'],
    extensionURLs: { text: 'https://example.com/text.js' },
    targets: [{
      isStage: false,
      blocks: {
        a: { opcode: 'pen_clear', inputs: {}, fields: {} },
        b: { opcode: 'text_setText', inputs: {}, fields: {} }
      }
    }]
  }
  const lines = describeExtensions(project).join('\n')
  assert.match(lines, /pen — built into TurboWarp; 1 block\(s\), e\.g\. pen_clear/)
  assert.match(lines, /text — custom from https:\/\/example\.com\/text\.js; 1 block\(s\)/)
  // Declared but unused is worth saying out loud: it usually means a script was deleted.
  assert.match(lines, /music — built into TurboWarp; declared but no blocks use it/)
})

test('describeExtensions handles a project with no extensions', () => {
  assert.deepEqual(describeExtensions({ targets: [{ blocks: {} }] }), ['extensions: (none)'])
  assert.deepEqual(describeExtensions({}), ['extensions: (none)'])
})

test('warns about a custom extension whose URL was not recorded', () => {
  const project = {
    extensions: ['mystery'],
    targets: [{ isStage: false, blocks: { a: { opcode: 'mystery_thing', inputs: {}, fields: {} } } }]
  }
  const lines = describeExtensions(project).join('\n')
  assert.match(lines, /mystery — custom — URL not recorded, so it cannot be reloaded/)
})

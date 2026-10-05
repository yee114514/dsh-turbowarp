/**
 * The `.sb3` container: `project.json` plus one ZIP entry per asset.
 *
 * An asset is addressed by `md5ext` — the hex MD5 of its bytes, a dot, and the
 * data format ("svg", "png", "wav", …). Scratch resolves every costume and sound
 * through that name, so the mapping from bytes to name has to be exact: a wrong
 * md5ext yields a project that loads but renders blank.
 *
 * The container layer is deliberately thin. It does not interpret blocks; that is
 * `src/scratch/xml.mjs` and `src/scratch/project.mjs`.
 */

import { createHash } from 'node:crypto'

import { readZip, writeZip, ZipError } from './zip.mjs'

/** Raised when bytes are not a usable Scratch 3 project. */
export class Sb3Error extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'Sb3Error'
  }
}

/** Entry name of the project document inside the archive. */
export const PROJECT_ENTRY = 'project.json'

/** Asset formats Scratch 3 accepts for costumes. */
export const COSTUME_FORMATS = Object.freeze(['svg', 'png', 'jpg', 'jpeg', 'bmp', 'gif'])
/** Asset formats Scratch 3 accepts for sounds. */
export const SOUND_FORMATS = Object.freeze(['wav', 'mp3'])

/**
 * Compute an asset's `md5ext` from its bytes.
 * @param {Uint8Array} bytes asset content
 * @param {string} dataFormat extension without the dot, e.g. `svg`
 * @returns {string} `"<md5hex>.<dataFormat>"`
 */
export const assetMd5ext = (bytes, dataFormat) =>
  `${createHash('md5').update(bytes).digest('hex')}.${dataFormat}`

/**
 * List every asset name a project document references.
 * @param {any} project parsed project.json
 * @returns {string[]} md5exts, de-duplicated, in encounter order
 */
export const listAssetRefs = (project) => {
  const refs = []
  const seen = new Set()
  for (const target of project?.targets ?? []) {
    for (const collection of [target.costumes, target.sounds]) {
      for (const item of collection ?? []) {
        const md5ext = item?.md5ext
        if (typeof md5ext !== 'string' || seen.has(md5ext)) continue
        seen.add(md5ext)
        refs.push(md5ext)
      }
    }
  }
  return refs
}

/**
 * Parse `.sb3` bytes.
 *
 * Assets are returned keyed by `md5ext`. A reference without a matching entry is
 * reported as a warning rather than an error: the project still loads in Scratch
 * (with a missing costume), and the caller may want to repair it.
 *
 * @param {Uint8Array} bytes archive content
 * @returns {{project: any, assets: Map<string, Buffer>, warnings: string[]}} parsed container
 * @throws {Sb3Error} when the archive is unreadable or has no project document
 */
export function readSb3 (bytes) {
  let entries
  try {
    entries = readZip(bytes)
  } catch (error) {
    if (error instanceof ZipError) throw new Sb3Error(`not a readable .sb3 archive: ${error.message}`, { cause: error })
    throw error
  }

  const projectBytes = entries.get(PROJECT_ENTRY)
  if (projectBytes === undefined) {
    throw new Sb3Error(`the archive has no ${PROJECT_ENTRY}; found ${[...entries.keys()].join(', ') || '(nothing)'}`)
  }

  let project
  try {
    project = JSON.parse(projectBytes.toString('utf8'))
  } catch (error) {
    throw new Sb3Error(`${PROJECT_ENTRY} is not valid JSON: ${error.message}`, { cause: error })
  }
  if (!Array.isArray(project?.targets)) {
    throw new Sb3Error(`${PROJECT_ENTRY} has no targets array`)
  }

  /** @type {Map<string, Buffer>} */
  const assets = new Map()
  for (const [name, data] of entries) {
    if (name === PROJECT_ENTRY) continue
    assets.set(name, data)
  }

  const warnings = []
  for (const reference of listAssetRefs(project)) {
    if (assets.has(reference)) continue
    warnings.push(`asset ${reference} is referenced by the project but missing from the archive`)
  }
  for (const name of assets.keys()) {
    if (listAssetRefs(project).includes(name)) continue
    warnings.push(`asset ${name} is in the archive but not referenced by the project`)
  }

  return { project, assets, warnings }
}

/**
 * Serialize a project document and its assets into `.sb3` bytes.
 *
 * @param {any} project the project document
 * @param {Map<string, Uint8Array>|Record<string, Uint8Array>} [assets] md5ext -> bytes
 * @param {{compress?: boolean}} [options] passed through to the ZIP writer
 * @returns {Buffer} archive bytes
 * @throws {Sb3Error} when the project document is unusable
 */
export function writeSb3 (project, assets = new Map(), options = {}) {
  if (!Array.isArray(project?.targets)) throw new Sb3Error('refusing to write a project without a targets array')

  const entries = [{
    name: PROJECT_ENTRY,
    data: Buffer.from(JSON.stringify(project), 'utf8')
  }]

  const iterable = assets instanceof Map ? assets.entries() : Object.entries(assets)
  for (const [name, data] of iterable) {
    if (name === PROJECT_ENTRY) throw new Sb3Error(`asset name ${PROJECT_ENTRY} is reserved for the project document`)
    entries.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data) })
  }

  // project.json must stay readable even if an asset is corrupt; the ZIP writer
  // compresses every entry independently, so one bad asset cannot break the rest.
  return writeZip(entries, { compress: options.compress ?? true })
}

/**
 * A minimal, valid Scratch 3 project: one stage, no sprites, no costumes.
 *
 * Kept deliberately asset-free so the plugin can create a project without
 * bundling any Scratch artwork.
 *
 * @param {{name?: string}} [options] stage name
 * @returns {any} a fresh project document
 */
export const blankProject = (options = {}) => ({
  targets: [{
    isStage: true,
    name: options.name ?? 'Stage',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    tempo: 60,
    videoTransparency: 50,
    videoState: 'off',
    textToSpeechLanguage: null
  }],
  monitors: [],
  extensions: [],
  meta: {
    semver: '3.0.0',
    vm: '0.2.0',
    agent: 'dsh-turbowarp'
  }
})

/**
 * A plain default costume for a generated sprite.
 *
 * Drawn here rather than copied from Scratch so the plugin bundles no artwork: the
 * point is to have *something* with a sane rotation centre, which the author then
 * replaces with their own.
 */
export const DEFAULT_SPRITE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60">' +
  '<circle cx="30" cy="30" r="28" fill="#4c97ff" stroke="#3373cc" stroke-width="2"/>' +
  '</svg>'

/**
 * Build a sprite target plus the asset its costume needs.
 *
 * A Scratch project cannot do anything without at least one sprite, and a sprite
 * with no costume cannot be rendered — so "a new project" means a stage, a sprite,
 * and one costume. The asset travels with the target so a caller can write both into
 * an archive.
 *
 * @param {{name?: string, svg?: string, layerOrder?: number, rotationCenterX?: number, rotationCenterY?: number}} [options] what to build
 * @returns {{target: any, assets: Map<string, Buffer>}} the target and its assets
 */
export const buildSprite = (options = {}) => {
  const svg = typeof options.svg === 'string' && options.svg.length > 0 ? options.svg : DEFAULT_SPRITE_SVG
  const bytes = Buffer.from(svg, 'utf8')
  const md5ext = assetMd5ext(bytes, 'svg')
  const center = options.rotationCenterX !== undefined && options.rotationCenterY !== undefined
    ? { x: options.rotationCenterX, y: options.rotationCenterY }
    : { x: 30, y: 30 }

  const target = {
    isStage: false,
    name: options.name ?? 'Sprite1',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [{
      name: 'costume1',
      dataFormat: 'svg',
      assetId: md5ext.split('.')[0],
      md5ext,
      bitmapResolution: 1,
      rotationCenterX: center.x,
      rotationCenterY: center.y
    }],
    sounds: [],
    volume: 100,
    layerOrder: options.layerOrder ?? 1,
    visible: true,
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around'
  }

  return { target, assets: new Map([[md5ext, bytes]]) }
}

/**
 * A brand-new project that can actually be used: a stage and one sprite.
 *
 * `blankProject` alone is a stage with nothing in it, which Scratch cannot even
 * show a script for. This is what "start a new project" means for a tool.
 *
 * @param {{spriteName?: string, spriteSvg?: string, stageName?: string}} [options] naming
 * @returns {{project: any, assets: Map<string, Buffer>}} the project and its assets
 */
export const starterProject = (options = {}) => {
  const project = blankProject({ name: options.stageName })
  const { target, assets } = buildSprite({
    name: options.spriteName ?? 'Sprite1',
    svg: options.spriteSvg,
    layerOrder: 1
  })
  project.targets.push(target)
  return { project, assets }
}

/**
 * Summarize what a container holds, for tool output.
 * @param {any} project parsed project document
 * @param {Map<string, Uint8Array>} assets asset map
 * @returns {{targets: {name: string, isStage: boolean, blocks: number, costumes: number, sounds: number}[], assetCount: number, assetBytes: number}} summary
 */
export const summarizeContainer = (project, assets) => {
  let assetBytes = 0
  for (const data of assets.values()) assetBytes += data.length
  return {
    targets: (project.targets ?? []).map((target) => ({
      name: target.name,
      isStage: target.isStage === true,
      blocks: Object.keys(target.blocks ?? {}).length,
      costumes: (target.costumes ?? []).length,
      sounds: (target.sounds ?? []).length
    })),
    assetCount: assets.size,
    assetBytes
  }
}

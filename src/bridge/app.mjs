/**
 * Locating, launching and attaching to TurboWarp Desktop.
 *
 * TurboWarp has to be started with `--remote-debugging-port=<n>` for the bridge to
 * reach it. Verified on the v1.16.0 Windows portable build: the portable launcher
 * forwards the switch, the endpoint answers within ~12s of a cold start, and the
 * editor page appears as a `tw-editor://` target.
 *
 * Launching is the plugin's job rather than the user's because TurboWarp takes a
 * single-instance lock (`src-main/index.js:13`): a copy the user started from the
 * Start Menu has no debug port, and a second launch would just focus it. So when
 * the port is closed but the process is running, the honest answer is "restart it
 * through scratch_launch", not a silent failure.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { CdpConnection, CdpUnreachableError, listTargets } from './cdp.mjs'

/** Raised when the app cannot be found, started, or attached to. */
export class AppUnavailableError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'AppUnavailableError'
  }
}

/** Default debug port. Chosen to match common Electron debugging habits. */
export const DEFAULT_PORT = 9222

/** The editor page's URL prefix; used to pick the right target. */
const EDITOR_URL_PREFIX = 'tw-editor://'

/**
 * Candidate install locations for a packaged TurboWarp, in preference order.
 * @returns {string[]} absolute paths that may or may not exist
 */
export const candidateAppPaths = () => {
  const candidates = []
  const localAppData = process.env.LOCALAPPDATA
  const programFiles = process.env.PROGRAMFILES
  const programFilesX86 = process.env['PROGRAMFILES(X86)']
  if (localAppData) candidates.push(join(localAppData, 'Programs', 'TurboWarp', 'TurboWarp.exe'))
  if (programFiles) candidates.push(join(programFiles, 'TurboWarp', 'TurboWarp.exe'))
  if (programFilesX86) candidates.push(join(programFilesX86, 'TurboWarp', 'TurboWarp.exe'))
  return candidates
}

/**
 * Where a launch that worked is remembered between sessions.
 *
 * "Where is TurboWarp installed" is a machine-level fact, and the plugin is
 * installed into more than one profile — remembering it here means passing
 * `appPath` to `scratch_launch` once is enough, instead of configuring an
 * environment variable in every profile.
 *
 * @returns {string} absolute path of the state file
 */
const stateFile = () => {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'turbowarp.json')
}

/**
 * The same file under the name this plugin used before it was renamed.
 *
 * Only read, never written. A rename is not a good reason to make somebody point at
 * their TurboWarp.exe all over again.
 *
 * @returns {string} absolute path of the old state file
 */
const legacyStateFile = () => {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'turbowarp-scratch.json')
}

/**
 * Read the remembered executable path.
 * @returns {string|null} the path, when one was remembered and still exists
 */
export const recallAppPath = () => {
  for (const candidate of [stateFile(), legacyStateFile()]) {
    try {
      const state = JSON.parse(readFileSync(candidate, 'utf8'))
      const remembered = state?.appPath
      if (typeof remembered === 'string' && existsSync(remembered)) return remembered
    } catch {
      // Missing or unreadable: try the next name.
    }
  }
  return null
}

/**
 * Remember an executable path that launched successfully.
 *
 * Failure is ignored on purpose: not being able to write a convenience file must
 * never fail the launch the caller actually asked for.
 *
 * @param {string} appPath the path that worked
 */
export const rememberAppPath = (appPath) => {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), `${JSON.stringify({ appPath, rememberedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  } catch {
    // Convenience only.
  }
}

/**
 * Find a packaged TurboWarp executable.
 *
 * An explicit path is a decision and is honoured as given: if it does not exist,
 * this returns null rather than quietly substituting a remembered path. Silently
 * ignoring configuration makes "I set appPath and it still used something else"
 * impossible to diagnose — and it turned a unit test into something that launched
 * a real editor as a side effect.
 *
 * With nothing configured: a previously working path, then the usual install
 * locations.
 *
 * @param {string} [configured] an explicit path from configuration
 * @returns {string|null} a usable path, or null
 */
export const resolveAppPath = (configured) => {
  if (typeof configured === 'string' && configured.length > 0) {
    return existsSync(configured) ? configured : null
  }
  const remembered = recallAppPath()
  if (remembered !== null) return remembered
  for (const candidate of candidateAppPaths()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Both debug endpoints that matter: `/json/list` answers as soon as the DevTools
 * server is up, which is before the editor page has finished loading.
 * @param {number} port debug port
 * @param {{timeoutMs?: number}} [options] per-request timeout
 * @returns {Promise<import('./cdp.mjs').CdpTarget[]>} targets
 */
export const probeTargets = async (port, options = {}) => {
  try {
    return await listTargets(port, { timeoutMs: options.timeoutMs ?? 2000 })
  } catch (error) {
    if (error instanceof CdpUnreachableError) return []
    throw error
  }
}

/**
 * Wait for the editor page target to appear.
 * @param {number} port debug port
 * @param {{timeoutMs?: number}} [options] how long to wait
 * @returns {Promise<import('./cdp.mjs').CdpTarget>} the editor target
 * @throws {AppUnavailableError} when it never appears
 */
export const waitForEditorTarget = async (port, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 45000
  const deadline = Date.now() + timeoutMs
  let lastSeen = []
  for (;;) {
    const targets = await probeTargets(port)
    lastSeen = targets.map((target) => `${target.type}:${target.url}`)
    const editor = targets.find((target) => target.type === 'page' &&
      typeof target.url === 'string' && target.url.startsWith(EDITOR_URL_PREFIX))
    if (editor !== undefined) return editor
    if (Date.now() >= deadline) {
      throw new AppUnavailableError(
        `the debug port ${port} answered but no editor page appeared within ${timeoutMs}ms` +
        (lastSeen.length > 0 ? ` (saw ${lastSeen.join(', ')})` : ' (no targets at all)')
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Attach to an already-running editor.
 * @param {{port?: number, timeoutMs?: number}} [options] attach options
 * @returns {Promise<{connection: CdpConnection, target: any, port: number}>} the attachment
 * @throws {AppUnavailableError} when the port is closed or the page is missing
 */
export const attach = async (options = {}) => {
  const port = options.port ?? DEFAULT_PORT
  const targets = await probeTargets(port, { timeoutMs: options.probeTimeoutMs ?? 2000 })
  if (targets.length === 0) {
    throw new AppUnavailableError(`nothing is listening on the DevTools port ${port}`)
  }
  const target = await waitForEditorTarget(port, { timeoutMs: options.timeoutMs ?? 10000 })
  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl)
  return { connection, target, port }
}

/**
 * Whether a TurboWarp process exists, regardless of whether it has a debug port.
 *
 * Used only to produce an actionable message: "it is running, but not with a debug
 * port — close it and call scratch_launch" rather than "not found".
 *
 * @returns {Promise<boolean>} true when a TurboWarp process is present
 */
export const isTurboWarpRunning = async () => {
  if (process.platform !== 'win32') return false
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq TurboWarp.exe', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(/TurboWarp\.exe/i.test(output)))
  })
}

/**
 * Start TurboWarp with a debug port and attach to it.
 *
 * The child is detached: closing the harness must not kill the user's editor, and
 * the plugin never terminates an app it did not need to keep alive.
 *
 * @param {{appPath: string, port?: number, extraArgs?: string[], timeoutMs?: number, cwd?: string}} options launch options
 * @returns {Promise<{connection: CdpConnection, target: any, port: number, pid: number|undefined}>} the attachment
 * @throws {AppUnavailableError} when the executable is missing or the app never comes up
 */
export const launchAndAttach = async (options) => {
  const appPath = options.appPath
  if (typeof appPath !== 'string' || appPath.length === 0) {
    throw new AppUnavailableError('no TurboWarp executable is configured and none was found in the usual locations')
  }
  if (!existsSync(appPath)) throw new AppUnavailableError(`no such executable: ${appPath}`)

  const port = options.port ?? DEFAULT_PORT
  const args = [`--remote-debugging-port=${port}`, ...(options.extraArgs ?? [])]

  const child = spawn(appPath, args, {
    detached: true,
    stdio: 'ignore',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd })
  })
  child.unref()

  const target = await waitForEditorTarget(port, { timeoutMs: options.timeoutMs ?? 45000 })
  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl)
  // A path that actually produced an editor is worth keeping: the next session
  // then needs no appPath argument at all.
  rememberAppPath(appPath)
  return { connection, target, port, pid: child.pid }
}

/**
 * Open a project file in a running TurboWarp by relaunching the executable with the
 * path as its argument.
 *
 * TurboWarp's single-instance lock routes the second launch to the existing window
 * (`src-main/index.js:246-251` → `EditorWindow.openFiles`), so the file opens
 * natively, with full asset handling, without shipping any bytes over CDP.
 *
 * @param {{appPath: string, filePath: string, port?: number}} options launch options
 * @returns {Promise<{pid: number|undefined}>} the relay process
 */
export const openFileInRunningApp = async (options) => {
  const child = spawn(options.appPath, [options.filePath], { detached: true, stdio: 'ignore' })
  child.unref()
  return { pid: child.pid }
}

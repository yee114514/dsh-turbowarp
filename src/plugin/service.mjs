/**
 * The process-wide bridge singleton.
 *
 * One DSH host process serves every session on a surface, and on the web surface
 * several sessions run at once. TurboWarp, by contrast, is a single application
 * with a single open project. So this service owns exactly one connection and one
 * open project, and serialises access to them:
 *
 *   - a **mutex** keeps compound operations from interleaving (a half-applied
 *     script would otherwise be visible to another session's screenshot);
 *   - a **lease** keeps two sessions from fighting over the project. Mutating
 *     operations take it; read-only ones still work but report the holder. It
 *     expires after `leaseIdleMs` of inactivity so an abandoned session cannot
 *     lock the editor forever.
 *
 * Nothing here decides policy about the app's lifetime: the plugin only ever
 * detaches. Killing an editor the user is looking at would be worse than leaving a
 * stale connection behind.
 */

import { attach, DEFAULT_PORT, isTurboWarpRunning, launchAndAttach, probeTargets, resolveAppPath } from '../bridge/app.mjs'
import { CdpError, CdpUnreachableError, isContextDestroyed } from '../bridge/cdp.mjs'
import { waitForVm } from '../bridge/ops.mjs'

/** Raised when a session tries to mutate a project another session holds. */
export class LeaseConflictError extends Error {
  constructor (message) {
    super(message)
    this.name = 'LeaseConflictError'
  }
}

/** Raised when the editor cannot be reached and the caller must act. */
export class BridgeUnavailableError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'BridgeUnavailableError'
  }
}

export class BridgeService {
  #config
  /** @type {import('../bridge/cdp.mjs').CdpConnection|null} */
  #connection = null
  #port
  #lastError = null
  /** @type {{sessionId: string, at: number}|null} */
  #lease = null
  /** Tail of the serialisation chain. */
  #queue = Promise.resolve()

  /**
   * @param {{appPath?: string, port?: number, autoLaunch?: boolean, leaseIdleMs?: number, launchTimeoutMs?: number, debug?: boolean}} config resolved plugin config
   */
  constructor (config) {
    this.#config = config
    this.#port = config.port ?? DEFAULT_PORT
  }

  /** The configured debug port. */
  get port () {
    return this.#port
  }

  /** Diagnostic logging goes to stderr; stdout must stay quiet inside the TUI. */
  #log (message) {
    if (this.#config.debug === true) process.stderr.write(`[turbowarp-scratch] ${message}\n`)
  }

  /**
   * Serialise one operation against every other operation on this process.
   * @template T
   * @param {() => Promise<T>} operation the work to run
   * @returns {Promise<T>} the operation's result
   */
  #serialize (operation) {
    const run = this.#queue.then(operation, operation)
    // Keep the chain alive regardless of individual failures.
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Drop a dead connection so the next call re-attaches.
   *
   * A navigation race is deliberately NOT fatal: the socket is healthy and the page
   * comes back on its own, so tearing the connection down would turn a retryable
   * blip into an outage.
   *
   * @param {unknown} error the failure that ended the connection
   */
  #invalidate (error) {
    if (isContextDestroyed(error)) {
      this.#log(`ignoring a navigation race: ${error.message}`)
      return
    }
    if (error instanceof CdpError || error instanceof CdpUnreachableError) {
      this.#log(`dropping connection: ${error.message}`)
      try {
        this.#connection?.close()
      } catch {
        // already gone
      }
      this.#connection = null
      this.#lastError = error
    }
  }

  /**
   * Ensure a live connection to an editor whose VM is ready.
   * @returns {Promise<import('../bridge/cdp.mjs').CdpConnection>} the connection
   */
  async #ensureConnection () {
    if (this.#connection !== null && this.#connection.closed === false) return this.#connection

    const appPath = resolveAppPath(this.#config.appPath)
    try {
      const attached = await attach({ port: this.#port, timeoutMs: 8000 })
      attached.connection.on('Runtime.exceptionThrown', () => {})
      this.#connection = attached.connection
      this.#log(`attached to port ${this.#port}`)
    } catch (error) {
      if (this.#config.autoLaunch !== true || appPath === null) {
        const running = await isTurboWarpRunning().catch(() => false)
        // Name the actual obstacle. "Set appPath" is wrong advice when a path is
        // already known and the only thing missing is permission to start it —
        // it sends the reader looking in the wrong place.
        let advice
        if (running) {
          advice = `TurboWarp is running but not listening on the debug port ${this.#port}. ` +
            'It takes a single-instance lock, so the existing window cannot be attached to — ' +
            'close it and call scratch_launch, or start TurboWarp with ' +
            `--remote-debugging-port=${this.#port} yourself.`
        } else if (appPath !== null && this.#config.autoLaunch !== true) {
          advice = `TurboWarp is not running. Call scratch_launch (its executable is known: ${appPath}), ` +
            `or start TurboWarp yourself with --remote-debugging-port=${this.#port}.`
        } else {
          advice = `no TurboWarp on the debug port ${this.#port} and no executable to start: ` +
            'call scratch_launch with appPath (it is remembered afterwards), or set appPath ' +
            '(or the TURBOWARP_SCRATCH_APP_PATH environment variable), or start TurboWarp yourself with ' +
            `--remote-debugging-port=${this.#port}.`
        }
        throw new BridgeUnavailableError(advice, { cause: error })
      }
      this.#log(`nothing on port ${this.#port}; launching ${appPath}`)
      const launched = await launchAndAttach({
        appPath,
        port: this.#port,
        timeoutMs: this.#config.launchTimeoutMs ?? 45000
      })
      this.#connection = launched.connection
    }

    const ready = await waitForVm(this.#connection, { timeoutMs: this.#config.launchTimeoutMs ?? 45000 })
    if (!ready) {
      this.#connection.close()
      this.#connection = null
      throw new BridgeUnavailableError('TurboWarp is up but its editor never finished loading a project')
    }
    return this.#connection
  }

  /**
   * Run one operation against a live editor, serialised and with connection
   * recovery. Mutating operations must hold the lease.
   *
   * @template T
   * @param {{sessionId: string, mutating: boolean, force?: boolean}} access who is asking and why
   * @param {(connection: import('../bridge/cdp.mjs').CdpConnection) => Promise<T>} operation the work
   * @returns {Promise<T>} the operation's result
   */
  async use (access, operation) {
    return this.#serialize(async () => {
      if (access.mutating) this.#checkLease(access.sessionId, access.force === true)
      const connection = await this.#ensureConnection()
      if (access.mutating) this.#lease = { sessionId: access.sessionId, at: Date.now() }
      try {
        return await operation(connection)
      } catch (error) {
        this.#invalidate(error)
        throw error
      }
    })
  }

  /**
   * Enforce the lease for a mutating operation.
   * @param {string} sessionId the requesting session
   * @param {boolean} force whether the caller asked to take over
   */
  #checkLease (sessionId, force) {
    const idleMs = this.#config.leaseIdleMs ?? 300000
    if (this.#lease !== null && this.#lease.sessionId !== sessionId) {
      const idle = Date.now() - this.#lease.at
      if (idle < idleMs && !force) {
        throw new LeaseConflictError(
          `session ${this.#lease.sessionId} is driving TurboWarp (idle ${Math.round(idle / 1000)}s of ` +
          `${Math.round(idleMs / 1000)}s). Wait for it, or pass force: true to take over.`
        )
      }
      if (force) this.#log(`session ${sessionId} took the lease from ${this.#lease.sessionId}`)
    }
  }

  /** Release the lease if the given session holds it. */
  releaseLease (sessionId) {
    if (this.#lease !== null && this.#lease.sessionId === sessionId) this.#lease = null
  }

  /**
   * Report the bridge's state, attaching if the port is open.
   *
   * Attaching here is deliberate: a status that says "not attached" while the port
   * is plainly open would be worse than useless, and opening a WebSocket to a
   * debug endpoint has no effect on the project.
   *
   * @returns {Promise<any>} status for tool output
   */
  async status () {
    const appPath = resolveAppPath(this.#config.appPath)
    const running = await isTurboWarpRunning().catch(() => false)

    let portOpen = false
    try {
      portOpen = (await probeTargets(this.#port, { timeoutMs: 1500 })).length > 0
    } catch {
      portOpen = false
    }

    let connected = this.#connection !== null && this.#connection.closed === false
    if (!portOpen && connected) {
      this.#connection?.close()
      this.#connection = null
      connected = false
    }
    if (portOpen && !connected) {
      try {
        const attached = await attach({ port: this.#port, timeoutMs: 8000 })
        this.#connection = attached.connection
        connected = true
      } catch (error) {
        this.#lastError = error
        connected = false
      }
    }

    return {
      port: this.#port,
      portOpen,
      connected,
      appPath: appPath ?? null,
      appConfigured: this.#config.appPath ?? null,
      autoLaunch: this.#config.autoLaunch === true,
      processRunning: running,
      lease: this.#lease === null ? null : { sessionId: this.#lease.sessionId, idleMs: Date.now() - this.#lease.at },
      lastError: this.#lastError === null ? null : this.#lastError.message
    }
  }

  /** Close the connection. The app is left running. */
  dispose () {
    try {
      this.#connection?.close()
    } catch {
      // already closed
    }
    this.#connection = null
    this.#lease = null
  }
}

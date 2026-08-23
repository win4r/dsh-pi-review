/** DeepSeek Harness host adapter for the isolated Pi review Worker. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Config, ResolvedConfig } from './config.ts'
import { resolveConfig } from './config.ts'
import { requireReviewAuthority } from './authority.ts'
import {
  captureGitSnapshot,
  normalizeSnapshotRequest,
  type ProcessTracker,
} from './git.ts'
import { parseWorkerEnvelope, ProtocolError } from './protocol.ts'
import {
  REVIEW_PROTOCOL_VERSION,
  REVIEW_SCOPES,
  type GitSnapshot,
  type ReviewFinding,
  type ReviewResult,
  type WorkerRequest,
} from './types.ts'

const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, const: 'completed' },
    verdict: { type: 'string', required: true, enum: ['clean', 'findings'] },
    assessment: { type: 'string', required: true },
    findings: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', required: true, enum: ['critical', 'high', 'medium', 'low'] },
          confidence: { type: 'string', required: true, enum: ['high', 'medium', 'low'] },
          path: { type: 'string', required: true },
          side: { type: 'string', required: true, enum: ['old', 'new'] },
          line: { type: 'integer' },
          title: { type: 'string', required: true },
          evidence: { type: 'string', required: true },
          impact: { type: 'string', required: true },
          suggestion: { type: 'string' },
        },
      },
    },
    snapshot: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        scope: { type: 'string', required: true, enum: REVIEW_SCOPES },
        head: { type: 'string', required: true },
        base: { type: 'string' },
        diffHash: { type: 'string', required: true },
        changedPaths: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              oldPath: { type: 'string' },
              path: { type: 'string', required: true },
              untracked: { type: 'boolean' },
              binary: { type: 'boolean' },
            },
          },
        },
        omitted: { type: 'array', required: true, items: { type: 'string' } },
        stale: { type: 'boolean', required: true },
      },
    },
    sandbox: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        mode: { type: 'string', required: true, const: 'read-only' },
        enforcement: { type: 'string', required: true, enum: ['full', 'partial'] },
      },
    },
    model: { type: 'string', required: true },
    durationMs: { type: 'integer', required: true },
  },
} as const

/** Resolve the package-local compiled Worker without PATH discovery. */
export function workerEntrypoint(moduleUrl = import.meta.url): string {
  return fileURLToPath(new URL('./worker.mjs', moduleUrl))
}

function completeOutput(
  handle: SubprocessHandle,
  stream: 'stdout' | 'stderr',
): { readonly text: string; readonly lossy: boolean } {
  const reader = handle.collected[stream]
  if (reader === undefined) {
    throw new HarnessError(`Pi Worker ${stream} was not collected`, 'PI_REVIEW_WORKER_PROTOCOL')
  }
  return reader.readFrom(0)
}

function renderFinding(finding: ReviewFinding, index: number): string {
  const location = `${finding.path}${finding.line === undefined ? '' : `:${String(finding.line)}`} (${finding.side})`
  return [
    `${String(index + 1)}. [${finding.severity.toUpperCase()}/${finding.confidence}] ${location} — ${finding.title}`,
    `   Evidence: ${finding.evidence}`,
    `   Impact: ${finding.impact}`,
    ...(finding.suggestion === undefined ? [] : [`   Suggestion: ${finding.suggestion}`]),
  ].join('\n')
}

/** Complete, bounded Native rendering; protocol and stdout caps own the bound. */
export function renderReviewResult(value: ReviewResult): string {
  const header = `Pi review ${value.verdict === 'clean' ? 'found no actionable defects' : `returned ${String(value.findings.length)} finding(s)`}.`
  const snapshot = `Snapshot ${value.snapshot.diffHash}${value.snapshot.stale ? ' (STALE: repository changed during review)' : ''}; sandbox ${value.sandbox.enforcement}.`
  if (value.findings.length === 0) return `${header}\n${snapshot}\n\n${value.assessment}`
  return `${header}\n${snapshot}\n\n${value.assessment}\n\n${value.findings.map(renderFinding).join('\n\n')}`
}

function forwardedEnvironment(config: ResolvedConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.keys(process.env).map(name => [name, undefined]),
  )
  for (const name of config.forwardEnvironment) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  // Pi's packaged search helper must fail closed instead of attempting an
  // executable download from inside this code-review process.
  env.NO_COLOR = '1'
  env.PI_OFFLINE = '1'
  return env
}

function findingsStayInSnapshot(snapshot: GitSnapshot, findings: readonly ReviewFinding[]): boolean {
  return findings.every((finding) => {
    if (finding.side === 'new') {
      return snapshot.changedPaths.some(changed =>
        changed.path === finding.path && !changed.status.toUpperCase().startsWith('D'))
    }
    return snapshot.changedPaths.some((changed) => {
      if (changed.oldPath !== undefined) return changed.oldPath === finding.path
      const status = changed.status.toUpperCase()
      return changed.path === finding.path
        && changed.untracked !== true
        && status !== '??'
        && !status.startsWith('A')
    })
  })
}

export function sameSnapshot(left: GitSnapshot, right: GitSnapshot): boolean {
  return left.repoRoot === right.repoRoot
    && left.head === right.head
    && left.base === right.base
    && left.diffHash === right.diffHash
    && JSON.stringify(left.changedPaths) === JSON.stringify(right.changedPaths)
    && JSON.stringify(left.omitted) === JSON.stringify(right.omitted)
}

/** Process owner and review executor shared by every root-scoped registration. */
export class ReviewHost implements ProcessTracker {
  readonly #active = new Set<SubprocessHandle>()
  readonly #reviews = new Set<Promise<ReviewResult>>()
  readonly #lifecycle = new AbortController()
  readonly #workerPath: string
  #disposed = false
  #disposal: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    readonly config: ResolvedConfig,
    workerPath = workerEntrypoint(),
  ) {
    this.#workerPath = workerPath
  }

  add(handle: SubprocessHandle): void {
    this.#active.add(handle)
    // A spawn racing teardown still owns its normal caller-side drain. Do not
    // throw between publication and that drain; trigger tree termination and
    // let the fused lifecycle signal classify the settled operation.
    if (this.#disposed) handle.terminate()
  }

  delete(handle: SubprocessHandle): void {
    this.#active.delete(handle)
  }

  /** Stop admission, terminate every process tree, and await quiescence. */
  async dispose(): Promise<void> {
    return await (this.#disposal ??= (async () => {
      this.#disposed = true
      this.#lifecycle.abort(new Error('Pi review plugin disposed'))
      while (this.#active.size > 0 || this.#reviews.size > 0) {
        const handles = [...this.#active]
        const reviews = [...this.#reviews]
        for (const handle of handles) handle.terminate()
        await Promise.allSettled([
          ...handles.map(handle => handle.waitForExit()),
          ...reviews,
        ])
        for (const handle of handles) this.#active.delete(handle)
        for (const review of reviews) this.#reviews.delete(review)
      }
    })())
  }

  /** Execute one complete snapshot → sandboxed Worker → stale-check transaction. */
  async review(rawArgs: Record<string, unknown>, exec: ToolRunContext): Promise<ReviewResult> {
    if (this.#disposed) throw new HarnessError('Pi review plugin is unloading', 'PI_REVIEW_PLUGIN_DISPOSED')
    const running = this.#reviewTransaction(rawArgs, exec)
    this.#reviews.add(running)
    try {
      return await running
    } finally {
      this.#reviews.delete(running)
    }
  }

  async #reviewTransaction(rawArgs: Record<string, unknown>, exec: ToolRunContext): Promise<ReviewResult> {
    const authority = requireReviewAuthority(this.ctx, exec, this.config.authority)
    const request = normalizeSnapshotRequest(rawArgs)
    const deadline = AbortSignal.timeout(this.config.timeoutMs)
    const signal = AbortSignal.any([exec.signal, deadline, this.#lifecycle.signal])
    try {
      const snapshot = await captureGitSnapshot(
        this.ctx, authority.cwd, request, this.config, signal, this,
      )
      const workerRequest: WorkerRequest = {
        protocolVersion: REVIEW_PROTOCOL_VERSION,
        snapshot,
        ...(this.config.model === undefined ? {} : { model: this.config.model }),
        thinkingLevel: this.config.thinkingLevel,
        timeoutMs: this.config.timeoutMs,
        ...(this.config.agentDir === undefined ? {} : { agentDir: this.config.agentDir }),
      }
      const confined = this.ctx.sandbox.confine(
        [process.execPath, this.#workerPath],
        {
          mode: 'read-only',
          workspaceRoot: snapshot.repoRoot,
          sessionId: authority.agent.id,
        },
      )
      if (this.config.requireFullSandbox && confined.enforcement !== 'full') {
        throw new HarnessError(
          'Pi review requires full read-only sandbox enforcement, but this host provides only partial enforcement',
          'PI_REVIEW_SANDBOX_INSUFFICIENT',
        )
      }
      const worker = this.ctx.subprocess.spawn({
        argv: confined.argv,
        cwd: snapshot.repoRoot,
        stdio: {
          stdin: { data: JSON.stringify(workerRequest) },
          stdout: { maxBytes: this.config.maxOutputBytes },
          stderr: { maxBytes: this.config.maxDiagnosticBytes },
        },
        graceMs: this.config.disposeGraceMs,
        signal,
        env: forwardedEnvironment(this.config),
      } satisfies SubprocessSpawnSpec)
      this.add(worker)
      let outcome: SubprocessOutcome
      try {
        outcome = await worker.done
      } catch (error: unknown) {
        throw new HarnessError('Unable to start the isolated Pi review Worker', 'PI_REVIEW_WORKER_START_FAILED', { cause: error })
      } finally {
        try {
          await worker.waitForExit()
        } finally {
          this.delete(worker)
        }
      }
      signal.throwIfAborted()
      const stdout = completeOutput(worker, 'stdout')
      const stderr = completeOutput(worker, 'stderr')
      if (stdout.lossy) {
        throw new HarnessError('Pi Worker stdout exceeded its configured byte limit', 'PI_REVIEW_WORKER_OUTPUT_TOO_LARGE')
      }
      if (stderr.lossy) this.ctx.logger.warn('dsh-pi-review: Pi Worker diagnostic output was truncated')

      let decoded: unknown
      try {
        decoded = JSON.parse(stdout.text) as unknown
      } catch (error: unknown) {
        throw new HarnessError('Pi Worker returned invalid JSON', 'PI_REVIEW_WORKER_PROTOCOL', { cause: error })
      }
      let envelope
      try {
        envelope = parseWorkerEnvelope(decoded)
      } catch (error: unknown) {
        if (error instanceof ProtocolError) {
          throw new HarnessError('Pi Worker returned an invalid response envelope', 'PI_REVIEW_WORKER_PROTOCOL', { cause: error })
        }
        throw error
      }
      if (!envelope.ok) {
        throw new HarnessError(
          `Pi Worker failed: ${envelope.error.message}`,
          `PI_REVIEW_WORKER_${envelope.error.code}`,
        )
      }
      // Findings are a successful domain outcome, and the packaged Worker
      // always exits zero after emitting a complete success envelope.
      if (outcome.signal !== null || outcome.exitCode !== 0) {
        throw new HarnessError('Pi Worker did not exit cleanly after its success envelope', 'PI_REVIEW_WORKER_TERMINATED')
      }
      if (!findingsStayInSnapshot(snapshot, envelope.result.findings)) {
        throw new HarnessError('Pi Worker reported a finding outside the captured changes', 'PI_REVIEW_WORKER_PROTOCOL')
      }

      let stale = false
      try {
        const current = await captureGitSnapshot(
          this.ctx, authority.cwd, request, this.config, signal, this,
        )
        stale = !sameSnapshot(snapshot, current)
      } catch (error: unknown) {
        signal.throwIfAborted()
        this.ctx.logger.warn('dsh-pi-review: unable to reproduce the post-review snapshot; marking the result stale', error)
        stale = true
      }
      return {
        status: 'completed',
        verdict: envelope.result.findings.length === 0 ? 'clean' : 'findings',
        assessment: envelope.result.assessment,
        findings: envelope.result.findings,
        snapshot: {
          scope: snapshot.scope,
          head: snapshot.head,
          ...(snapshot.base === undefined ? {} : { base: snapshot.base }),
          diffHash: snapshot.diffHash,
          changedPaths: snapshot.changedPaths,
          omitted: snapshot.omitted,
          stale,
        },
        sandbox: { mode: 'read-only', enforcement: confined.enforcement },
        model: envelope.result.model,
        durationMs: envelope.result.durationMs,
      }
    } catch (error: unknown) {
      if (exec.signal.aborted) {
        throw new HarnessError('Pi review was cancelled by its calling turn', 'PI_REVIEW_ABORTED', { cause: error })
      }
      if (deadline.aborted) {
        throw new HarnessError('Pi review exceeded its configured deadline', 'PI_REVIEW_TIMEOUT', { cause: error })
      }
      if (this.#lifecycle.signal.aborted) {
        throw new HarnessError('Pi review stopped because the plugin is unloading', 'PI_REVIEW_PLUGIN_DISPOSED', { cause: error })
      }
      throw error
    }
  }
}

/** Create one immutable typed definition reused by root-Agent scopes. */
export function createReviewTool(host: ReviewHost): ToolDefinition {
  const typed = defineTool({
    name: 'pi_review_diff',
    description: 'Run an isolated, read-only Pi Agent review of the calling root Agent\'s Git changes. '
      + 'Choose unstaged, staged, the complete working tree, or comparison with one validated base ref. '
      + 'Returns structured findings; critical/high findings are successful review results, not tool failures.',
    parameters: {
      scope: {
        type: 'string',
        required: true,
        enum: REVIEW_SCOPES,
        description: 'unstaged | staged | working-tree | base',
      },
      base_ref: {
        type: 'string',
        description: 'Required only for base scope. Ordinary ref name or object id; revision expressions are rejected.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional non-empty repository-relative path filters.',
      },
    },
    output: {
      schema: REVIEW_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderReviewResult(value as ReviewResult) }],
    },
    timeoutMs: host.config.timeoutMs,
    async execute(args, exec) {
      const value = await host.review(args as Record<string, unknown>, exec)
      // The schema helper infers mutable JSON arrays; detach the public
      // readonly result at this serialization boundary.
      return {
        ...value,
        findings: value.findings.map(finding => ({ ...finding })),
        snapshot: {
          ...value.snapshot,
          changedPaths: value.snapshot.changedPaths.map(path => ({ ...path })),
          omitted: [...value.snapshot.omitted],
        },
      }
    },
  })
  // defineTool intentionally compiles an implicit open root. The model-facing
  // schema is closed here, while normalizeSnapshotRequest enforces the same
  // boundary inside execute for replay, Code Mode, and direct calls.
  return {
    ...typed,
    parameters: { ...typed.parameters, additionalProperties: false },
  }
}

/** Register the tool in every current/future runtime-root scope exactly once. */
export function applyReviewHost(ctx: Context, config: Config = {}): ReviewHost {
  const host = new ReviewHost(ctx, resolveConfig(config))
  const tool = createReviewTool(host)
  const registrations = new Map<Agent, () => void>()
  let closing = false

  const register = (agent: Agent): void => {
    if (closing || registrations.has(agent) || !ctx.agents.roots().includes(agent)) return
    registrations.set(agent, agent.ctx.tools.register(tool))
  }
  const forget = (agent: Agent): void => {
    const dispose = registrations.get(agent)
    if (dispose === undefined) return
    registrations.delete(agent)
    dispose()
  }

  ctx.on('agent/created', ({ agent }) => { register(agent) })
  ctx.on('agent/disposed', ({ agent }) => { forget(agent) })
  for (const agent of ctx.agents.roots()) register(agent)

  ctx.effect(() => async () => {
    closing = true
    for (const dispose of registrations.values()) dispose()
    registrations.clear()
    await host.dispose()
  }, 'dsh-pi-review.lifecycle()')
  return host
}

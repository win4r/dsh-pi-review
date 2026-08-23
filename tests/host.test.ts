import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import {
  applyReviewHost,
  createReviewTool,
  ReviewHost,
  sameSnapshot,
  workerEntrypoint,
} from '../src/host.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FullSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return {
      argv: [...argv],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }
}

class PartialSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return {
      argv: [...argv],
      enforcement: 'partial',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }
}

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  setStatus(value: AgentStatus): void
}

function stubAgent(id: string, cwd: string, agentContext: Context = new Context()): StubAgent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: Date.now(),
    cwd,
  })
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: sessionId,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    get status() { return status },
    ctx: agentContext,
    cancel() {},
    send() {},
    followup() {},
    steer() {},
    inject() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, session, setStatus(value) { status = value } }
}

function openHumanTurn(stub: StubAgent): void {
  stub.session.append('turn/start', { turn: 1 })
  stub.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'review' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function execution(agent: Agent): ToolRunContext {
  const callId = CallId('host-review-call')
  return {
    callId,
    rootCallId: callId,
    name: 'pi_review_diff',
    arguments: { scope: 'working-tree' },
    agent,
    signal: new AbortController().signal,
    token: {} as ToolRunContext['token'],
    deferContext() {},
    concludeTurn() {},
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pi-review-host-'))
  roots.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'review@example.invalid')
  git(root, 'config', 'user.name', 'Review Test')
  await writeFile(join(root, 'reviewed.ts'), 'export const value = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  await writeFile(join(root, 'reviewed.ts'), 'export const value = 2\n')
  return root
}

async function workerScript(root: string, mutate = false, exitCode = 0): Promise<string> {
  const path = join(root, mutate ? 'mutating-worker.mjs' : exitCode === 0 ? 'worker.mjs' : 'nonzero-worker.mjs')
  const source = `
let input = ''
for await (const chunk of process.stdin) input += chunk
if (process.env.PI_OFFLINE !== '1') throw new Error('PI_OFFLINE must be fixed by the host')
if (process.env.DSH_PI_REVIEW_AMBIENT !== undefined) throw new Error('ambient environment must be tombstoned')
const request = JSON.parse(input)
${mutate ? "await import('node:fs/promises').then(fs => fs.appendFile(new URL('./reviewed.ts', 'file://' + request.snapshot.repoRoot + '/'), '// changed during review\\n'))" : ''}
const findingPath = request.snapshot.changedPaths[0].path
process.stdout.write(JSON.stringify({
  protocolVersion: 1,
  ok: true,
  result: {
    assessment: 'A concrete regression was found.',
    findings: [{
      severity: 'high', confidence: 'high', path: findingPath, side: 'new', line: 1,
      title: 'Incorrect value', evidence: 'The changed line uses the wrong value.',
      impact: 'Callers observe an invalid result.', suggestion: 'Restore the intended value.'
    }],
    model: 'test/reviewer', durationMs: 7
  }
}) + '\\n')
process.exitCode = ${String(exitCode)}
`
  await writeFile(path, source)
  return path
}

async function harness(
  root: string,
  sandbox: typeof FullSandbox | typeof PartialSandbox,
): Promise<{ ctx: Context; rootAgent: StubAgent }> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(sandbox)
  const rootAgent = stubAgent(`host-root-${Math.random()}`, root)
  ctx.agents.register(rootAgent.agent)
  openHumanTurn(rootAgent)
  return { ctx, rootAgent }
}

describe('Harness host review transaction', () => {
  it('accepts structured high-severity findings as success and reports an unchanged snapshot', async () => {
    const root = await repository()
    const worker = await workerScript(root)
    const { ctx, rootAgent } = await harness(root, FullSandbox)
    const host = new ReviewHost(ctx, resolveConfig({
      maxDiffBytes: 65_536,
      maxFiles: 10,
      maxOutputBytes: 65_536,
      timeoutMs: 20_000,
    }), worker)

    process.env.DSH_PI_REVIEW_AMBIENT = 'must-not-leak'
    let result
    try {
      result = await ctx.agents.withInitiator(rootAgent.agent, () =>
        host.review({ scope: 'working-tree' }, execution(rootAgent.agent)))
    } finally {
      delete process.env.DSH_PI_REVIEW_AMBIENT
    }
    expect(result).toMatchObject({
      status: 'completed',
      verdict: 'findings',
      findings: [{ severity: 'high', path: 'reviewed.ts' }],
      snapshot: { stale: false },
      sandbox: { mode: 'read-only', enforcement: 'full' },
      model: 'test/reviewer',
    })
  })

  it('recomputes the Git snapshot and marks concurrent repository mutation stale', async () => {
    const root = await repository()
    const worker = await workerScript(root, true)
    const { ctx, rootAgent } = await harness(root, FullSandbox)
    const host = new ReviewHost(ctx, resolveConfig({
      maxDiffBytes: 65_536,
      maxFiles: 10,
      maxOutputBytes: 65_536,
      timeoutMs: 20_000,
    }), worker)
    const result = await ctx.agents.withInitiator(rootAgent.agent, () =>
      host.review({ scope: 'working-tree' }, execution(rootAgent.agent)))
    expect(result.snapshot.stale).toBe(true)
  })

  it('fails closed before Worker launch when full confinement is required but unavailable', async () => {
    const root = await repository()
    const { ctx, rootAgent } = await harness(root, PartialSandbox)
    const host = new ReviewHost(ctx, resolveConfig({
      maxDiffBytes: 65_536,
      maxFiles: 10,
      timeoutMs: 20_000,
      requireFullSandbox: true,
    }), join(root, 'must-not-run.mjs'))
    await expect(ctx.agents.withInitiator(rootAgent.agent, () =>
      host.review({ scope: 'working-tree' }, execution(rootAgent.agent))))
      .rejects.toMatchObject({ code: 'PI_REVIEW_SANDBOX_INSUFFICIENT' })
  })

  it('rejects a success envelope followed by a non-zero Worker exit', async () => {
    const root = await repository()
    const worker = await workerScript(root, false, 1)
    const { ctx, rootAgent } = await harness(root, FullSandbox)
    const host = new ReviewHost(ctx, resolveConfig({
      maxDiffBytes: 65_536,
      maxFiles: 10,
      maxOutputBytes: 65_536,
      timeoutMs: 20_000,
    }), worker)
    await expect(ctx.agents.withInitiator(rootAgent.agent, () =>
      host.review({ scope: 'working-tree' }, execution(rootAgent.agent))))
      .rejects.toMatchObject({ code: 'PI_REVIEW_WORKER_TERMINATED' })
  })
})

describe('root-scoped registration and presentation', () => {
  it('publishes a closed schema and resolves the package-local dist Worker', () => {
    const ctx = new Context()
    const host = new ReviewHost(ctx, resolveConfig())
    const tool = createReviewTool(host)
    expect(tool.parameters).toMatchObject({
      type: 'object', additionalProperties: false,
      properties: { scope: { enum: ['unstaged', 'staged', 'working-tree', 'base'] } },
    })
    expect(workerEntrypoint('file:///tmp/package/dist/index.mjs')).toBe('/tmp/package/dist/worker.mjs')
  })

  it('registers current and future roots once, skips children, and disposes registrations', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const currentDispose = vi.fn()
    const futureDispose = vi.fn()
    const childDispose = vi.fn()
    const currentRegister = vi.fn(() => currentDispose)
    const futureRegister = vi.fn(() => futureDispose)
    const childRegister = vi.fn(() => childDispose)
    const current = stubAgent('registered-current', '/work', {
      tools: { register: currentRegister },
    } as unknown as Context)
    ctx.agents.register(current.agent)

    const fiber = await ctx.plugin({
      name: 'test-review-host',
      inject: ['agents'],
      apply(pluginCtx: Context) { applyReviewHost(pluginCtx, {}) },
    })
    expect(currentRegister).toHaveBeenCalledTimes(1)

    const future = stubAgent('registered-future', '/work', {
      tools: { register: futureRegister },
    } as unknown as Context)
    ctx.agents.register(future.agent)
    expect(futureRegister).toHaveBeenCalledTimes(1)

    const child = stubAgent('registered-child', '/work', {
      tools: { register: childRegister },
    } as unknown as Context)
    ctx.agents.enter(child.agent, current.agent)
    ctx.agents.announce(child.agent)
    expect(childRegister).not.toHaveBeenCalled()

    await fiber.dispose()
    expect(currentDispose).toHaveBeenCalledTimes(1)
    expect(futureDispose).toHaveBeenCalledTimes(1)
    expect(childDispose).not.toHaveBeenCalled()
  })

  it('awaits process handles admitted while plugin teardown is draining', async () => {
    const ctx = new Context()
    const host = new ReviewHost(ctx, resolveConfig())
    const firstExit = Promise.withResolvers<void>()
    const secondExit = Promise.withResolvers<void>()
    const first = {
      terminate: vi.fn(),
      waitForExit: vi.fn(() => firstExit.promise),
    } as unknown as SubprocessHandle
    const second = {
      terminate: vi.fn(),
      waitForExit: vi.fn(() => secondExit.promise),
    } as unknown as SubprocessHandle

    host.add(first)
    const disposing = host.dispose()
    await new Promise<void>(resolve => setImmediate(resolve))
    host.add(second)
    expect(second.terminate).toHaveBeenCalledTimes(1)
    firstExit.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(second.waitForExit).toHaveBeenCalledTimes(1)
    secondExit.resolve()
    await disposing
  })

  it('treats changed-path metadata as part of snapshot staleness identity', () => {
    const common = {
      scope: 'working-tree' as const,
      repoRoot: '/repo',
      head: 'a'.repeat(40),
      diff: '',
      diffHash: 'b'.repeat(64),
      omitted: [],
    }
    expect(sameSnapshot(
      { ...common, changedPaths: [{ status: 'M', path: 'src/a.ts' }] },
      { ...common, changedPaths: [] },
    )).toBe(false)
  })
})

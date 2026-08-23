import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { requireReviewAuthority } from '../src/authority.ts'

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  setStatus(value: AgentStatus): void
}

function stubAgent(id: string, cwd = '/work'): StubAgent {
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
    ctx: new Context(),
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

function openTurn(stub: StubAgent, source: MessageSource): void {
  stub.session.append('turn/start', { turn: 1 })
  stub.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'review the changes' }],
    source,
  }), { surfaceOp: 'append' })
}

function execution(agent?: Agent): ToolRunContext {
  const callId = CallId('review-call')
  return {
    callId,
    rootCallId: callId,
    name: 'pi_review_diff',
    arguments: { scope: 'working-tree' },
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
    token: {} as ToolRunContext['token'],
    deferContext() {},
    concludeTurn() {},
  }
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  return ctx
}

describe('review authority', () => {
  it('authenticates the exact live root and derives only its session cwd', async () => {
    const ctx = await harness()
    const root = stubAgent('authority-root', '/owned/worktree')
    ctx.agents.register(root.agent)
    openTurn(root, { kind: 'user' })

    const authorized = ctx.agents.withInitiator(root.agent, () =>
      requireReviewAuthority(ctx, execution(root.agent), 'direct-human'))
    expect(authorized.agent).toBe(root.agent)
    expect(authorized.cwd).toBe('/owned/worktree')
  })

  it('distinguishes direct-human from deployment-enabled root-turn authority', async () => {
    const ctx = await harness()
    const root = stubAgent('authority-automation')
    ctx.agents.register(root.agent)
    openTurn(root, { kind: 'plugin', plugin: 'scheduler' })

    expect(() => ctx.agents.withInitiator(root.agent, () =>
      requireReviewAuthority(ctx, execution(root.agent), 'direct-human')))
      .toThrow(/direct human input/)
    expect(ctx.agents.withInitiator(root.agent, () =>
      requireReviewAuthority(ctx, execution(root.agent), 'root-turn')).agent).toBe(root.agent)
  })

  it('rejects child, stale, idle, driverless, and closed-turn calls', async () => {
    const ctx = await harness()
    const root = stubAgent('authority-parent')
    const child = stubAgent('authority-child')
    ctx.agents.register(root.agent)
    ctx.agents.enter(child.agent, root.agent)
    ctx.agents.announce(child.agent)
    openTurn(child, { kind: 'user' })
    expect(() => ctx.agents.withInitiator(child.agent, () =>
      requireReviewAuthority(ctx, execution(child.agent), 'root-turn')))
      .toThrow(/runtime root Agent/)

    openTurn(root, { kind: 'user' })
    const stale = stubAgent('authority-stale')
    Object.defineProperty(stale.agent, 'id', { value: root.agent.id })
    expect(() => ctx.agents.withInitiator(stale.agent, () =>
      requireReviewAuthority(ctx, execution(stale.agent), 'root-turn')))
      .toThrow(/exact live calling Agent/)

    root.setStatus('idle')
    expect(() => ctx.agents.withInitiator(root.agent, () =>
      requireReviewAuthority(ctx, execution(root.agent), 'root-turn')))
      .toThrow(/active driver/)
    root.setStatus('running')
    expect(() => requireReviewAuthority(ctx, execution(root.agent), 'root-turn'))
      .toThrow(/active driver/)

    root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => ctx.agents.withInitiator(root.agent, () =>
      requireReviewAuthority(ctx, execution(root.agent), 'root-turn')))
      .toThrow(/open model turn/)
  })
})

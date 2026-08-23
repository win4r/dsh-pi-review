/** Execution-time authority checks for the model-facing Pi review tool. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'

type TurnStartEvent = Extract<SessionEvent, { type: 'turn/start' }>

/** Authenticated root-agent call and the workspace it owns. */
export interface ReviewExecution {
  readonly agent: Agent
  readonly cwd: string
  readonly start: TurnStartEvent
  readonly events: readonly SessionEvent[]
}

/** Throw one structured, model-safe policy failure. */
function reject(message: string, code = 'PI_REVIEW_AUTHORITY_REQUIRED'): never {
  throw new HarnessError(message, code)
}

/** Locate the open turn enclosing the model tool call. */
function openTurn(agent: Agent): { start: TurnStartEvent; events: readonly SessionEvent[] } {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end') {
      reject('pi_review_diff requires an open model turn', 'PI_REVIEW_DRIVER_REQUIRED')
    }
    if (boundary?.type === 'turn/start') {
      return { start: boundary, events: events.slice(index + 1) }
    }
  }
  return reject('pi_review_diff requires an open model turn', 'PI_REVIEW_DRIVER_REQUIRED')
}

/** Whether host-attested human input was admitted in this exact open turn. */
function hasDirectHumanInput(execution: ReviewExecution): boolean {
  return execution.events.some(event =>
    event.type === 'user/message' && event.data.source.kind === 'user')
}

/**
 * Authenticate the exact live root Agent, its active driver, its open turn,
 * and its immutable per-session workspace. Runtime ownership, rather than
 * durable `parentSession` lineage, decides whether an Agent is a root.
 */
export function requireReviewAuthority(
  ctx: Context,
  exec: ToolRunContext,
  authority: ResolvedConfig['authority'],
): ReviewExecution {
  const agent = exec.agent
  if (agent === undefined) {
    return reject('pi_review_diff requires a calling Agent', 'PI_REVIEW_AGENT_REQUIRED')
  }
  if (ctx.agents.get(agent.id) !== agent
    || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    return reject(
      'pi_review_diff requires the exact live calling Agent inside its active driver',
      'PI_REVIEW_DRIVER_REQUIRED',
    )
  }
  if (!ctx.agents.roots().includes(agent)) {
    return reject('pi_review_diff is available only to a runtime root Agent')
  }
  const cwd = agent.session.header.cwd
  if (cwd === undefined) {
    return reject(
      'pi_review_diff requires the calling root Agent to own a session workspace',
      'PI_REVIEW_WORKSPACE_REQUIRED',
    )
  }
  const execution: ReviewExecution = { agent, cwd, ...openTurn(agent) }
  if (authority === 'direct-human' && !hasDirectHumanInput(execution)) {
    return reject('pi_review_diff requires direct human input in the current root-Agent turn')
  }
  return execution
}

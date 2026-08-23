/** Shared process protocol and public review result types. */

export const REVIEW_PROTOCOL_VERSION = 2 as const

export const REVIEW_SCOPES = [
  'unstaged',
  'staged',
  'working-tree',
  'base',
  'branch',
  'commit',
] as const
export type ReviewScope = typeof REVIEW_SCOPES[number]

export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type ReviewSeverity = typeof REVIEW_SEVERITIES[number]

export const REVIEW_CONFIDENCES = ['high', 'medium', 'low'] as const
export type ReviewConfidence = typeof REVIEW_CONFIDENCES[number]

export const REVIEW_CATEGORIES = [
  'correctness',
  'security',
  'performance',
  'maintainability',
  'testing',
  'style',
  'docs',
] as const
export type ReviewCategory = typeof REVIEW_CATEGORIES[number]

/** One changed path in the captured Git snapshot. */
export interface ChangedPath {
  readonly status: string
  readonly oldPath?: string
  readonly path: string
  readonly untracked?: boolean
  readonly binary?: boolean
}

/** Immutable Git input presented to Pi. */
export interface GitSnapshot {
  readonly scope: ReviewScope
  readonly repoRoot: string
  readonly head: string
  readonly base?: string
  readonly diff: string
  readonly diffHash: string
  readonly changedPaths: readonly ChangedPath[]
  readonly omitted: readonly string[]
}

/** One actionable structured review finding. */
export interface ReviewFinding {
  readonly severity: ReviewSeverity
  readonly category: ReviewCategory
  readonly confidence: ReviewConfidence
  readonly path: string
  readonly side: 'old' | 'new'
  readonly line?: number
  readonly title: string
  readonly evidence: string
  readonly impact: string
  readonly suggestion?: string
}

/** Pi Worker request written as one JSON document on stdin. */
export interface WorkerRequest {
  readonly protocolVersion: typeof REVIEW_PROTOCOL_VERSION
  readonly snapshot: GitSnapshot
  readonly model?: string
  readonly focus?: string
  readonly severityFloor: ReviewSeverity
  readonly thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  readonly timeoutMs: number
  readonly agentDir?: string
}

/** Pi-calculated usage for the isolated one-review in-memory session. */
export interface ReviewUsage {
  readonly reported: boolean
  readonly turns: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  /** Catalog-rate estimate reported by Pi, not a provider invoice. */
  readonly estimatedCostUsd: number
}

/** Pi-owned result before the Harness host adds sandbox and staleness facts. */
export interface WorkerReviewResult {
  readonly assessment: string
  readonly findings: readonly ReviewFinding[]
  readonly provider: string
  readonly model: string
  readonly usage: ReviewUsage
  readonly durationMs: number
}
/** Successful Worker response. */
export interface WorkerSuccessEnvelope {
  readonly protocolVersion: typeof REVIEW_PROTOCOL_VERSION
  readonly ok: true
  readonly result: WorkerReviewResult
}

/** Failed Worker response with bounded, non-secret diagnostics. */
export interface WorkerErrorEnvelope {
  readonly protocolVersion: typeof REVIEW_PROTOCOL_VERSION
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export type WorkerEnvelope = WorkerSuccessEnvelope | WorkerErrorEnvelope

/** Canonical value returned by the model-facing Harness tool. */
export interface ReviewResult {
  readonly status: 'completed'
  readonly verdict: 'clean' | 'findings' | 'below-threshold-only'
  readonly assessment: string
  readonly findings: readonly ReviewFinding[]
  readonly snapshot: {
    readonly scope: ReviewScope
    readonly head: string
    readonly base?: string
    readonly diffHash: string
    readonly changedPaths: readonly ChangedPath[]
    readonly omitted: readonly string[]
    readonly stale: boolean
  }
  readonly sandbox: {
    readonly mode: 'read-only'
    readonly enforcement: 'full' | 'partial'
  }
  readonly policy: {
    readonly severityFloor: ReviewSeverity
    readonly focus?: string
    readonly suppressedBelowFloor: number
  }
  readonly provider: string
  readonly model: string
  readonly usage: ReviewUsage
  readonly durationMs: number
}

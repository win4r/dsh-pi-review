/** Shared process protocol and public review result types. */

export const REVIEW_PROTOCOL_VERSION = 1 as const

export const REVIEW_SCOPES = ['unstaged', 'staged', 'working-tree', 'base'] as const
export type ReviewScope = typeof REVIEW_SCOPES[number]

export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type ReviewSeverity = typeof REVIEW_SEVERITIES[number]

export const REVIEW_CONFIDENCES = ['high', 'medium', 'low'] as const
export type ReviewConfidence = typeof REVIEW_CONFIDENCES[number]

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
  readonly thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  readonly timeoutMs: number
  readonly agentDir?: string
}

/** Pi-owned result before the Harness host adds sandbox and staleness facts. */
export interface WorkerReviewResult {
  readonly assessment: string
  readonly findings: readonly ReviewFinding[]
  readonly model: string
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
  readonly verdict: 'clean' | 'findings'
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
  readonly model: string
  readonly durationMs: number
}

/** Strict JSON validation for the untrusted Pi Worker process boundary. */

import { isAbsolute } from 'node:path'
import {
  REVIEW_CONFIDENCES,
  REVIEW_PROTOCOL_VERSION,
  REVIEW_SCOPES,
  REVIEW_SEVERITIES,
  type ChangedPath,
  type GitSnapshot,
  type ReviewFinding,
  type WorkerEnvelope,
  type WorkerRequest,
  type WorkerReviewResult,
} from './types.ts'

const MAX_CHANGED_PATHS = 2_000
const MAX_FINDINGS = 100
const MAX_DIFF_BYTES = 16_777_216

/** Process protocol validation failure safe to expose without input contents. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key))
  if (extra.length > 0) throw new ProtocolError(`${label} contains unsupported fields`)
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim().length === 0)) {
    throw new ProtocolError(`${label} must be a${allowEmpty ? '' : ' non-empty'} string no longer than ${String(maximum)} characters`)
  }
  if (value.includes('\0')) throw new ProtocolError(`${label} must not contain NUL`)
  return value
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : text(value, label, maximum)
}

function enumValue<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) {
    throw new ProtocolError(`${label} is invalid`)
  }
  return value as T[number]
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new ProtocolError(`${label} must be a positive safe integer no greater than ${String(maximum)}`)
  }
  return value as number
}

function nonNegativeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new ProtocolError(`${label} must be a non-negative safe integer no greater than ${String(maximum)}`)
  }
  return value as number
}

function pathText(value: unknown, label: string): string {
  const resolved = text(value, label, 4_096)
  if (resolved.startsWith('/') || resolved.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(resolved)) {
    throw new ProtocolError(`${label} must be relative`)
  }
  if (resolved.split(/[\\/]/).some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new ProtocolError(`${label} must be a normalized relative path`)
  }
  return resolved
}

function parseChangedPath(value: unknown, label: string): ChangedPath {
  const item = record(value, label)
  exactKeys(item, ['status', 'oldPath', 'path', 'untracked', 'binary'], label)
  const oldPath = optionalText(item.oldPath, `${label}.oldPath`, 4_096)
  if (oldPath !== undefined) pathText(oldPath, `${label}.oldPath`)
  if (item.untracked !== undefined && typeof item.untracked !== 'boolean') {
    throw new ProtocolError(`${label}.untracked must be boolean`)
  }
  if (item.binary !== undefined && typeof item.binary !== 'boolean') {
    throw new ProtocolError(`${label}.binary must be boolean`)
  }
  return {
    status: text(item.status, `${label}.status`, 16),
    ...(oldPath === undefined ? {} : { oldPath }),
    path: pathText(item.path, `${label}.path`),
    ...(item.untracked === undefined ? {} : { untracked: item.untracked }),
    ...(item.binary === undefined ? {} : { binary: item.binary }),
  }
}

function parseSnapshot(value: unknown): GitSnapshot {
  const snapshot = record(value, 'snapshot')
  exactKeys(snapshot, ['scope', 'repoRoot', 'head', 'base', 'diff', 'diffHash', 'changedPaths', 'omitted'], 'snapshot')
  const repoRoot = text(snapshot.repoRoot, 'snapshot.repoRoot', 16_384)
  if (!isAbsolute(repoRoot)) throw new ProtocolError('snapshot.repoRoot must be absolute')
  const head = text(snapshot.head, 'snapshot.head', 128)
  const base = optionalText(snapshot.base, 'snapshot.base', 128)
  if (!/^[0-9a-f]{40,64}$/.test(head) || (base !== undefined && !/^[0-9a-f]{40,64}$/.test(base))) {
    throw new ProtocolError('snapshot object ids must be lowercase hexadecimal commit ids')
  }
  const diff = text(snapshot.diff, 'snapshot.diff', MAX_DIFF_BYTES, true)
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) throw new ProtocolError('snapshot.diff exceeds the protocol byte limit')
  const diffHash = text(snapshot.diffHash, 'snapshot.diffHash', 64)
  if (!/^[0-9a-f]{64}$/.test(diffHash)) throw new ProtocolError('snapshot.diffHash must be SHA-256 hexadecimal')
  if (!Array.isArray(snapshot.changedPaths) || snapshot.changedPaths.length > MAX_CHANGED_PATHS) {
    throw new ProtocolError('snapshot.changedPaths is invalid')
  }
  if (!Array.isArray(snapshot.omitted) || snapshot.omitted.length > MAX_CHANGED_PATHS) {
    throw new ProtocolError('snapshot.omitted is invalid')
  }
  return {
    scope: enumValue(snapshot.scope, REVIEW_SCOPES, 'snapshot.scope'),
    repoRoot,
    head,
    ...(base === undefined ? {} : { base }),
    diff,
    diffHash,
    changedPaths: snapshot.changedPaths.map((item, index) => parseChangedPath(item, `snapshot.changedPaths[${String(index)}]`)),
    omitted: snapshot.omitted.map((item, index) => pathText(item, `snapshot.omitted[${String(index)}]`)),
  }
}

/** Parse one Worker request after JSON decoding. */
export function parseWorkerRequest(value: unknown): WorkerRequest {
  const request = record(value, 'request')
  exactKeys(request, ['protocolVersion', 'snapshot', 'model', 'thinkingLevel', 'timeoutMs', 'agentDir'], 'request')
  if (request.protocolVersion !== REVIEW_PROTOCOL_VERSION) throw new ProtocolError('unsupported review protocol version')
  const model = optionalText(request.model, 'request.model', 512)
  const agentDir = optionalText(request.agentDir, 'request.agentDir', 16_384)
  if (agentDir !== undefined && !isAbsolute(agentDir)) throw new ProtocolError('request.agentDir must be absolute')
  return {
    protocolVersion: REVIEW_PROTOCOL_VERSION,
    snapshot: parseSnapshot(request.snapshot),
    ...(model === undefined ? {} : { model }),
    thinkingLevel: enumValue(request.thinkingLevel, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const, 'request.thinkingLevel'),
    timeoutMs: positiveInteger(request.timeoutMs, 'request.timeoutMs', 3_600_000),
    ...(agentDir === undefined ? {} : { agentDir }),
  }
}

function parseFinding(value: unknown, index: number): ReviewFinding {
  const label = `result.findings[${String(index)}]`
  const finding = record(value, label)
  exactKeys(finding, ['severity', 'confidence', 'path', 'side', 'line', 'title', 'evidence', 'impact', 'suggestion'], label)
  const line = finding.line === undefined ? undefined : positiveInteger(finding.line, `${label}.line`)
  const suggestion = optionalText(finding.suggestion, `${label}.suggestion`, 8_000)
  return {
    severity: enumValue(finding.severity, REVIEW_SEVERITIES, `${label}.severity`),
    confidence: enumValue(finding.confidence, REVIEW_CONFIDENCES, `${label}.confidence`),
    path: pathText(finding.path, `${label}.path`),
    side: enumValue(finding.side, ['old', 'new'] as const, `${label}.side`),
    ...(line === undefined ? {} : { line }),
    title: text(finding.title, `${label}.title`, 240),
    evidence: text(finding.evidence, `${label}.evidence`, 12_000),
    impact: text(finding.impact, `${label}.impact`, 8_000),
    ...(suggestion === undefined ? {} : { suggestion }),
  }
}

function parseReviewResult(value: unknown): WorkerReviewResult {
  const result = record(value, 'result')
  exactKeys(result, ['assessment', 'findings', 'model', 'durationMs'], 'result')
  if (!Array.isArray(result.findings) || result.findings.length > MAX_FINDINGS) {
    throw new ProtocolError(`result.findings must contain at most ${String(MAX_FINDINGS)} items`)
  }
  return {
    assessment: text(result.assessment, 'result.assessment', 12_000),
    findings: result.findings.map(parseFinding),
    model: text(result.model, 'result.model', 512),
    durationMs: nonNegativeInteger(result.durationMs, 'result.durationMs', 3_600_000),
  }
}

/** Parse one Worker response after JSON decoding. */
export function parseWorkerEnvelope(value: unknown): WorkerEnvelope {
  const envelope = record(value, 'response')
  exactKeys(envelope, ['protocolVersion', 'ok', 'result', 'error'], 'response')
  if (envelope.protocolVersion !== REVIEW_PROTOCOL_VERSION) throw new ProtocolError('unsupported review protocol version')
  if (envelope.ok === true) {
    if (envelope.error !== undefined) throw new ProtocolError('successful response must not contain error')
    return { protocolVersion: REVIEW_PROTOCOL_VERSION, ok: true, result: parseReviewResult(envelope.result) }
  }
  if (envelope.ok !== false || envelope.result !== undefined) throw new ProtocolError('response.ok must be boolean')
  const error = record(envelope.error, 'response.error')
  exactKeys(error, ['code', 'message'], 'response.error')
  const code = text(error.code, 'response.error.code', 128)
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw new ProtocolError('response.error.code is invalid')
  return {
    protocolVersion: REVIEW_PROTOCOL_VERSION,
    ok: false,
    error: {
      code,
      message: text(error.message, 'response.error.message', 4_096),
    },
  }
}

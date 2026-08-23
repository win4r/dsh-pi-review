import { describe, expect, it } from 'vitest'
import { parseWorkerEnvelope, parseWorkerRequest } from '../src/protocol.ts'
import { REVIEW_PROTOCOL_VERSION } from '../src/types.ts'

const snapshot = {
  scope: 'staged',
  repoRoot: '/tmp/repo',
  head: 'a'.repeat(40),
  diff: 'diff --git a/a.ts b/a.ts\n',
  diffHash: 'b'.repeat(64),
  changedPaths: [{ status: 'M', path: 'a.ts' }],
  omitted: [],
}

describe('worker protocol', () => {
  it('accepts a strict request', () => {
    expect(parseWorkerRequest({
      protocolVersion: REVIEW_PROTOCOL_VERSION,
      snapshot,
      focus: '  concurrency and cleanup  ',
      severityFloor: 'medium',
      thinkingLevel: 'high',
      timeoutMs: 30_000,
    })).toMatchObject({ focus: 'concurrency and cleanup', severityFloor: 'medium' })
  })

  it('rejects extra fields and traversal-shaped absolute paths', () => {
    expect(() => parseWorkerRequest({
      protocolVersion: REVIEW_PROTOCOL_VERSION,
      snapshot: { ...snapshot, surprise: true },
      severityFloor: 'low',
      thinkingLevel: 'high',
      timeoutMs: 30_000,
    })).toThrow(/unsupported fields/)
    expect(() => parseWorkerRequest({
      protocolVersion: REVIEW_PROTOCOL_VERSION,
      snapshot: { ...snapshot, changedPaths: [{ status: 'M', path: '/etc/passwd' }] },
      severityFloor: 'low',
      thinkingLevel: 'high',
      timeoutMs: 30_000,
    })).toThrow(/relative/)
    expect(() => parseWorkerRequest({
      protocolVersion: REVIEW_PROTOCOL_VERSION,
      snapshot: { ...snapshot, changedPaths: [{ status: 'M', path: '../secret' }] },
      severityFloor: 'low',
      thinkingLevel: 'high',
      timeoutMs: 30_000,
    })).toThrow(/normalized relative/)
  })

  it('requires bounded focus and severity policy fields', () => {
    const base = {
      protocolVersion: REVIEW_PROTOCOL_VERSION,
      snapshot,
      severityFloor: 'low',
      thinkingLevel: 'high',
      timeoutMs: 30_000,
    }
    expect(() => parseWorkerRequest({ ...base, focus: 'x'.repeat(2_049) })).toThrow(/request.focus/)
    expect(() => parseWorkerRequest({ ...base, severityFloor: 'info' })).toThrow(/severityFloor/)
    expect(() => parseWorkerRequest({ ...base, model: 'provider\n/model' })).toThrow(/provider\/model-id/)
  })

  it('accepts structured findings and rejects malformed envelopes', () => {
    const envelope = parseWorkerEnvelope({
      protocolVersion: REVIEW_PROTOCOL_VERSION,
      ok: true,
      result: {
        assessment: 'One defect.',
        findings: [{
          severity: 'high',
          category: 'correctness',
          confidence: 'high',
          path: 'a.ts',
          side: 'new',
          line: 2,
          title: 'Incorrect branch',
          evidence: 'The condition is inverted.',
          impact: 'Valid requests fail.',
        }],
        provider: 'test',
        model: 'model',
        usage: {
          reported: true,
          turns: 2,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 7,
          cacheWriteTokens: 3,
          totalTokens: 25,
          estimatedCostUsd: 0.02,
        },
        durationMs: 10,
      },
    })
    expect(envelope.ok).toBe(true)
    expect(() => parseWorkerEnvelope({ protocolVersion: REVIEW_PROTOCOL_VERSION, ok: true, result: {}, extra: true })).toThrow(/unsupported fields/)
  })

  it('strictly validates usage keys, bounds, finiteness, and bucket totals', () => {
    const usage = {
      reported: true,
      turns: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalTokens: 20,
      estimatedCostUsd: 0.01,
    }
    const result = {
      assessment: 'Clean.',
      findings: [],
      provider: 'test',
      model: 'model',
      usage,
      durationMs: 1,
    }
    const envelope = { protocolVersion: REVIEW_PROTOCOL_VERSION, ok: true, result }

    expect(() => parseWorkerEnvelope({
      ...envelope,
      result: { ...result, usage: { ...usage, totalTokens: 19 } },
    })).toThrow(/sum of its token buckets/)
    expect(() => parseWorkerEnvelope({
      ...envelope,
      result: { ...result, usage: { ...usage, estimatedCostUsd: Number.POSITIVE_INFINITY } },
    })).toThrow(/finite non-negative/)
    expect(() => parseWorkerEnvelope({
      ...envelope,
      result: { ...result, usage: { ...usage, inputTokens: -1 } },
    })).toThrow(/non-negative/)
    expect(() => parseWorkerEnvelope({
      ...envelope,
      result: { ...result, usage: { ...usage, surprise: 1 } },
    })).toThrow(/unsupported fields/)
    expect(() => parseWorkerEnvelope({
      ...envelope,
      result: {
        ...result,
        usage: {
          reported: false,
          turns: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
        },
      },
    })).toThrow(/all-zero/)
  })
})

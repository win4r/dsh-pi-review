import { describe, expect, it } from 'vitest'
import { parseWorkerEnvelope, parseWorkerRequest } from '../src/protocol.ts'

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
      protocolVersion: 1,
      snapshot,
      thinkingLevel: 'high',
      timeoutMs: 30_000,
    }).snapshot.changedPaths).toHaveLength(1)
  })

  it('rejects extra fields and traversal-shaped absolute paths', () => {
    expect(() => parseWorkerRequest({
      protocolVersion: 1,
      snapshot: { ...snapshot, surprise: true },
      thinkingLevel: 'high',
      timeoutMs: 30_000,
    })).toThrow(/unsupported fields/)
    expect(() => parseWorkerRequest({
      protocolVersion: 1,
      snapshot: { ...snapshot, changedPaths: [{ status: 'M', path: '/etc/passwd' }] },
      thinkingLevel: 'high',
      timeoutMs: 30_000,
    })).toThrow(/relative/)
    expect(() => parseWorkerRequest({
      protocolVersion: 1,
      snapshot: { ...snapshot, changedPaths: [{ status: 'M', path: '../secret' }] },
      thinkingLevel: 'high',
      timeoutMs: 30_000,
    })).toThrow(/normalized relative/)
  })

  it('accepts structured findings and rejects malformed envelopes', () => {
    const envelope = parseWorkerEnvelope({
      protocolVersion: 1,
      ok: true,
      result: {
        assessment: 'One defect.',
        findings: [{
          severity: 'high',
          confidence: 'high',
          path: 'a.ts',
          side: 'new',
          line: 2,
          title: 'Incorrect branch',
          evidence: 'The condition is inverted.',
          impact: 'Valid requests fail.',
        }],
        model: 'test/model',
        durationMs: 10,
      },
    })
    expect(envelope.ok).toBe(true)
    expect(() => parseWorkerEnvelope({ protocolVersion: 1, ok: true, result: {}, extra: true })).toThrow(/unsupported fields/)
  })
})

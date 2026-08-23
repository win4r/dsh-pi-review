import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('applies safe defaults', () => {
    expect(resolveConfig()).toMatchObject({
      authority: 'direct-human',
      thinkingLevel: 'high',
      timeoutMs: 300_000,
      maxDiffBytes: 524_288,
      maxFiles: 200,
      requireFullSandbox: true,
      modelProfiles: {},
      forwardEnvironment: [],
    })
  })

  it('normalizes optional values and environment names', () => {
    expect(resolveConfig({
      authority: 'root-turn',
      model: ' openai/gpt-test ',
      modelProfiles: {
        fast: ' openai/gpt-fast ',
        deep_review: 'anthropic/claude/test',
      },
      agentDir: './pi-home',
      forwardEnvironment: ['OPENAI_API_KEY', 'OPENAI_API_KEY'],
    })).toMatchObject({
      authority: 'root-turn',
      model: 'openai/gpt-test',
      modelProfiles: {
        fast: 'openai/gpt-fast',
        deep_review: 'anthropic/claude/test',
      },
      forwardEnvironment: ['OPENAI_API_KEY'],
    })
  })

  it('rejects invalid direct apply values', () => {
    expect(() => resolveConfig({ timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => resolveConfig({ model: ' ' })).toThrow(/model/)
    expect(() => resolveConfig({ model: 'missing-provider-separator' })).toThrow(/provider\/model-id/)
    expect(() => resolveConfig({ modelProfiles: { 'Bad Profile': 'openai/gpt-test' } })).toThrow(/profile name/)
    expect(() => resolveConfig({ modelProfiles: { safe: 'invalid' } })).toThrow(/provider\/model-id/)
    expect(() => resolveConfig({ forwardEnvironment: ['bad-name'] })).toThrow(/invalid environment/)
    expect(() => resolveConfig({ forwardEnvironment: ['NODE_OPTIONS'] })).toThrow(/process-control/)
    expect(() => resolveConfig({ forwardEnvironment: ['DSH_SESSION_ID'] })).toThrow(/process-control/)
  })
})

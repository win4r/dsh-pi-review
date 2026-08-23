import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Deployment-owned Pi review policy. */
export interface Config {
  authority?: 'direct-human' | 'root-turn'
  model?: string
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  timeoutMs?: number
  maxDiffBytes?: number
  maxFiles?: number
  maxOutputBytes?: number
  maxDiagnosticBytes?: number
  disposeGraceMs?: number
  requireFullSandbox?: boolean
  agentDir?: string
  forwardEnvironment?: string[]
}

/** Schemastery schema consumed by the Cordis loader. */
export const Config: z<Config> = z.object({
  authority: z.union(['direct-human', 'root-turn']).default('direct-human'),
  model: z.string(),
  thinkingLevel: z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).default('high'),
  timeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(300_000),
  maxDiffBytes: z.number().step(1).min(1_024).max(16_777_216).default(524_288),
  maxFiles: z.number().step(1).min(1).max(2_000).default(200),
  maxOutputBytes: z.number().step(1).min(4_096).max(16_777_216).default(524_288),
  maxDiagnosticBytes: z.number().step(1).min(1_024).max(1_048_576).default(65_536),
  disposeGraceMs: z.number().step(1).min(100).max(60_000).default(3_000),
  requireFullSandbox: z.boolean().default(true),
  agentDir: z.string(),
  forwardEnvironment: z.array(z.string()).default([]),
})

/** Fully validated immutable policy used during execution. */
export interface ResolvedConfig {
  readonly authority: 'direct-human' | 'root-turn'
  readonly model?: string
  readonly thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  readonly timeoutMs: number
  readonly maxDiffBytes: number
  readonly maxFiles: number
  readonly maxOutputBytes: number
  readonly maxDiagnosticBytes: number
  readonly disposeGraceMs: number
  readonly requireFullSandbox: boolean
  readonly agentDir?: string
  readonly forwardEnvironment: readonly string[]
}

function positiveInteger(value: number | undefined, fallback: number, field: string, maximum: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(`${field} must be a positive safe integer no greater than ${String(maximum)}`)
  }
  return resolved
}

function optionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`${field} must be non-empty when provided`)
  return normalized
}

const UNSAFE_FORWARD_ENVIRONMENT = new Set([
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PI_OFFLINE',
  'NO_COLOR',
  'SHELLOPTS',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
])

/** Validate direct apply() calls in addition to Loader-normalized configuration. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const authority = config.authority ?? 'direct-human'
  if (authority !== 'direct-human' && authority !== 'root-turn') {
    throw new TypeError('authority must be direct-human or root-turn')
  }
  const thinkingLevel = config.thinkingLevel ?? 'high'
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinkingLevel)) {
    throw new TypeError('thinkingLevel is invalid')
  }
  const forwardEnvironment = [...new Set(config.forwardEnvironment ?? [])]
  for (const name of forwardEnvironment) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new TypeError(`forwardEnvironment contains an invalid environment name: ${name}`)
    }
    if (UNSAFE_FORWARD_ENVIRONMENT.has(name) || name.startsWith('DSH_')) {
      throw new TypeError(`forwardEnvironment cannot pass process-control environment name: ${name}`)
    }
  }
  const agentDirValue = optionalText(config.agentDir, 'agentDir')
  const agentDir = agentDirValue === undefined
    ? undefined
    : resolve(isAbsolute(agentDirValue) ? agentDirValue : resolve(process.cwd(), agentDirValue))
  const model = optionalText(config.model, 'model')
  return {
    authority,
    ...(model === undefined ? {} : { model }),
    thinkingLevel,
    timeoutMs: positiveInteger(config.timeoutMs, 300_000, 'timeoutMs', 3_600_000),
    maxDiffBytes: positiveInteger(config.maxDiffBytes, 524_288, 'maxDiffBytes', 16_777_216),
    maxFiles: positiveInteger(config.maxFiles, 200, 'maxFiles', 2_000),
    maxOutputBytes: positiveInteger(config.maxOutputBytes, 524_288, 'maxOutputBytes', 16_777_216),
    maxDiagnosticBytes: positiveInteger(config.maxDiagnosticBytes, 65_536, 'maxDiagnosticBytes', 1_048_576),
    disposeGraceMs: positiveInteger(config.disposeGraceMs, 3_000, 'disposeGraceMs', 60_000),
    requireFullSandbox: config.requireFullSandbox ?? true,
    ...(agentDir === undefined ? {} : { agentDir }),
    forwardEnvironment,
  }
}

#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

const model = process.argv.slice(2).find(argument => argument !== '--')
  ?? process.env.PI_REVIEW_SMOKE_MODEL
if (model === undefined || !model.includes('/')) {
  throw new Error('Pass a Pi provider/model-id as argv[2] or PI_REVIEW_SMOKE_MODEL')
}

const projectRoot = resolve(import.meta.dirname, '..')
const workerPath = join(projectRoot, 'dist', 'worker.mjs')
const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-pi-review-real-'))
const ctx = new Context()

function git(...args) {
  return execFileSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' })
}

try {
  git('init', '-q')
  git('config', 'user.email', 'review@example.invalid')
  git('config', 'user.name', 'Review Smoke')
  const safeSource = [
    'export function canDeleteProject(userId: string, ownerId: string): boolean {',
    '  return userId === ownerId',
    '}',
    '',
  ].join('\n')
  const defectiveSource = safeSource.replace('userId === ownerId', '(userId = ownerId).length > 0')
  const targetPath = join(fixtureRoot, 'review-target.ts')
  await writeFile(targetPath, safeSource, 'utf8')
  git('add', 'review-target.ts')
  git('commit', '-qm', 'safe baseline')
  await writeFile(targetPath, defectiveSource, 'utf8')

  const head = git('rev-parse', 'HEAD').trim()
  const diff = git(
    'diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index',
    '--no-color', '--find-renames', 'HEAD', '--', 'review-target.ts',
  )
  let agentDir
  let modelsDocument
  const workerEnvironment = { NO_COLOR: '1', PI_OFFLINE: '1' }
  for (const name of (process.env.PI_REVIEW_SMOKE_FORWARD_ENV ?? '').split(',').filter(Boolean)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith('DSH_')) {
      throw new Error('PI_REVIEW_SMOKE_FORWARD_ENV contains an invalid name')
    }
    const value = process.env[name]
    if (value === undefined) throw new Error(`PI_REVIEW_SMOKE_FORWARD_ENV names missing variable ${name}`)
    workerEnvironment[name] = value
  }

  async function ensureAgentDir() {
    if (agentDir !== undefined) return agentDir
    agentDir = join(fixtureRoot, '.pi-review-agent')
    await mkdir(agentDir, { mode: 0o700 })
    return agentDir
  }

  const customBaseUrl = process.env.PI_REVIEW_SMOKE_CUSTOM_BASE_URL
  if (customBaseUrl !== undefined) {
    const slash = model.indexOf('/')
    const providerId = model.slice(0, slash)
    const modelId = model.slice(slash + 1)
    const keyEnvironment = process.env.PI_REVIEW_SMOKE_CUSTOM_KEY_ENV
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)
      || modelId.length === 0 || modelId.length > 256
      || keyEnvironment === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnvironment)
      || workerEnvironment[keyEnvironment] === undefined) {
      throw new Error('Custom smoke model configuration is invalid or its key environment was not forwarded')
    }
    const endpoint = new URL(customBaseUrl)
    const loopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === '::1' || endpoint.hostname === 'localhost'
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
      throw new Error('Custom smoke model endpoint must use HTTPS or loopback HTTP')
    }
    await ensureAgentDir()
    modelsDocument = JSON.stringify({
      providers: {
        [providerId]: {
          baseUrl: endpoint.href.replace(/\/$/, ''),
          api: 'openai-completions',
          apiKey: `$${keyEnvironment}`,
          models: [{
            id: modelId,
            name: `Smoke ${modelId}`,
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 16_384,
          }],
        },
      },
    })
    await writeFile(join(agentDir, 'models.json'), modelsDocument, { encoding: 'utf8', mode: 0o400 })
  }
  const request = {
    protocolVersion: 2,
    snapshot: {
      scope: 'working-tree',
      repoRoot: fixtureRoot,
      head,
      diff,
      diffHash: createHash('sha256').update(diff, 'utf8').digest('hex'),
      changedPaths: [{ status: 'M', path: 'review-target.ts' }],
      omitted: [],
    },
    model,
    severityFloor: 'low',
    thinkingLevel: 'high',
    timeoutMs: 240_000,
    ...(agentDir === undefined ? {} : { agentDir }),
  }

  await ctx.plugin(LocalSandboxProvider, {})
  const confined = ctx.sandbox.confine([process.execPath, workerPath], {
    mode: 'read-only',
    workspaceRoot: fixtureRoot,
    sessionId: 'dsh-pi-review-real-smoke',
  })
  if (confined.enforcement !== 'full') {
    throw new Error(`Real smoke requires full sandbox enforcement; received ${confined.enforcement}`)
  }

  const child = spawnSync(confined.argv[0], confined.argv.slice(1), {
    cwd: fixtureRoot,
    input: JSON.stringify(request),
    encoding: 'utf8',
    env: workerEnvironment,
    timeout: 270_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  if (child.error !== undefined) throw child.error
  if (child.signal !== null) throw new Error(`Worker terminated by ${child.signal}`)

  let envelope
  try {
    envelope = JSON.parse(child.stdout)
  } catch {
    throw new Error(`Worker returned invalid JSON; stderr bytes=${Buffer.byteLength(child.stderr)}`)
  }
  if (envelope?.protocolVersion !== 2 || envelope?.ok !== true) {
    const code = envelope?.error?.code ?? 'INVALID_ENVELOPE'
    const diagnostic = process.env.PI_REVIEW_SMOKE_DIAGNOSTICS === '1'
      ? `; diagnostic=${JSON.stringify(child.stderr.trim().slice(0, 1_024))}`
      : ''
    throw new Error(`Real Pi review failed with ${code}; stderr bytes=${Buffer.byteLength(child.stderr)}${diagnostic}`)
  }
  if (!Array.isArray(envelope.result?.findings)
    || !envelope.result.findings.some(finding => finding.path === 'review-target.ts')) {
    throw new Error('Pi did not report the deliberate authorization regression')
  }
  const usage = envelope.result?.usage
  if (usage?.reported !== true
    || !Number.isSafeInteger(usage.turns) || usage.turns < 0
    || !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0
    || !Number.isFinite(usage.estimatedCostUsd) || usage.estimatedCostUsd < 0) {
    throw new Error('Pi returned invalid one-review usage statistics')
  }
  if (await readFile(targetPath, 'utf8') !== defectiveSource) {
    throw new Error('Worker changed the review target despite read-only confinement')
  }
  if (agentDir !== undefined) {
    if (modelsDocument !== undefined && await readFile(join(agentDir, 'models.json'), 'utf8') !== modelsDocument) {
      throw new Error('Worker changed the temporary model snapshot')
    }
    const expectedAgentEntries = modelsDocument === undefined ? [] : ['models.json']
    if ((await readdir(agentDir)).sort().join('\n') !== expectedAgentEntries.join('\n')) {
      throw new Error('Worker created an unexpected agent-directory artifact')
    }
  }
  const visibleEntries = (await readdir(fixtureRoot))
    .filter(name => name !== '.git' && name !== '.pi-review-agent')
    .sort()
  if (visibleEntries.join('\n') !== 'review-target.ts') {
    throw new Error('Worker created an unexpected workspace artifact')
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    provider: envelope.result.provider,
    model: envelope.result.model,
    totalTokens: envelope.result.usage.totalTokens,
    estimatedCostUsd: envelope.result.usage.estimatedCostUsd,
    findingCount: envelope.result.findings.length,
    sandboxEnforcement: confined.enforcement,
    durationMs: envelope.result.durationMs,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
  await rm(fixtureRoot, { recursive: true, force: true })
}

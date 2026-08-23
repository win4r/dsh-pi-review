import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

let ctx: Context | undefined
const tempDirs: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('real local read-only sandbox', () => {
  it('prevents a Node worker from creating a file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-pi-review-sandbox-'))
    tempDirs.push(workspace)
    const target = join(workspace, 'must-not-exist.txt')
    ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    const confined = ctx.sandbox.confine([
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], "forbidden")',
      target,
    ], {
      mode: 'read-only',
      workspaceRoot: workspace,
    })
    const child = spawnSync(confined.argv[0] as string, confined.argv.slice(1), {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(confined.enforcement).toBe('full')
    expect(child.status).not.toBe(0)
    expect(existsSync(target)).toBe(false)
  })
})

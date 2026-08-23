import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { linkSync, renameSync, unlinkSync } from 'node:fs'
import { access, chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import {
  captureGitSnapshot,
  normalizeSnapshotRequest,
  parseBinaryPathsZ,
  parseNameStatusZ,
  parseRawPatchEnvelope,
  validateBaseRef,
  validateReviewPath,
} from '../src/git.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-'))
  roots.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'review@example.invalid')
  git(root, 'config', 'user.name', 'Review Test')
  await writeFile(join(root, 'tracked.txt'), 'alpha\nbeta\ngamma\n')
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  return root
}

async function context(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocess)
  contexts.push(ctx)
  return ctx
}

describe('Git request validation and NUL parsing', () => {
  it('closes arguments and rejects traversal, option-like refs, and cross-scope base refs', () => {
    expect(normalizeSnapshotRequest({
      scope: 'base', base_ref: 'origin/main', paths: ['src/a.ts', 'src/a.ts'],
    })).toEqual({ scope: 'base', baseRef: 'origin/main', paths: ['src/a.ts'] })
    expect(() => normalizeSnapshotRequest({ scope: 'staged', extra: true })).toThrow(/unsupported arguments/)
    expect(() => normalizeSnapshotRequest({ scope: 'staged', base_ref: 'main' })).toThrow(/only when scope is base/)
    expect(() => validateReviewPath('../secret')).toThrow(/parent segments/)
    expect(() => validateReviewPath('/etc/passwd')).toThrow(/repository-relative/)
    expect(() => validateBaseRef('--output=/tmp/x')).toThrow(/ordinary Git ref/)
    expect(() => validateBaseRef('HEAD~2')).toThrow(/ordinary Git ref/)
  })

  it('parses ordinary, rename, and binary NUL records without newline ambiguity', () => {
    expect(parseNameStatusZ('M\0src/a.ts\0R100\0old.ts\0new.ts\0')).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R100', oldPath: 'old.ts', path: 'new.ts' },
    ])
    expect(parseBinaryPathsZ(['-\t-\tsrc/image.bin', '0\t0\t', 'old.ts', 'new.ts', ''].join('\0')))
      .toEqual(new Set(['src/image.bin']))
    expect(() => parseNameStatusZ('M\0unterminated')).toThrow(/NUL-terminated/)
  })

  it('splits one raw NUL metadata envelope from its exact rename/copy-safe patch', () => {
    const oldId = 'a'.repeat(40)
    const newId = 'b'.repeat(40)
    const patch = 'diff --git a/src/a.ts b/src/a.ts\n-old\n+new\n'
    const envelope = parseRawPatchEnvelope([
      `:100644 100644 ${oldId} ${newId} M\0src/a file.ts\0`,
      `:100644 100644 ${oldId} ${newId} R100\0old.ts\0new.ts\0`,
      `:100644 100644 ${oldId} ${newId} C75\0source.ts\0:copy.ts\0`,
      '\0',
      patch,
    ].join(''))

    expect(envelope.changedPaths).toEqual([
      { status: 'M', path: 'src/a file.ts' },
      { status: 'R100', oldPath: 'old.ts', path: 'new.ts' },
      { status: 'C75', oldPath: 'source.ts', path: ':copy.ts' },
    ])
    expect(envelope.patch).toBe(patch)
    expect(() => parseRawPatchEnvelope(
      `:100644 100644 ${oldId} ${newId} M\0bad\nname.ts\0\0${patch}`,
    )).toThrow(/control characters/)
    expect(() => parseRawPatchEnvelope(
      `:100644 100644 ${oldId} ${newId} M\0src/a.ts\0${patch}`,
    )).toThrow(/unique NUL boundary/)
  })
})

describe('Git snapshot integration', () => {
  it('captures tracked, renamed, binary, and untracked changes into one hashed bounded snapshot', async () => {
    const root = await repository()
    git(root, 'mv', 'tracked.txt', 'renamed.txt')
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 9, 8, 7]))
    await writeFile(join(root, 'untracked.txt'), 'new file\n')
    const ctx = await context()
    const config = resolveConfig({ maxDiffBytes: 1_048_576, maxFiles: 20 })

    const snapshot = await captureGitSnapshot(
      ctx, root, { scope: 'working-tree' }, config, new AbortController().signal,
    )
    expect(snapshot.repoRoot).toBe(await realpath(root))
    expect(snapshot.head).toMatch(/^[0-9a-f]{40,64}$/)
    expect(snapshot.changedPaths).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'renamed.txt' }),
      expect.objectContaining({ path: 'binary.dat', binary: true }),
      expect.objectContaining({ path: 'untracked.txt', untracked: true }),
    ]))
    expect(snapshot.diff).toContain('dsh-pi-review untracked metadata')
    expect(snapshot.diff).toContain('untracked.txt')
    expect(snapshot.diffHash).toBe(createHash('sha256').update(snapshot.diff).digest('hex'))
    expect(snapshot.omitted).toEqual([])

    const staged = await captureGitSnapshot(
      ctx, root, { scope: 'staged' }, config, new AbortController().signal,
    )
    expect(staged.changedPaths.some(path => path.untracked === true)).toBe(false)
  })

  it('resolves a base ref to an immutable commit and respects repository-relative path filters', async () => {
    const root = await repository()
    git(root, 'branch', 'review-base')
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    await writeFile(join(root, 'ignored-by-filter.txt'), 'untracked\n')
    const ctx = await context()
    const snapshot = await captureGitSnapshot(
      ctx,
      root,
      { scope: 'base', baseRef: 'review-base', paths: ['tracked.txt'] },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    )
    expect(snapshot.base).toMatch(/^[0-9a-f]{40,64}$/)
    expect(snapshot.changedPaths.map(change => change.path)).toEqual(['tracked.txt'])
    expect(snapshot.diff).not.toContain('ignored-by-filter.txt')
  })

  it('treats path filters literally instead of honoring Git pathspec magic', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const ctx = await context()
    const snapshot = await captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree', paths: [':(exclude)definitely-not-a-file'] },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    )
    expect(snapshot.changedPaths).toEqual([])
    expect(snapshot.diff).toBe('')
  })

  it('rejects untracked symlinks before hashing or disclosing their targets', async () => {
    const root = await repository()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-outside-'))
    roots.push(outside)
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, 'outside secret\n')
    await symlink(secret, join(root, 'untracked-link'))
    const ctx = await context()
    await expect(captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PI_REVIEW_UNSAFE_UNTRACKED_PATH' })
  })

  it.each([
    ['tracked', 'tracked.txt', 'PI_REVIEW_UNSAFE_WORKTREE_PATH'],
    ['untracked', 'untracked-hardlink.txt', 'PI_REVIEW_UNSAFE_UNTRACKED_PATH'],
  ] as const)('rejects an external %s hardlink before any content-bearing diff', async (kind, path, code) => {
    const root = await repository()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-hardlink-'))
    roots.push(outside)
    const sentinel = 'HARDLINK_SECRET_MUST_NOT_LEAK'
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, `${sentinel}\n`)
    if (kind === 'tracked') await rm(join(root, path))
    await link(secret, join(root, path))
    const ctx = await context()
    const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const spawnedArgv: string[][] = []
    ctx.subprocess.spawn = ((spec) => {
      spawnedArgv.push([...spec.argv])
      return originalSpawn(spec)
    }) as typeof ctx.subprocess.spawn

    const outcome = await captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    ).then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    )

    expect(outcome).toHaveProperty('error')
    const failure = 'error' in outcome ? outcome.error : undefined
    expect(failure).toMatchObject({ code })
    expect(String(failure)).not.toContain(sentinel)
    expect(outcome).not.toHaveProperty('value')
    expect(spawnedArgv.some(argv => argv.includes('--binary'))).toBe(false)
  })

  it('keeps staged review frozen to index blobs when the later live file is a hardlink', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'safe indexed change\n')
    git(root, 'add', 'tracked.txt')
    const outside = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-staged-hardlink-'))
    roots.push(outside)
    const sentinel = 'UNSTAGED_HARDLINK_SECRET_MUST_NOT_LEAK'
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, `${sentinel}\n`)
    await rm(join(root, 'tracked.txt'))
    await link(secret, join(root, 'tracked.txt'))
    const ctx = await context()

    const snapshot = await captureGitSnapshot(
      ctx,
      root,
      { scope: 'staged' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    )

    expect(snapshot.diff).toContain('safe indexed change')
    expect(snapshot.diff).not.toContain(sentinel)
  })

  it('rejects a previously unchanged tracked hardlink added at content-diff spawn', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'safe frozen change\n')
    const outside = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-late-hardlink-'))
    roots.push(outside)
    const sentinel = 'LATE_UNCHANGED_PATH_SECRET_MUST_NOT_LEAK'
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, `${sentinel}\n`)
    const ctx = await context()
    const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    let contentPathspec: string[] | undefined
    ctx.subprocess.spawn = ((spec) => {
      if (contentPathspec === undefined && spec.argv.includes('--raw') && spec.argv.includes('--patch')) {
        const separator = spec.argv.lastIndexOf('--')
        contentPathspec = spec.argv.slice(separator + 1)
        unlinkSync(join(root, 'binary.dat'))
        linkSync(secret, join(root, 'binary.dat'))
      }
      return originalSpawn(spec)
    }) as typeof ctx.subprocess.spawn

    const outcome = await captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    ).then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    )

    expect(contentPathspec).toEqual(['tracked.txt'])
    expect(outcome).toHaveProperty('error')
    const failure = 'error' in outcome ? outcome.error : undefined
    expect(failure).toMatchObject({ code: 'PI_REVIEW_SNAPSHOT_RACED' })
    expect(String(failure)).not.toContain(sentinel)
    expect(outcome).not.toHaveProperty('value')
  })

  it('rejects a frozen deletion rebuilt as an external hardlink at content-diff spawn', async () => {
    const root = await repository()
    await writeFile(join(root, 'gone.txt'), 'safe deleted content\n')
    git(root, 'add', 'gone.txt')
    git(root, 'commit', '-qm', 'add deletion fixture')
    await rm(join(root, 'gone.txt'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-late-deletion-'))
    roots.push(outside)
    const sentinel = 'REBUILT_DELETION_SECRET_MUST_NOT_LEAK'
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, `${sentinel}\n`)
    const ctx = await context()
    const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    let contentPathspec: string[] | undefined
    ctx.subprocess.spawn = ((spec) => {
      if (contentPathspec === undefined && spec.argv.includes('--raw') && spec.argv.includes('--patch')) {
        const separator = spec.argv.lastIndexOf('--')
        contentPathspec = spec.argv.slice(separator + 1)
        linkSync(secret, join(root, 'gone.txt'))
      }
      return originalSpawn(spec)
    }) as typeof ctx.subprocess.spawn

    const outcome = await captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    ).then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    )

    expect(contentPathspec).toEqual(['gone.txt'])
    expect(outcome).toHaveProperty('error')
    const failure = 'error' in outcome ? outcome.error : undefined
    expect(failure).toMatchObject({ code: 'PI_REVIEW_SNAPSHOT_RACED' })
    expect(String(failure)).not.toContain(sentinel)
    expect(outcome).not.toHaveProperty('value')
  })

  it('rejects a frozen rename source rebuilt as an external hardlink', async () => {
    const root = await repository()
    git(root, 'mv', 'tracked.txt', 'renamed.txt')
    const outside = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-late-rename-'))
    roots.push(outside)
    const sentinel = 'REBUILT_RENAME_SOURCE_SECRET_MUST_NOT_LEAK'
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, `${sentinel}\n`)
    const ctx = await context()
    const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    let contentPathspec: string[] | undefined
    ctx.subprocess.spawn = ((spec) => {
      if (contentPathspec === undefined && spec.argv.includes('--raw') && spec.argv.includes('--patch')) {
        const separator = spec.argv.lastIndexOf('--')
        contentPathspec = spec.argv.slice(separator + 1)
        linkSync(secret, join(root, 'tracked.txt'))
      }
      return originalSpawn(spec)
    }) as typeof ctx.subprocess.spawn

    const outcome = await captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    ).then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    )

    expect(new Set(contentPathspec)).toEqual(new Set(['tracked.txt', 'renamed.txt']))
    expect(outcome).toHaveProperty('error')
    const failure = 'error' in outcome ? outcome.error : undefined
    expect(failure).toMatchObject({ code: 'PI_REVIEW_SNAPSHOT_RACED' })
    expect(String(failure)).not.toContain(sentinel)
    expect(outcome).not.toHaveProperty('value')
  })

  it('rejects an ABA hardlink swap even when the original file inode is restored', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'safe frozen change\n')
    const outside = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-aba-'))
    roots.push(outside)
    const sentinel = 'ABA_HARDLINK_SECRET_MUST_NOT_LEAK'
    const secret = join(outside, 'secret.txt')
    const aside = join(root, 'tracked.original')
    await writeFile(secret, `${sentinel}\n`)
    const ctx = await context()
    const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    let injected = false
    let restoreError: unknown
    ctx.subprocess.spawn = ((spec) => {
      if (!injected && spec.argv.includes('--raw') && spec.argv.includes('--patch')) {
        injected = true
        renameSync(join(root, 'tracked.txt'), aside)
        linkSync(secret, join(root, 'tracked.txt'))
        const handle = originalSpawn(spec)
        void handle.done.then(() => {
          try {
            unlinkSync(join(root, 'tracked.txt'))
            renameSync(aside, join(root, 'tracked.txt'))
          } catch (error: unknown) {
            restoreError = error
          }
        })
        return handle
      }
      return originalSpawn(spec)
    }) as typeof ctx.subprocess.spawn

    const outcome = await captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    ).then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    )

    expect(injected).toBe(true)
    expect(restoreError).toBeUndefined()
    expect(outcome).toHaveProperty('error')
    const failure = 'error' in outcome ? outcome.error : undefined
    expect(failure).toMatchObject({ code: 'PI_REVIEW_SNAPSHOT_RACED' })
    expect(String(failure)).not.toContain(sentinel)
    expect(outcome).not.toHaveProperty('value')
    await expect(access(aside)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('disables repository-configured fsmonitor commands during every snapshot command', async () => {
    const root = await repository()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-monitor-'))
    roots.push(outside)
    const marker = join(outside, 'must-not-exist')
    const monitor = join(outside, 'monitor.sh')
    await writeFile(monitor, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(marker)}\n`)
    await chmod(monitor, 0o700)
    git(root, 'config', 'core.fsmonitor', monitor)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const ctx = await context()
    await captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    )
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects repository clean/process filters before Git can execute them', async () => {
    const root = await repository()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-filter-'))
    roots.push(outside)
    const marker = join(outside, 'must-not-exist')
    const filter = join(outside, 'filter.sh')
    await writeFile(filter, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(marker)}\n/bin/cat\n`)
    await chmod(filter, 0o700)
    await writeFile(join(root, '.gitattributes'), 'tracked.txt filter=probe\n')
    git(root, 'add', '.gitattributes')
    git(root, 'commit', '-qm', 'add attributes without filter command')
    git(root, 'config', 'filter.probe.clean', filter)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    const ctx = await context()
    await expect(captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PI_REVIEW_GIT_FILTER_UNSAFE' })
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('tombstones ambient Git directory and worktree poisoning', async () => {
    const root = await repository()
    const poison = await repository()
    await writeFile(join(root, 'tracked.txt'), 'intended change\n')
    const previousDir = process.env.GIT_DIR
    const previousWorkTree = process.env.GIT_WORK_TREE
    process.env.GIT_DIR = join(poison, '.git')
    process.env.GIT_WORK_TREE = poison
    try {
      const ctx = await context()
      const snapshot = await captureGitSnapshot(
        ctx,
        root,
        { scope: 'working-tree' },
        resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
        new AbortController().signal,
      )
      expect(snapshot.repoRoot).toBe(await realpath(root))
      expect(snapshot.changedPaths.map(change => change.path)).toEqual(['tracked.txt'])
      expect(snapshot.diff).toContain('intended change')
    } finally {
      if (previousDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousDir
      if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = previousWorkTree
    }
  })

  it('rejects .git indirection to an external repository before starting Git', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-indirection-'))
    roots.push(workspace)
    const outside = await repository()
    const sentinel = 'EXTERNAL_REPOSITORY_CONTENT_MUST_NOT_LEAK'
    await writeFile(join(outside, 'tracked.txt'), `${sentinel}\n`)
    await writeFile(join(workspace, '.git'), `gitdir: ${join(outside, '.git')}\n`)
    await writeFile(join(workspace, 'workspace.txt'), 'local workspace content\n')
    const started: unknown[] = []
    const tracker = {
      add(handle: unknown): void { started.push(handle) },
      delete(): void {},
    }
    const ctx = await context()

    const outcome = await captureGitSnapshot(
      ctx,
      workspace,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
      tracker,
    ).then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    )

    expect(outcome).toHaveProperty('error')
    const failure = 'error' in outcome ? outcome.error : undefined
    expect(failure).toMatchObject({ code: 'PI_REVIEW_LINKED_WORKTREE_UNSUPPORTED' })
    expect(String(failure)).not.toContain(sentinel)
    expect(String(failure)).not.toContain(outside)
    expect(outcome).not.toHaveProperty('value')
    expect(started).toEqual([])
  })

  it('rejects a real linked worktree with the stable unsupported boundary code', async () => {
    const primary = await repository()
    const holder = await mkdtemp(join(tmpdir(), 'dsh-pi-review-linked-worktree-'))
    roots.push(holder)
    const linked = join(holder, 'checkout')
    git(primary, 'worktree', 'add', '--detach', '-q', linked)
    const ctx = await context()

    await expect(captureGitSnapshot(
      ctx,
      linked,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PI_REVIEW_LINKED_WORKTREE_UNSUPPORTED' })
  })

  it.each([
    ['commondir', (root: string) => join(root, '.git', 'commondir'), (outside: string) => join(outside, '.git')],
    [
      'alternates',
      (root: string) => join(root, '.git', 'objects', 'info', 'alternates'),
      (outside: string) => join(outside, '.git', 'objects'),
    ],
  ])('rejects external Git %s storage indirection before starting Git', async (_kind, markerFor, targetFor) => {
    const root = await repository()
    const outside = await repository()
    const sentinel = 'EXTERNAL_OBJECT_STORE_CONTENT_MUST_NOT_LEAK'
    await writeFile(join(outside, 'tracked.txt'), `${sentinel}\n`)
    await writeFile(markerFor(root), `${targetFor(outside)}\n`)
    const started: unknown[] = []
    const tracker = {
      add(handle: unknown): void { started.push(handle) },
      delete(): void {},
    }
    const ctx = await context()

    const outcome = await captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
      new AbortController().signal,
      tracker,
    ).then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    )

    expect(outcome).toHaveProperty('error')
    const failure = 'error' in outcome ? outcome.error : undefined
    expect(failure).toMatchObject({ code: 'PI_REVIEW_GIT_STORAGE_INDIRECTION_UNSUPPORTED' })
    expect(String(failure)).not.toContain(sentinel)
    expect(String(failure)).not.toContain(outside)
    expect(outcome).not.toHaveProperty('value')
    expect(started).toEqual([])
  })

  it('disables lazy fetch and tombstones trace and transport controls for every Git subprocess', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'changed without object fetching\n')
    const outside = await mkdtemp(join(tmpdir(), 'dsh-pi-review-git-env-'))
    roots.push(outside)
    const traceMarker = join(outside, 'trace.log')
    const trace2Marker = join(outside, 'trace2.json')
    const sanitizedNames = [
      'GIT_TRACE',
      'GIT_TRACE2_EVENT',
      'GIT_TRACE_CUSTOM_SINK',
      'GIT_ASKPASS',
      'GIT_SSH',
      'GIT_SSH_COMMAND',
      'GIT_PROXY_COMMAND',
    ] as const
    const previous = new Map(sanitizedNames.map(name => [name, process.env[name]]))
    process.env.GIT_TRACE = traceMarker
    process.env.GIT_TRACE2_EVENT = trace2Marker
    process.env.GIT_TRACE_CUSTOM_SINK = join(outside, 'custom-trace.log')
    process.env.GIT_ASKPASS = join(outside, 'askpass')
    process.env.GIT_SSH = join(outside, 'ssh')
    process.env.GIT_SSH_COMMAND = join(outside, 'ssh-command')
    process.env.GIT_PROXY_COMMAND = join(outside, 'proxy-command')
    const ctx = await context()
    const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const subprocessEnvironments: Array<typeof process.env | undefined> = []
    ctx.subprocess.spawn = ((spec) => {
      subprocessEnvironments.push(spec.env)
      return originalSpawn(spec)
    }) as typeof ctx.subprocess.spawn

    try {
      await captureGitSnapshot(
        ctx,
        root,
        { scope: 'working-tree' },
        resolveConfig({ maxDiffBytes: 65_536, maxFiles: 5 }),
        new AbortController().signal,
      )
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }

    expect(subprocessEnvironments.length).toBeGreaterThan(0)
    for (const environment of subprocessEnvironments) {
      expect(environment?.GIT_NO_LAZY_FETCH).toBe('1')
      for (const name of sanitizedNames) expect(environment?.[name]).toBeUndefined()
    }
    await expect(access(traceMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(trace2Marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed instead of truncating oversized diffs or accepting too many files', async () => {
    const root = await repository()
    await writeFile(join(root, 'large.txt'), 'x'.repeat(20_000))
    await writeFile(join(root, 'second.txt'), 'second\n')
    const ctx = await context()
    await expect(captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 1_024, maxFiles: 10 }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PI_REVIEW_SNAPSHOT_TOO_LARGE' })
    await expect(captureGitSnapshot(
      ctx,
      root,
      { scope: 'working-tree' },
      resolveConfig({ maxDiffBytes: 1_048_576, maxFiles: 1 }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PI_REVIEW_TOO_MANY_FILES' })
  })
})

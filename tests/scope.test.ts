import { createHash } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeSnapshotPath,
  ReviewScope,
  ScopeError,
  sortFindings,
} from '../src/scope.ts'
import type { GitSnapshot, ReviewFinding } from '../src/types.ts'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function fixture(): { root: string, outside: string, snapshot: GitSnapshot } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-review-scope-'))
  const outside = mkdtempSync(join(tmpdir(), 'dsh-pi-review-outside-'))
  fixtures.push(root, outside)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/current.ts'), 'export const current = true\n', 'utf8')
  writeFileSync(join(root, 'src/new.ts'), 'export const renamed = true\n', 'utf8')
  writeFileSync(join(root, 'src/added.ts'), 'export const added = true\n', 'utf8')
  writeFileSync(join(root, 'src/unchanged-secret.ts'), 'do not expose\n', 'utf8')
  writeFileSync(join(outside, 'secret.ts'), 'outside secret\n', 'utf8')
  symlinkSync(join(outside, 'secret.ts'), join(root, 'src/escape.ts'))

  const diff = 'diff --git a/src/current.ts b/src/current.ts\n+changed\n'
  return {
    root,
    outside,
    snapshot: {
      scope: 'working-tree',
      repoRoot: root,
      head: 'a'.repeat(40),
      diff,
      diffHash: createHash('sha256').update(diff).digest('hex'),
      changedPaths: [
        { status: 'M', path: 'src/current.ts' },
        { status: 'R100', oldPath: 'src/old.ts', path: 'src/new.ts' },
        { status: 'A', path: 'src/added.ts' },
        { status: 'D', path: 'src/deleted.ts' },
        { status: 'M', path: 'src/escape.ts' },
      ],
      omitted: [],
    },
  }
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'high',
    category: 'correctness',
    confidence: 'high',
    path: 'src/current.ts',
    side: 'new',
    line: 1,
    title: 'Concrete bug',
    evidence: 'The changed line violates the invariant.',
    impact: 'The operation returns the wrong value.',
    ...overrides,
  }
}

describe('ReviewScope filesystem boundary', () => {
  it('normalizes safe Git paths and rejects traversal and absolute paths', () => {
    expect(normalizeSnapshotPath('./src/current.ts')).toBe('src/current.ts')
    expect(() => normalizeSnapshotPath('../secret')).toThrow(ScopeError)
    expect(() => normalizeSnapshotPath('/tmp/secret')).toThrow(ScopeError)
    expect(() => normalizeSnapshotPath('')).toThrow(ScopeError)
  })

  it('exposes only existing non-binary changed regular files and rejects symlink escapes', async () => {
    const { root, outside, snapshot } = fixture()
    const scope = new ReviewScope(snapshot)

    expect(scope.currentFiles.map(file => file.path)).toEqual([
      'src/added.ts',
      'src/current.ts',
      'src/new.ts',
    ])
    await expect(scope.readCurrentFile('src/current.ts')).resolves.toEqual(Buffer.from('export const current = true\n'))
    expect(() => scope.assertCurrentFile('src/unchanged-secret.ts')).toThrow(ScopeError)
    expect(() => scope.assertCurrentFile(join(outside, 'secret.ts'))).toThrow(ScopeError)
    expect(() => scope.assertCurrentFile('src/escape.ts')).toThrow(ScopeError)
    expect(() => scope.assertCurrentFile('src/deleted.ts')).toThrow(ScopeError)
    expect(scope.virtualExists(root)).toBe(true)
  })

  it('provides virtual directory views containing only scoped changed files', () => {
    const { root, snapshot } = fixture()
    const scope = new ReviewScope(snapshot)

    expect(scope.virtualReadDirectory(root)).toEqual(['src'])
    expect(scope.virtualReadDirectory(join(root, 'src'))).toEqual(['added.ts', 'current.ts', 'new.ts'])
    expect(scope.selectCurrentFiles('src').map(file => file.path)).toEqual([
      'src/added.ts',
      'src/current.ts',
      'src/new.ts',
    ])
    expect(scope.virtualExists(join(root, 'src/unchanged-secret.ts'))).toBe(false)
  })

  it('revalidates the captured canonical file and denies a later symlink replacement', async () => {
    const { root, outside, snapshot } = fixture()
    const scope = new ReviewScope(snapshot)
    unlinkSync(join(root, 'src/current.ts'))
    symlinkSync(join(outside, 'secret.ts'), join(root, 'src/current.ts'))

    expect(() => scope.assertCurrentFile('src/current.ts')).toThrow(/no longer safely readable/)
    await expect(scope.readCurrentFile('src/current.ts')).rejects.toThrow(/safely readable/)
  })

  it('excludes a changed path that is already an external hard link before scope construction', async () => {
    const { root, outside, snapshot } = fixture()
    const currentPath = join(root, 'src/current.ts')
    unlinkSync(currentPath)
    linkSync(join(outside, 'secret.ts'), currentPath)

    const scope = new ReviewScope(snapshot)
    expect(scope.currentFiles.map(file => file.path)).not.toContain('src/current.ts')
    expect(() => scope.assertCurrentFile('src/current.ts')).toThrow(/outside the captured/)
    await expect(scope.readCurrentFile('src/current.ts')).rejects.toThrow(/outside the captured/)
  })

  it('fails closed when a captured file gains an external hard link before read or line validation', async () => {
    const { root, outside, snapshot } = fixture()
    const scope = new ReviewScope(snapshot)
    const captured = scope.assertCurrentFile('src/current.ts')
    expect(captured.linkCount).toBe(1)
    linkSync(join(root, 'src/current.ts'), join(outside, 'late-hardlink.ts'))

    expect(() => scope.assertCurrentFile('src/current.ts')).toThrow(/no longer safely readable/)
    await expect(scope.accessCurrentFile('src/current.ts')).rejects.toThrow(/safely readable/)
    await expect(scope.readCurrentFile('src/current.ts')).rejects.toThrow(/safely readable/)
    expect(() => scope.validateCurrentLine(finding({ line: 1 }))).toThrow(/safely readable/)
  })

  it('never maps a frozen staged snapshot to later unstaged worktree content', async () => {
    const { root, snapshot } = fixture()
    const indexedDiff = [
      'diff --git a/src/current.ts b/src/current.ts',
      '--- a/src/current.ts',
      '+++ b/src/current.ts',
      '@@ -1 +1 @@',
      '-export const current = false',
      '+export const indexed = "A"',
      '',
    ].join('\n')
    writeFileSync(join(root, 'src/current.ts'), 'export const unstaged = "SECRET"\n', 'utf8')
    const scope = new ReviewScope({
      ...snapshot,
      scope: 'staged',
      diff: indexedDiff,
      diffHash: createHash('sha256').update(indexedDiff).digest('hex'),
      changedPaths: [{ status: 'M', path: 'src/current.ts' }],
    })

    expect(scope.currentFiles).toEqual([])
    expect(scope.virtualExists(root)).toBe(false)
    expect(() => scope.assertCurrentFile('src/current.ts')).toThrow(/unavailable for staged/)
    await expect(scope.readCurrentFile('src/current.ts')).rejects.toThrow(/unavailable for staged/)
    expect(() => scope.virtualReadDirectory(root)).toThrow(/unavailable for staged/)
    expect(() => scope.selectCurrentFiles(root)).toThrow(/unavailable for staged/)

    const stagedFinding = scope.normalizeFinding(finding({ line: 999 }))
    expect(stagedFinding.path).toBe('src/current.ts')
    expect(() => scope.validateCurrentLine(stagedFinding)).not.toThrow()
  })

  it('never maps frozen branch or commit snapshots to live worktree files', async () => {
    const { root, snapshot } = fixture()
    writeFileSync(join(root, 'src/current.ts'), 'export const liveWorktreeSecret = true\n', 'utf8')

    for (const frozenScope of ['branch', 'commit'] as const) {
      const scope = new ReviewScope({ ...snapshot, scope: frozenScope })
      expect(scope.currentFiles).toEqual([])
      expect(scope.virtualExists(root)).toBe(false)
      expect(() => scope.assertCurrentFile('src/current.ts')).toThrow(new RegExp(`unavailable for ${frozenScope}`))
      expect(() => scope.selectCurrentFiles('.')).toThrow(new RegExp(`unavailable for ${frozenScope}`))
      expect(() => scope.validateCurrentLine(finding({ line: 999 }))).not.toThrow()
    }
  })
})

describe('ReviewScope finding boundary', () => {
  it('accepts deleted and renamed old paths without requiring them on disk', () => {
    const { snapshot } = fixture()
    const scope = new ReviewScope(snapshot)

    expect(scope.normalizeFinding(finding({ path: 'src/deleted.ts', side: 'old' })).path).toBe('src/deleted.ts')
    expect(scope.normalizeFinding(finding({ path: 'src/old.ts', side: 'old' })).path).toBe('src/old.ts')
    expect(scope.normalizeFinding(finding({ path: 'src/new.ts', side: 'new' })).path).toBe('src/new.ts')
  })

  it('rejects inconsistent sides, unchanged paths, traversal, and invalid current lines', () => {
    const { snapshot } = fixture()
    const scope = new ReviewScope(snapshot)

    expect(() => scope.normalizeFinding(finding({ path: 'src/deleted.ts', side: 'new' }))).toThrow(ScopeError)
    expect(() => scope.normalizeFinding(finding({ path: 'src/added.ts', side: 'old' }))).toThrow(ScopeError)
    expect(() => scope.normalizeFinding(finding({ path: 'src/new.ts', side: 'old' }))).toThrow(ScopeError)
    expect(() => scope.normalizeFinding(finding({ path: 'src/unchanged-secret.ts' }))).toThrow(ScopeError)
    expect(() => scope.normalizeFinding(finding({ path: '../outside.ts' }))).toThrow(ScopeError)
    expect(() => scope.normalizeFinding(finding({ category: 'invalid' as never }))).toThrow(/category/)
    expect(() => scope.validateCurrentLine(finding({ line: 99 }))).toThrow(/exceeds/)
  })

  it('normalizes text and sorts findings deterministically', () => {
    const { snapshot } = fixture()
    const scope = new ReviewScope(snapshot)
    const normalized = scope.normalizeFinding(finding({ title: '  Multi\n line   title  ', evidence: ' evidence ', impact: ' impact ' }))
    expect(normalized.title).toBe('Multi line title')
    expect(normalized.evidence).toBe('evidence')

    const sorted = sortFindings([
      finding({ severity: 'low', title: 'Low' }),
      finding({ severity: 'critical', confidence: 'low', title: 'Critical low confidence' }),
      finding({ severity: 'critical', confidence: 'high', title: 'Critical high confidence' }),
    ])
    expect(sorted.map(item => item.title)).toEqual([
      'Critical high confidence',
      'Critical low confidence',
      'Low',
    ])
  })
})

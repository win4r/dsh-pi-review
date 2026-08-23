/** Symlink-aware, fail-closed filesystem and finding scope for one Git snapshot. */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import {
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'
import type {
  ChangedPath,
  GitSnapshot,
  ReviewFinding,
} from './types.ts'

/** Source reads are deliberately smaller than the process protocol limit. */
export const MAX_SCOPED_SOURCE_BYTES = 4 * 1024 * 1024

export class ScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeError'
  }
}

export interface ScopedCurrentFile {
  readonly path: string
  readonly absolutePath: string
  readonly canonicalPath: string
  readonly size: number
  readonly device: number
  readonly inode: number
  readonly linkCount: number
}

interface ScopedFileStats {
  isFile(): boolean
  readonly dev: number
  readonly ino: number
  readonly nlink: number
}

function descriptorMatchesCapturedFile(stats: ScopedFileStats, file: ScopedCurrentFile): boolean {
  return stats.isFile()
    && stats.dev === file.device
    && stats.ino === file.inode
    && stats.nlink === 1
    && stats.nlink === file.linkCount
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/** Normalize a Git-style path without ever resolving it outside the repository. */
export function normalizeSnapshotPath(value: string): string {
  if (value.length === 0 || value.includes('\0') || isAbsolute(value) || value.startsWith('\\')) {
    throw new ScopeError('review path must be a non-empty relative path')
  }
  const normalized = posix.normalize(value.replace(/^\.\//, ''))
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new ScopeError('review path escapes the repository')
  }
  return normalized
}

function statusStartsWith(changed: ChangedPath, status: string): boolean {
  return changed.status.trimStart().toUpperCase().startsWith(status)
}

function isDeleted(changed: ChangedPath): boolean {
  return statusStartsWith(changed, 'D')
}

function isAdded(changed: ChangedPath): boolean {
  return changed.untracked === true || statusStartsWith(changed, 'A') || changed.status.trim() === '??'
}

function validateChangedStatus(changed: ChangedPath, oldPath: string | undefined): void {
  if (changed.status === '??') {
    if (oldPath !== undefined || changed.untracked !== true) {
      throw new ScopeError('untracked snapshot metadata is inconsistent')
    }
    return
  }
  const match = /^([ACDMRTUXB])([0-9]*)$/.exec(changed.status)
  if (match === null) throw new ScopeError('snapshot contains an invalid Git status')
  const kind = match[1]
  const score = match[2]
  const isRenameOrCopy = kind === 'R' || kind === 'C'
  if (isRenameOrCopy !== (oldPath !== undefined)) {
    throw new ScopeError('snapshot rename or copy metadata is inconsistent')
  }
  if (score !== '' && (!isRenameOrCopy || Number(score) > 100)) {
    throw new ScopeError('snapshot contains an invalid Git similarity score')
  }
  if (changed.untracked === true) throw new ScopeError('tracked snapshot metadata is inconsistent')
}

function canonicalFile(repoRoot: string, logicalPath: string, binary: boolean): ScopedCurrentFile | undefined {
  if (binary) return undefined
  const absolutePath = resolve(repoRoot, logicalPath)
  if (!isWithin(repoRoot, absolutePath) || !existsSync(absolutePath)) return undefined

  try {
    // A changed symlink is represented completely by the diff; following it could
    // reveal an unchanged or out-of-repository target.
    if (lstatSync(absolutePath).isSymbolicLink()) return undefined
    const canonicalPath = realpathSync.native(absolutePath)
    if (!isWithin(repoRoot, canonicalPath)) return undefined
    const stats = statSync(canonicalPath)
    if (!stats.isFile() || stats.nlink !== 1) return undefined
    return {
      path: logicalPath,
      absolutePath,
      canonicalPath,
      size: stats.size,
      device: stats.dev,
      inode: stats.ino,
      linkCount: stats.nlink,
    }
  } catch {
    return undefined
  }
}

function stringField(value: string, label: string, maximum: number, singleLine = false): string {
  const normalized = singleLine ? value.replace(/\s+/g, ' ').trim() : value.trim()
  if (normalized.length === 0 || normalized.length > maximum || normalized.includes('\0')) {
    throw new ScopeError(`${label} is invalid`)
  }
  return normalized
}

/**
 * Immutable logical scope derived from the host-captured snapshot.
 *
 * Directory operations are virtual: they enumerate only captured, readable
 * changed files and never call readdir() on the repository.
 */
export class ReviewScope {
  readonly repoRoot: string
  readonly currentFiles: readonly ScopedCurrentFile[]

  readonly #currentFileAccessAllowed: boolean
  readonly #currentByPath: ReadonlyMap<string, ScopedCurrentFile>
  readonly #changedByNewPath: ReadonlyMap<string, ChangedPath>
  readonly #changedByOldPath: ReadonlyMap<string, ChangedPath>
  readonly #inputRepoRoot: string

  constructor(snapshot: GitSnapshot) {
    let repoRoot: string
    try {
      repoRoot = realpathSync.native(snapshot.repoRoot)
      if (!statSync(repoRoot).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new ScopeError('snapshot repository root is unavailable')
    }

    const currentFileAccessAllowed = snapshot.scope !== 'staged'
    const changedByNewPath = new Map<string, ChangedPath>()
    const changedByOldPath = new Map<string, ChangedPath>()
    const currentByPath = new Map<string, ScopedCurrentFile>()

    for (const changed of snapshot.changedPaths) {
      const path = normalizeSnapshotPath(changed.path)
      const oldPath = changed.oldPath === undefined ? undefined : normalizeSnapshotPath(changed.oldPath)
      validateChangedStatus(changed, oldPath)
      if (changedByNewPath.has(path)) throw new ScopeError('snapshot contains duplicate changed paths')

      const normalizedChanged: ChangedPath = {
        ...changed,
        path,
        ...(oldPath === undefined ? {} : { oldPath }),
      }
      changedByNewPath.set(path, normalizedChanged)
      if (oldPath !== undefined) {
        // Git may report one source copied to multiple new paths. Any one of
        // those records establishes the same logical old-side review scope.
        if (!changedByOldPath.has(oldPath)) changedByOldPath.set(oldPath, normalizedChanged)
      }

      // A staged snapshot is frozen from the index, while this filesystem is
      // the live worktree. Never map staged new-side paths to worktree files:
      // they may contain later unstaged or untracked secrets.
      if (currentFileAccessAllowed && !isDeleted(normalizedChanged)) {
        const file = canonicalFile(repoRoot, path, normalizedChanged.binary === true)
        if (file !== undefined) currentByPath.set(path, file)
      }
    }

    this.repoRoot = repoRoot
    this.currentFiles = [...currentByPath.values()].sort((left, right) => left.path.localeCompare(right.path))
    this.#currentFileAccessAllowed = currentFileAccessAllowed
    this.#currentByPath = currentByPath
    this.#changedByNewPath = changedByNewPath
    this.#changedByOldPath = changedByOldPath
    this.#inputRepoRoot = resolve(snapshot.repoRoot)
  }

  /** Revalidate an exact changed current file immediately before access. */
  assertCurrentFile(requestedPath: string): ScopedCurrentFile {
    this.#assertCurrentFileAccess()
    const logicalPath = this.#logicalPath(requestedPath)
    const captured = this.#currentByPath.get(logicalPath)
    if (captured === undefined) throw new ScopeError('requested file is outside the captured current-file scope')

    const refreshed = canonicalFile(this.repoRoot, logicalPath, false)
    if (refreshed === undefined
      || refreshed.canonicalPath !== captured.canonicalPath
      || refreshed.device !== captured.device
      || refreshed.inode !== captured.inode
      || refreshed.linkCount !== 1
      || refreshed.linkCount !== captured.linkCount) {
      throw new ScopeError('captured file is no longer safely readable')
    }
    if (refreshed.size > MAX_SCOPED_SOURCE_BYTES) {
      throw new ScopeError('captured file exceeds the source read limit')
    }
    return refreshed
  }

  async accessCurrentFile(requestedPath: string): Promise<void> {
    const { handle, file } = await this.#openCurrentFile(requestedPath)
    try {
      if (!descriptorMatchesCapturedFile(await handle.stat(), file)) {
        throw new ScopeError('captured file changed while it was being accessed')
      }
    } finally {
      await handle.close()
    }
  }

  async readCurrentFile(requestedPath: string): Promise<Buffer> {
    const { handle, file } = await this.#openCurrentFile(requestedPath)
    try {
      if (file.size > MAX_SCOPED_SOURCE_BYTES) {
        throw new ScopeError('captured file exceeds the source read limit')
      }
      const content = await handle.readFile()
      if (content.byteLength > MAX_SCOPED_SOURCE_BYTES) {
        throw new ScopeError('captured file exceeds the source read limit')
      }
      if (!descriptorMatchesCapturedFile(await handle.stat(), file)) {
        throw new ScopeError('captured file changed while it was being read')
      }
      return content
    } finally {
      await handle.close()
    }
  }

  /** Whether an absolute Pi tool path is a virtual directory or scoped file. */
  virtualExists(requestedPath: string): boolean {
    if (!this.#currentFileAccessAllowed) return false
    try {
      const logicalPath = this.#selectorPath(requestedPath)
      return logicalPath === '.'
        || this.#currentByPath.has(logicalPath)
        || this.currentFiles.some(file => file.path.startsWith(`${logicalPath}/`))
    } catch {
      return false
    }
  }

  virtualIsDirectory(requestedPath: string): boolean {
    this.#assertCurrentFileAccess()
    const logicalPath = this.#selectorPath(requestedPath)
    if (this.#currentByPath.has(logicalPath)) return false
    return logicalPath === '.' || this.currentFiles.some(file => file.path.startsWith(`${logicalPath}/`))
  }

  /** Return only direct virtual children of a scoped selector. */
  virtualReadDirectory(requestedPath: string): string[] {
    this.#assertCurrentFileAccess()
    const logicalPath = this.#selectorPath(requestedPath)
    if (!this.virtualIsDirectory(requestedPath)) throw new ScopeError('requested directory is outside review scope')
    const prefix = logicalPath === '.' ? '' : `${logicalPath}/`
    const children = new Set<string>()
    for (const file of this.currentFiles) {
      if (!file.path.startsWith(prefix)) continue
      const remainder = file.path.slice(prefix.length)
      const child = remainder.split('/')[0]
      if (child !== undefined && child.length > 0) children.add(child)
    }
    return [...children].sort((left, right) => left.localeCompare(right))
  }

  /** Return scoped absolute files below a selector, for the virtual find tool. */
  selectCurrentFiles(requestedPath = '.'): readonly ScopedCurrentFile[] {
    this.#assertCurrentFileAccess()
    const logicalPath = this.#selectorPath(requestedPath)
    const exact = this.#currentByPath.get(logicalPath)
    if (exact !== undefined) return [this.assertCurrentFile(exact.path)]
    if (logicalPath !== '.' && !this.currentFiles.some(file => file.path.startsWith(`${logicalPath}/`))) {
      throw new ScopeError('requested selector is outside review scope')
    }
    const prefix = logicalPath === '.' ? '' : `${logicalPath}/`
    return this.currentFiles
      .filter(file => file.path.startsWith(prefix))
      .map(file => this.assertCurrentFile(file.path))
  }

  /** Validate logical old/new findings without requiring deleted or renamed-old files to exist. */
  normalizeFinding(finding: ReviewFinding): ReviewFinding {
    const path = normalizeSnapshotPath(finding.path)
    const newChange = this.#changedByNewPath.get(path)
    const oldChange = this.#changedByOldPath.get(path) ?? newChange

    if (finding.side === 'new') {
      if (newChange === undefined || isDeleted(newChange)) {
        throw new ScopeError('finding new-side path is outside the captured diff')
      }
    } else {
      if (oldChange === undefined || (oldChange.oldPath === undefined && isAdded(oldChange))) {
        throw new ScopeError('finding old-side path is outside the captured diff')
      }
      if (oldChange.oldPath !== undefined && oldChange.oldPath !== path) {
        throw new ScopeError('renamed old-side finding must use the captured old path')
      }
    }

    if (!['critical', 'high', 'medium', 'low'].includes(finding.severity)) {
      throw new ScopeError('finding severity is invalid')
    }
    if (!['high', 'medium', 'low'].includes(finding.confidence)) {
      throw new ScopeError('finding confidence is invalid')
    }
    if (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || finding.line < 1)) {
      throw new ScopeError('finding line is invalid')
    }

    const suggestion = finding.suggestion?.trim()
    return {
      severity: finding.severity,
      confidence: finding.confidence,
      path,
      side: finding.side,
      ...(finding.line === undefined ? {} : { line: finding.line }),
      title: stringField(finding.title, 'finding title', 240, true),
      evidence: stringField(finding.evidence, 'finding evidence', 12_000),
      impact: stringField(finding.impact, 'finding impact', 8_000),
      ...(suggestion === undefined || suggestion.length === 0
        ? {}
        : { suggestion: stringField(suggestion, 'finding suggestion', 8_000) }),
    }
  }

  /** Best-effort line check only when the exact new-side current file still exists. */
  validateCurrentLine(finding: ReviewFinding): void {
    if (finding.side !== 'new' || finding.line === undefined) return
    const current = this.#currentByPath.get(finding.path)
    if (current === undefined || current.size > MAX_SCOPED_SOURCE_BYTES) return
    const file = this.assertCurrentFile(finding.path)
    let descriptor: number | undefined
    try {
      descriptor = openSync(file.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const opened = fstatSync(descriptor)
      if (!descriptorMatchesCapturedFile(opened, file)) {
        throw new ScopeError('captured file changed while it was being opened')
      }
      const content = readFileSync(descriptor, 'utf8')
      if (!descriptorMatchesCapturedFile(fstatSync(descriptor), file)) {
        throw new ScopeError('captured file changed while its finding line was being validated')
      }
      const lineCount = content.split(/\r?\n/).length
      if (finding.line > lineCount) throw new ScopeError('finding line exceeds the current file')
    } catch (error) {
      if (error instanceof ScopeError) throw error
      throw new ScopeError('captured file is no longer safely readable')
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  /** Open once, verify the opened inode, and let callers read through that descriptor. */
  async #openCurrentFile(requestedPath: string): Promise<{ file: ScopedCurrentFile, handle: FileHandle }> {
    const file = this.assertCurrentFile(requestedPath)
    let handle: FileHandle | undefined
    try {
      handle = await open(file.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const opened = await handle.stat()
      if (!descriptorMatchesCapturedFile(opened, file)) {
        throw new ScopeError('captured file changed while it was being opened')
      }
      return { file, handle }
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined)
      if (error instanceof ScopeError) throw error
      throw new ScopeError('captured file is no longer safely readable')
    }
  }

  #assertCurrentFileAccess(): void {
    if (!this.#currentFileAccessAllowed) {
      throw new ScopeError('current-file access is unavailable for staged snapshots; use review_diff')
    }
  }

  #logicalPath(requestedPath: string): string {
    if (isAbsolute(requestedPath)) {
      const absolute = resolve(requestedPath)
      const root = isWithin(this.repoRoot, absolute)
        ? this.repoRoot
        : isWithin(this.#inputRepoRoot, absolute)
          ? this.#inputRepoRoot
          : undefined
      if (root === undefined) throw new ScopeError('requested path escapes the repository')
      const relativePath = relative(root, absolute).split(sep).join('/')
      return normalizeSnapshotPath(relativePath)
    }
    return normalizeSnapshotPath(requestedPath)
  }

  #selectorPath(requestedPath: string): string {
    if (requestedPath === '' || requestedPath === '.') return '.'
    if (isAbsolute(requestedPath)) {
      const absolute = resolve(requestedPath)
      if (absolute === this.repoRoot || absolute === this.#inputRepoRoot) return '.'
    }
    return this.#logicalPath(requestedPath)
  }
}

export function sortFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const
  const confidenceOrder = { high: 0, medium: 1, low: 2 } as const
  return [...findings].sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity]
      || confidenceOrder[left.confidence] - confidenceOrder[right.confidence]
      || left.path.localeCompare(right.path)
      || (left.line ?? 0) - (right.line ?? 0)
      || left.title.localeCompare(right.title))
}

/** Bounded, shell-free Git snapshot acquisition for Pi review. */

import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { ResolvedConfig } from './config.ts'
import type { ChangedPath, GitSnapshot, ReviewScope } from './types.ts'

const MAX_PATH_BYTES = 4_096
const MAX_GIT_METADATA_BYTES = 16_777_216
const ZERO_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'
const GIT_TRACE_ENVIRONMENT = [
  'GIT_TRACE',
  'GIT_TRACE_PACK_ACCESS',
  'GIT_TRACE_PACKET',
  'GIT_TRACE_PERFORMANCE',
  'GIT_TRACE_SETUP',
  'GIT_TRACE_SHALLOW',
  'GIT_TRACE_CURL',
  'GIT_TRACE_CURL_NO_DATA',
  'GIT_TRACE_REFS',
  'GIT_TRACE_FSMONITOR',
  'GIT_TRACE_INDEX',
  'GIT_TRACE2',
  'GIT_TRACE2_EVENT',
  'GIT_TRACE2_PERF',
  'GIT_TRACE2_BRIEF',
  'GIT_TRACE2_CONFIG_PARAMS',
  'GIT_TRACE2_ENV_VARS',
] as const

function gitTraceTombstones(): Record<string, undefined> {
  const names = new Set<string>(GIT_TRACE_ENVIRONMENT)
  for (const name of Object.keys(process.env)) {
    if (name === 'GIT_TRACE' || name.startsWith('GIT_TRACE_') || name.startsWith('GIT_TRACE2')) {
      names.add(name)
    }
  }
  return Object.fromEntries([...names].map(name => [name, undefined]))
}

/** Exact model-facing snapshot request after schema validation. */
export interface GitSnapshotRequest {
  readonly scope: ReviewScope
  readonly baseRef?: string
  readonly headRef?: string
  readonly commitRef?: string
  readonly paths?: readonly string[]
}

/** Optional process ownership shared with the host lifecycle. */
export interface ProcessTracker {
  add(handle: SubprocessHandle): void
  delete(handle: SubprocessHandle): void
}

interface GitRunOptions {
  readonly stdoutMaxBytes: number
  readonly allowedExitCodes?: readonly number[]
  readonly stdin?: string
}

interface GitRunResult {
  readonly stdout: string
  readonly outcome: SubprocessOutcome
}

interface UntrackedMetadata {
  readonly path: string
  readonly size: number
  readonly mode: string
  readonly binary: boolean
}

interface LiveWorktreeMetadata {
  readonly path: string
  readonly device: bigint
  readonly inode: bigint
  readonly links: bigint
  readonly size: bigint
  readonly mode: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

interface WorktreeDirectoryMetadata {
  readonly absolutePath: string
  readonly device: bigint
  readonly inode: bigint
  readonly links: bigint
  readonly size: bigint
  readonly mode: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

/** Structured acquisition failure carried through the normal tool error path. */
export class GitSnapshotError extends HarnessError {
  constructor(message: string, code = 'PI_REVIEW_GIT_FAILED', options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'GitSnapshotError'
  }
}

function aborted(signal: AbortSignal): never {
  throw new GitSnapshotError(
    'Git snapshot acquisition was aborted before completion',
    'PI_REVIEW_ABORTED',
  )
}

function boundedMetadataCap(maxFiles: number): number {
  return Math.min(MAX_GIT_METADATA_BYTES, 65_536 + maxFiles * (MAX_PATH_BYTES * 3 + 64))
}

function completeOutput(
  stream: ReturnType<NonNullable<SubprocessHandle['collected']['stdout']>['readFrom']> | undefined,
  label: string,
): string {
  if (stream === undefined) {
    throw new GitSnapshotError(`Git ${label} stream was not collected`)
  }
  if (stream.lossy) {
    throw new GitSnapshotError(
      `Git ${label} exceeded its configured byte limit`,
      'PI_REVIEW_SNAPSHOT_TOO_LARGE',
    )
  }
  return stream.text
}

/** Run one exact argv vector through the Harness subprocess seam. */
async function runGit(
  ctx: Context,
  git: string,
  cwd: string,
  args: readonly string[],
  config: ResolvedConfig,
  signal: AbortSignal,
  tracker: ProcessTracker | undefined,
  options: GitRunOptions,
): Promise<GitRunResult> {
  if (signal.aborted) return aborted(signal)
  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv: [
        git,
        '--no-pager',
        '--literal-pathspecs',
        '-c', 'core.fsmonitor=false',
        '-c', `core.hooksPath=${ZERO_DEVICE}`,
        '-c', `core.worktree=${cwd}`,
        ...args,
      ],
      cwd,
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: { maxBytes: options.stdoutMaxBytes },
        stderr: { maxBytes: config.maxDiagnosticBytes },
      },
      graceMs: config.disposeGraceMs,
      signal,
      env: {
        ...gitTraceTombstones(),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: ZERO_DEVICE,
        GIT_CONFIG_SYSTEM: ZERO_DEVICE,
        GIT_ATTR_NOSYSTEM: '1',
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_IMPLICIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_CONFIG: undefined,
        GIT_CONFIG_COUNT: undefined,
        GIT_CONFIG_PARAMETERS: undefined,
        GIT_CEILING_DIRECTORIES: undefined,
        GIT_DISCOVERY_ACROSS_FILESYSTEM: undefined,
        GIT_EXEC_PATH: undefined,
        GIT_EXTERNAL_DIFF: undefined,
        GIT_DIFF_OPTS: undefined,
        GIT_ASKPASS: undefined,
        GIT_SSH: undefined,
        GIT_SSH_COMMAND: undefined,
        GIT_PROXY_COMMAND: undefined,
        GIT_LITERAL_PATHSPECS: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        PAGER: 'cat',
      },
    } satisfies SubprocessSpawnSpec)
  } catch (error: unknown) {
    if (signal.aborted) return aborted(signal)
    throw new GitSnapshotError('Unable to start Git while acquiring the review snapshot', 'PI_REVIEW_GIT_FAILED', { cause: error })
  }
  tracker?.add(handle)
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    if (signal.aborted) return aborted(signal)
    throw new GitSnapshotError('Git failed to start while acquiring the review snapshot', 'PI_REVIEW_GIT_FAILED', { cause: error })
  } finally {
    try {
      await handle.waitForExit()
    } finally {
      tracker?.delete(handle)
    }
  }
  if (signal.aborted) return aborted(signal)
  const stdout = completeOutput(handle.collected.stdout?.readFrom(0), 'stdout')
  const stderrRead = handle.collected.stderr?.readFrom(0)
  const stderr = stderrRead?.text ?? ''
  const allowed = options.allowedExitCodes ?? [0]
  if (outcome.signal !== null || outcome.exitCode === null || !allowed.includes(outcome.exitCode)) {
    ctx.logger.warn(
      `dsh-pi-review: Git snapshot command failed; ${String(Buffer.byteLength(stderr, 'utf8'))} bounded diagnostic byte(s) suppressed`,
    )
    throw new GitSnapshotError(
      `Git command failed${outcome.signal === null ? ` with exit ${String(outcome.exitCode)}` : ` with signal ${outcome.signal}`}`,
    )
  }
  return { stdout, outcome }
}

/** Reject pathspecs that could escape or ambiguously normalize the repository. */
export function validateReviewPath(value: string): string {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    throw new GitSnapshotError('Review paths must be non-empty and no longer than 4096 UTF-8 bytes', 'PI_REVIEW_INVALID_PATH')
  }
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\')) {
    throw new GitSnapshotError('Review paths must be repository-relative', 'PI_REVIEW_INVALID_PATH')
  }
  if (value.includes('\\') || /[\0-\x1f\x7f]/.test(value)) {
    throw new GitSnapshotError('Review paths must not contain backslashes or control characters', 'PI_REVIEW_INVALID_PATH')
  }
  const parts = value.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) {
    throw new GitSnapshotError('Review paths must not contain empty, dot, or parent segments', 'PI_REVIEW_INVALID_PATH')
  }
  return value
}

/** Reject revision expressions and option-like input; only ordinary refs/OIDs are accepted. */
export function validateBaseRef(value: string): string {
  if (value.length === 0 || value.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.includes('..') || value.includes('//')
    || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) {
    throw new GitSnapshotError(
      'base_ref must be an ordinary Git ref name or object id, not a revision expression',
      'PI_REVIEW_INVALID_BASE_REF',
    )
  }
  return value
}

/** Apply the same strict ref grammar to branch heads and commit selectors. */
function validateReviewRef(value: string, field: 'head_ref' | 'commit_ref'): string {
  try {
    return validateBaseRef(value)
  } catch (error: unknown) {
    if (error instanceof GitSnapshotError) {
      throw new GitSnapshotError(
        `${field} must be an ordinary Git ref name or object id, not a revision expression`,
        'PI_REVIEW_INVALID_REF',
        { cause: error },
      )
    }
    throw error
  }
}

/** Enforce the exact closed request surface even though defineTool's implicit root is open. */
export function normalizeSnapshotRequest(value: Record<string, unknown>): GitSnapshotRequest {
  const allowed = new Set(['scope', 'base_ref', 'head_ref', 'commit_ref', 'paths'])
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new GitSnapshotError('pi_review_diff received unsupported arguments', 'PI_REVIEW_INVALID_ARGS')
  }
  const scope = value['scope']
  if (scope !== 'unstaged' && scope !== 'staged' && scope !== 'working-tree'
    && scope !== 'base' && scope !== 'branch' && scope !== 'commit') {
    throw new GitSnapshotError('scope is invalid', 'PI_REVIEW_INVALID_ARGS')
  }
  const suppliedBase = value['base_ref']
  const suppliedHead = value['head_ref']
  const suppliedCommit = value['commit_ref']
  if (scope === 'base' || scope === 'branch') {
    if (typeof suppliedBase !== 'string') {
      throw new GitSnapshotError(`base_ref is required when scope is ${scope}`, 'PI_REVIEW_INVALID_ARGS')
    }
  } else if (suppliedBase !== undefined) {
    throw new GitSnapshotError('base_ref is valid only when scope is base or branch', 'PI_REVIEW_INVALID_ARGS')
  }
  if (scope !== 'branch' && suppliedHead !== undefined) {
    throw new GitSnapshotError('head_ref is valid only when scope is branch', 'PI_REVIEW_INVALID_ARGS')
  }
  if (scope !== 'commit' && suppliedCommit !== undefined) {
    throw new GitSnapshotError('commit_ref is valid only when scope is commit', 'PI_REVIEW_INVALID_ARGS')
  }
  const baseRef = typeof suppliedBase === 'string' ? validateBaseRef(suppliedBase) : undefined
  if (suppliedHead !== undefined && typeof suppliedHead !== 'string') {
    throw new GitSnapshotError('head_ref must be a string when provided', 'PI_REVIEW_INVALID_ARGS')
  }
  if (suppliedCommit !== undefined && typeof suppliedCommit !== 'string') {
    throw new GitSnapshotError('commit_ref must be a string when provided', 'PI_REVIEW_INVALID_ARGS')
  }
  const headRef = scope === 'branch'
    ? validateReviewRef(typeof suppliedHead === 'string' ? suppliedHead : 'HEAD', 'head_ref')
    : undefined
  const commitRef = scope === 'commit'
    ? validateReviewRef(typeof suppliedCommit === 'string' ? suppliedCommit : 'HEAD', 'commit_ref')
    : undefined
  const suppliedPaths = value['paths']
  if (suppliedPaths !== undefined && (!Array.isArray(suppliedPaths) || suppliedPaths.length === 0)) {
    throw new GitSnapshotError('paths must be a non-empty array when provided', 'PI_REVIEW_INVALID_ARGS')
  }
  let paths: string[] | undefined
  if (Array.isArray(suppliedPaths)) {
    const normalized = suppliedPaths.map((item) => {
      if (typeof item !== 'string') {
        throw new GitSnapshotError('every review path must be a string', 'PI_REVIEW_INVALID_ARGS')
      }
      return validateReviewPath(item)
    })
    paths = [...new Set(normalized)]
  }
  return {
    scope,
    ...(baseRef === undefined ? {} : { baseRef }),
    ...(headRef === undefined ? {} : { headRef }),
    ...(commitRef === undefined ? {} : { commitRef }),
    ...(paths === undefined ? {} : { paths }),
  }
}

function nulFields(text: string, label: string): string[] {
  if (text.length === 0) return []
  if (!text.endsWith('\0')) {
    throw new GitSnapshotError(`Git ${label} output was not NUL-terminated`)
  }
  return text.slice(0, -1).split('\0')
}

/** Parse `git diff --name-status -z`, including rename/copy two-path records. */
export function parseNameStatusZ(text: string): ChangedPath[] {
  const fields = nulFields(text, 'name-status')
  const changes: ChangedPath[] = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    if (status === undefined || !/^[A-Z][0-9]*$/.test(status)) {
      throw new GitSnapshotError('Git name-status output contained an invalid status')
    }
    const first = fields[index++]
    if (first === undefined) throw new GitSnapshotError('Git name-status output ended unexpectedly')
    if (status.startsWith('R') || status.startsWith('C')) {
      const next = fields[index++]
      if (next === undefined) throw new GitSnapshotError('Git rename/copy output ended unexpectedly')
      changes.push({ status, oldPath: validateReviewPath(first), path: validateReviewPath(next) })
    } else {
      changes.push({ status, path: validateReviewPath(first) })
    }
  }
  return changes
}

/** Parse binary paths from `git diff --numstat -z`, including rename records. */
export function parseBinaryPathsZ(text: string): Set<string> {
  const fields = nulFields(text, 'numstat')
  const binary = new Set<string>()
  for (let index = 0; index < fields.length;) {
    const record = fields[index++]
    if (record === undefined) break
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) {
      throw new GitSnapshotError('Git numstat output contained an invalid record')
    }
    const added = record.slice(0, firstTab)
    const deleted = record.slice(firstTab + 1, secondTab)
    const path = record.slice(secondTab + 1)
    const isBinary = added === '-' && deleted === '-'
    if (path.length > 0) {
      const normalized = validateReviewPath(path)
      if (isBinary) binary.add(normalized)
      continue
    }
    const oldPath = fields[index++]
    const newPath = fields[index++]
    if (oldPath === undefined || newPath === undefined) {
      throw new GitSnapshotError('Git rename numstat output ended unexpectedly')
    }
    validateReviewPath(oldPath)
    const normalized = validateReviewPath(newPath)
    if (isBinary) binary.add(normalized)
  }
  return binary
}

export interface RawPatchEnvelope {
  readonly changedPaths: readonly ChangedPath[]
  readonly patch: string
}

function nulFieldAt(text: string, offset: number, label: string): { value: string, next: number } {
  const end = text.indexOf('\0', offset)
  if (end < 0) throw new GitSnapshotError(`Git ${label} output ended before a NUL delimiter`)
  return { value: text.slice(offset, end), next: end + 1 }
}

/**
 * Split one `git diff --raw -z --patch` invocation. Raw records are fully
 * NUL-delimited (including two paths for rename/copy), followed by Git's extra
 * empty NUL field and then the exact patch bytes represented as UTF-8 text.
 */
export function parseRawPatchEnvelope(text: string): RawPatchEnvelope {
  if (text.length === 0) return { changedPaths: [], patch: '' }
  const changedPaths: ChangedPath[] = []
  let offset = 0
  while (text[offset] === ':') {
    const header = nulFieldAt(text, offset, 'raw patch metadata')
    offset = header.next
    const match = /^:[0-7]{6} [0-7]{6} [0-9a-f]{4,64} [0-9a-f]{4,64} ([A-Z][0-9]*)$/.exec(header.value)
    if (match?.[1] === undefined) {
      throw new GitSnapshotError('Git raw patch metadata contained an invalid header')
    }
    const status = match[1]
    const first = nulFieldAt(text, offset, 'raw patch path')
    offset = first.next
    if (status.startsWith('R') || status.startsWith('C')) {
      const next = nulFieldAt(text, offset, 'raw rename/copy path')
      offset = next.next
      changedPaths.push({
        status,
        oldPath: validateReviewPath(first.value),
        path: validateReviewPath(next.value),
      })
    } else {
      changedPaths.push({ status, path: validateReviewPath(first.value) })
    }
  }
  if (changedPaths.length === 0 || text[offset] !== '\0') {
    throw new GitSnapshotError('Git raw metadata and patch did not have a unique NUL boundary')
  }
  const patch = text.slice(offset + 1)
  if (patch.length === 0 || patch.includes('\0')) {
    throw new GitSnapshotError('Git raw metadata was not followed by one complete text-safe patch')
  }
  return { changedPaths, patch }
}

function sameTrackedChanges(
  expected: readonly ChangedPath[],
  actual: readonly ChangedPath[],
): boolean {
  return expected.length === actual.length && expected.every((change, index) => {
    const candidate = actual[index]
    return candidate !== undefined
      && candidate.status === change.status
      && candidate.path === change.path
      && candidate.oldPath === change.oldPath
  })
}

function frozenContentPaths(changes: readonly ChangedPath[]): string[] {
  const paths = new Set<string>()
  for (const change of changes) {
    if (change.oldPath !== undefined) paths.add(change.oldPath)
    paths.add(change.path)
  }
  return [...paths]
}

function diffModeArgs(scope: ReviewScope, base: string | undefined, head: string): string[] {
  switch (scope) {
    case 'unstaged': return []
    case 'staged': return ['--cached', head]
    case 'working-tree': return [head]
    case 'base': {
      if (base === undefined) throw new GitSnapshotError('Resolved base commit is missing')
      return [base]
    }
    case 'branch':
    case 'commit': {
      if (base === undefined) throw new GitSnapshotError('Resolved historical comparison commit is missing')
      return [base, head]
    }
  }
}

function withPaths(args: readonly string[], paths: readonly string[] | undefined): string[] {
  return [...args, '--', ...(paths ?? [])]
}

function assertObjectId(value: string, label: string): string {
  const normalized = value.trim()
  if (!/^[0-9a-f]{40,64}$/.test(normalized)) {
    throw new GitSnapshotError(`Git returned an invalid ${label} object id`)
  }
  return normalized
}

async function resolveCommitRef(
  ctx: Context,
  git: string,
  repoRoot: string,
  ref: string,
  label: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  tracker: ProcessTracker | undefined,
): Promise<string> {
  const result = await runGit(
    ctx,
    git,
    repoRoot,
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    config,
    signal,
    tracker,
    { stdoutMaxBytes: 256 },
  )
  return assertObjectId(result.stdout, label)
}

async function resolveUniqueMergeBase(
  ctx: Context,
  git: string,
  repoRoot: string,
  base: string,
  head: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  tracker: ProcessTracker | undefined,
): Promise<string> {
  const result = await runGit(
    ctx,
    git,
    repoRoot,
    ['merge-base', '--all', base, head],
    config,
    signal,
    tracker,
    { stdoutMaxBytes: 16_384, allowedExitCodes: [0, 1] },
  )
  if (result.outcome.exitCode === 1 || result.stdout.length === 0) {
    throw new GitSnapshotError(
      'The selected branch refs do not have one common merge base',
      'PI_REVIEW_MERGE_BASE_UNAVAILABLE',
    )
  }
  if (!result.stdout.endsWith('\n')) {
    throw new GitSnapshotError('Git merge-base output was not newline-terminated')
  }
  const candidates = result.stdout.slice(0, -1).split('\n')
  if (candidates.length !== 1) {
    throw new GitSnapshotError(
      'The selected branch refs have multiple best merge bases',
      'PI_REVIEW_AMBIGUOUS_MERGE_BASE',
    )
  }
  return assertObjectId(candidates[0] ?? '', 'merge base')
}

async function resolveSingleCommitParent(
  ctx: Context,
  git: string,
  repoRoot: string,
  commit: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  tracker: ProcessTracker | undefined,
): Promise<string> {
  const firstParent = await runGit(
    ctx,
    git,
    repoRoot,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^1^{commit}`],
    config,
    signal,
    tracker,
    { stdoutMaxBytes: 256, allowedExitCodes: [0, 1] },
  )
  if (firstParent.outcome.exitCode === 1) {
    if (firstParent.stdout.length !== 0) {
      throw new GitSnapshotError('Git returned invalid commit-parent metadata')
    }
    throw new GitSnapshotError(
      'Commit review supports only commits with exactly one parent',
      'PI_REVIEW_UNSUPPORTED_COMMIT_SHAPE',
    )
  }
  const parent = assertObjectId(firstParent.stdout, 'commit parent')
  const secondParent = await runGit(
    ctx,
    git,
    repoRoot,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^2^{commit}`],
    config,
    signal,
    tracker,
    { stdoutMaxBytes: 256, allowedExitCodes: [0, 1] },
  )
  if (secondParent.outcome.exitCode === 0) {
    assertObjectId(secondParent.stdout, 'second commit parent')
    throw new GitSnapshotError(
      'Commit review supports only commits with exactly one parent',
      'PI_REVIEW_UNSUPPORTED_COMMIT_SHAPE',
    )
  }
  if (secondParent.stdout.length !== 0) {
    throw new GitSnapshotError('Git returned invalid commit-parent metadata')
  }
  return parent
}

function assertDiffBudget(diff: string, maximum: number): void {
  if (Buffer.byteLength(diff, 'utf8') > maximum) {
    throw new GitSnapshotError(
      `Review diff exceeds the configured ${String(maximum)}-byte limit`,
      'PI_REVIEW_SNAPSHOT_TOO_LARGE',
    )
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Capture the exact single-link regular file that a live-worktree diff may read. */
async function captureLiveWorktreeFile(
  repoRoot: string,
  path: string,
  unsafeCode: 'PI_REVIEW_UNSAFE_WORKTREE_PATH' | 'PI_REVIEW_UNSAFE_UNTRACKED_PATH',
): Promise<LiveWorktreeMetadata> {
  let stats: BigIntStats
  try {
    stats = await lstat(join(repoRoot, path), { bigint: true })
  } catch (error: unknown) {
    if (isMissing(error)) {
      throw new GitSnapshotError(
        'A live review path disappeared before its content could be captured',
        'PI_REVIEW_SNAPSHOT_RACED',
      )
    }
    throw new GitSnapshotError(
      'Unable to inspect a live review path before capturing its content',
      'PI_REVIEW_GIT_FAILED',
      { cause: error },
    )
  }
  if (!stats.isFile() || stats.nlink !== 1n) {
    throw new GitSnapshotError(
      'Every live review path must be a single-link regular file',
      unsafeCode,
    )
  }
  return {
    path,
    device: stats.dev,
    inode: stats.ino,
    links: stats.nlink,
    size: stats.size,
    mode: stats.mode,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  }
}

/** Recheck all identity and content-relevant stat fields after Git read the file. */
async function verifyLiveWorktreeFile(
  repoRoot: string,
  before: LiveWorktreeMetadata,
): Promise<LiveWorktreeMetadata> {
  let after: BigIntStats
  try {
    after = await lstat(join(repoRoot, before.path), { bigint: true })
  } catch (error: unknown) {
    if (isMissing(error)) {
      throw new GitSnapshotError(
        'A live review path disappeared while its content was captured',
        'PI_REVIEW_SNAPSHOT_RACED',
      )
    }
    throw new GitSnapshotError(
      'Unable to recheck a live review path after capturing its content',
      'PI_REVIEW_GIT_FAILED',
      { cause: error },
    )
  }
  if (!after.isFile()
    || after.dev !== before.device
    || after.ino !== before.inode
    || after.nlink !== before.links
    || after.nlink !== 1n
    || after.size !== before.size
    || after.mode !== before.mode
    || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs) {
    throw new GitSnapshotError(
      'A live review path changed while its content was captured',
      'PI_REVIEW_SNAPSHOT_RACED',
    )
  }
  return {
    path: before.path,
    device: after.dev,
    inode: after.ino,
    links: after.nlink,
    size: after.size,
    mode: after.mode,
    mtimeNs: after.mtimeNs,
    ctimeNs: after.ctimeNs,
  }
}

/** A frozen deletion/rename source must not reappear as live diff input. */
async function assertLivePathMissing(repoRoot: string, path: string): Promise<void> {
  try {
    await lstat(join(repoRoot, path))
  } catch (error: unknown) {
    if (isMissing(error)) return
    throw new GitSnapshotError(
      'Unable to verify that a deleted-side review path remains absent',
      'PI_REVIEW_GIT_FAILED',
      { cause: error },
    )
  }
  throw new GitSnapshotError(
    'A deleted-side review path reappeared while its patch was captured',
    'PI_REVIEW_SNAPSHOT_RACED',
  )
}

async function captureWorktreeDirectory(
  absolutePath: string,
  allowMissing: boolean,
): Promise<WorktreeDirectoryMetadata | undefined> {
  let stats: BigIntStats
  try {
    stats = await lstat(absolutePath, { bigint: true })
  } catch (error: unknown) {
    if (allowMissing && isMissing(error)) return undefined
    throw new GitSnapshotError(
      'Unable to inspect a worktree directory before capturing content',
      'PI_REVIEW_GIT_FAILED',
      { cause: error },
    )
  }
  if (!stats.isDirectory()) {
    throw new GitSnapshotError(
      'Every live review path must have only real worktree directories as ancestors',
      'PI_REVIEW_UNSAFE_WORKTREE_PATH',
    )
  }
  return {
    absolutePath,
    device: stats.dev,
    inode: stats.ino,
    links: stats.nlink,
    size: stats.size,
    mode: stats.mode,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  }
}

async function verifyWorktreeDirectory(before: WorktreeDirectoryMetadata): Promise<void> {
  let after: BigIntStats
  try {
    after = await lstat(before.absolutePath, { bigint: true })
  } catch (error: unknown) {
    throw new GitSnapshotError(
      'A worktree directory disappeared while review content was captured',
      'PI_REVIEW_SNAPSHOT_RACED',
      { cause: error },
    )
  }
  if (!after.isDirectory()
    || after.dev !== before.device
    || after.ino !== before.inode
    || after.nlink !== before.links
    || after.size !== before.size
    || after.mode !== before.mode
    || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs) {
    throw new GitSnapshotError(
      'A worktree directory changed while review content was captured',
      'PI_REVIEW_SNAPSHOT_RACED',
    )
  }
}

function worktreeAncestorDirectories(repoRoot: string, path: string): string[] {
  const directories = [repoRoot]
  let current = repoRoot
  for (const segment of path.split('/').slice(0, -1)) {
    current = join(current, segment)
    if (!isInside(repoRoot, current)) {
      throw new GitSnapshotError('A review path escaped while its directory boundary was frozen')
    }
    directories.push(current)
  }
  return directories
}

/** Reject Git object-store indirection without reading or following its target. */
async function assertStandaloneGitDirectory(markerPath: string): Promise<void> {
  const indirectionMarkers = [
    join(markerPath, 'commondir'),
    join(markerPath, 'objects', 'info', 'alternates'),
  ]
  for (const candidate of indirectionMarkers) {
    try {
      await lstat(candidate)
      throw new GitSnapshotError(
        'Shared or alternate Git object storage is unsupported for Pi review',
        'PI_REVIEW_GIT_STORAGE_INDIRECTION_UNSUPPORTED',
      )
    } catch (error: unknown) {
      if (error instanceof GitSnapshotError) throw error
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new GitSnapshotError(
          'Unable to verify that the repository uses standalone Git object storage',
          'PI_REVIEW_GIT_BOUNDARY_UNSAFE',
          { cause: error },
        )
      }
    }
  }
}

/**
 * Discover a worktree root without honoring ambient Git or local core.worktree
 * overrides. Version 0.1 deliberately supports only repositories whose `.git`
 * marker is a physical directory beneath the repository root. In particular,
 * linked worktrees and arbitrary `gitdir:` indirection files fail closed before
 * any Git command can inspect or diff the referenced repository.
 */
async function findRepositoryRoot(canonicalCwd: string): Promise<string> {
  let current = canonicalCwd
  for (;;) {
    const markerPath = join(current, '.git')
    let marker: Awaited<ReturnType<typeof lstat>>
    try {
      marker = await lstat(markerPath)
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new GitSnapshotError('Unable to inspect the repository boundary', 'PI_REVIEW_GIT_FAILED', { cause: error })
      }
      const parent = dirname(current)
      if (parent === current) {
        throw new GitSnapshotError('The owner session workspace is not inside a Git worktree', 'PI_REVIEW_WORKSPACE_REQUIRED')
      }
      current = parent
      continue
    }

    if (marker.isFile()) {
      throw new GitSnapshotError(
        'Linked worktrees and .git indirection files are unsupported for Pi review',
        'PI_REVIEW_LINKED_WORKTREE_UNSUPPORTED',
      )
    }
    if (!marker.isDirectory()) {
      throw new GitSnapshotError(
        'The repository .git marker must be a real directory inside the repository root',
        'PI_REVIEW_GIT_BOUNDARY_UNSAFE',
      )
    }
    try {
      const canonicalMarker = await realpath(markerPath)
      const verifiedMarker = await lstat(markerPath)
      if (!verifiedMarker.isDirectory()
        || verifiedMarker.dev !== marker.dev
        || verifiedMarker.ino !== marker.ino
        || !isInside(current, canonicalMarker)) {
        throw new GitSnapshotError(
          'The repository .git directory changed or escaped its repository boundary',
          'PI_REVIEW_GIT_BOUNDARY_UNSAFE',
        )
      }
      await assertStandaloneGitDirectory(markerPath)
      return current
    } catch (error: unknown) {
      if (error instanceof GitSnapshotError) throw error
      throw new GitSnapshotError(
        'The repository .git directory changed while its boundary was verified',
        'PI_REVIEW_GIT_BOUNDARY_UNSAFE',
        { cause: error },
      )
    }
  }
}

/** Capture one immutable review input, rejecting rather than silently truncating it. */
export async function captureGitSnapshot(
  ctx: Context,
  cwd: string,
  request: GitSnapshotRequest,
  config: ResolvedConfig,
  signal: AbortSignal,
  tracker?: ProcessTracker,
): Promise<GitSnapshot> {
  if (!isAbsolute(cwd)) {
    throw new GitSnapshotError('The owner session workspace must be absolute', 'PI_REVIEW_WORKSPACE_REQUIRED')
  }
  if (request.paths !== undefined && request.paths.length > config.maxFiles) {
    throw new GitSnapshotError(
      `Requested paths exceed the configured ${String(config.maxFiles)}-file limit`,
      'PI_REVIEW_TOO_MANY_FILES',
    )
  }
  const paths = request.paths?.map(validateReviewPath)
  const canonicalCwd = await realpath(cwd)
  const repoRoot = await findRepositoryRoot(canonicalCwd)
  if (!isInside(repoRoot, canonicalCwd)) {
    throw new GitSnapshotError('The owner session workspace is outside the resolved repository root')
  }
  const git = await ctx.subprocess.resolveExecutable('git', undefined, signal)

  let workspaceHead: string | undefined
  if (request.scope !== 'branch' && request.scope !== 'commit') {
    const headRun = await runGit(
      ctx, git, repoRoot,
      ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
      config, signal, tracker, { stdoutMaxBytes: 256 },
    )
    workspaceHead = assertObjectId(headRun.stdout, 'HEAD')
  }
  const filterRun = await runGit(
    ctx, git, repoRoot,
    ['config', '--includes', '--get-regexp', '^filter\\..*\\.(clean|process|smudge|required)$'],
    config, signal, tracker, { stdoutMaxBytes: boundedMetadataCap(config.maxFiles), allowedExitCodes: [0, 1] },
  )
  if (filterRun.stdout.trim().length > 0) {
    throw new GitSnapshotError(
      'Repository Git filter commands are unsupported because they can execute outside the review sandbox',
      'PI_REVIEW_GIT_FILTER_UNSAFE',
    )
  }
  if (request.scope !== 'branch' && request.headRef !== undefined) {
    throw new GitSnapshotError('head_ref is valid only for branch scope', 'PI_REVIEW_INVALID_ARGS')
  }
  if (request.scope !== 'commit' && request.commitRef !== undefined) {
    throw new GitSnapshotError('commit_ref is valid only for commit scope', 'PI_REVIEW_INVALID_ARGS')
  }

  let head = workspaceHead
  let base: string | undefined
  let baseScopeRef: string | undefined
  let baseScopeTip: string | undefined
  let branchBaseRef: string | undefined
  let branchHeadRef: string | undefined
  let branchBaseTip: string | undefined
  let branchHeadTip: string | undefined
  let commitRef: string | undefined
  let commitTip: string | undefined
  if (request.scope === 'base') {
    if (request.baseRef === undefined) throw new GitSnapshotError('base_ref is required for base scope', 'PI_REVIEW_INVALID_ARGS')
    baseScopeRef = validateBaseRef(request.baseRef)
    baseScopeTip = await resolveCommitRef(
      ctx, git, repoRoot, baseScopeRef, 'base', config, signal, tracker,
    )
    base = baseScopeTip
  } else if (request.scope === 'branch') {
    if (request.baseRef === undefined) throw new GitSnapshotError('base_ref is required for branch scope', 'PI_REVIEW_INVALID_ARGS')
    branchBaseRef = validateBaseRef(request.baseRef)
    branchHeadRef = validateReviewRef(request.headRef ?? 'HEAD', 'head_ref')
    branchBaseTip = await resolveCommitRef(
      ctx, git, repoRoot, branchBaseRef, 'branch base', config, signal, tracker,
    )
    branchHeadTip = await resolveCommitRef(
      ctx, git, repoRoot, branchHeadRef, 'branch head', config, signal, tracker,
    )
    base = await resolveUniqueMergeBase(
      ctx, git, repoRoot, branchBaseTip, branchHeadTip, config, signal, tracker,
    )
    head = branchHeadTip
  } else if (request.scope === 'commit') {
    if (request.baseRef !== undefined) {
      throw new GitSnapshotError('base_ref is invalid for commit scope', 'PI_REVIEW_INVALID_ARGS')
    }
    commitRef = validateReviewRef(request.commitRef ?? 'HEAD', 'commit_ref')
    commitTip = await resolveCommitRef(ctx, git, repoRoot, commitRef, 'review commit', config, signal, tracker)
    base = await resolveSingleCommitParent(ctx, git, repoRoot, commitTip, config, signal, tracker)
    head = commitTip
  } else if (request.baseRef !== undefined) {
    throw new GitSnapshotError('base_ref is valid only for base or branch scope', 'PI_REVIEW_INVALID_ARGS')
  }
  if (head === undefined) {
    throw new GitSnapshotError('Resolved review head is missing')
  }

  const mode = diffModeArgs(request.scope, base, head)
  const metadataCap = boundedMetadataCap(config.maxFiles)
  const nameRun = await runGit(
    ctx, git, repoRoot,
    withPaths(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z', ...mode], paths),
    config, signal, tracker, { stdoutMaxBytes: metadataCap },
  )
  let changedPaths = parseNameStatusZ(nameRun.stdout)
  const numstatRun = await runGit(
    ctx, git, repoRoot,
    withPaths(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--numstat', '-z', ...mode], paths),
    config, signal, tracker, { stdoutMaxBytes: metadataCap },
  )
  const binaryPaths = parseBinaryPathsZ(numstatRun.stdout)
  changedPaths = changedPaths.map(change =>
    binaryPaths.has(change.path) ? { ...change, binary: true } : change)
  const frozenTrackedChanges = changedPaths

  const usesLiveWorktree = request.scope !== 'staged'
    && request.scope !== 'branch'
    && request.scope !== 'commit'
  const includeUntracked = usesLiveWorktree
  let untracked: string[] = []
  if (includeUntracked) {
    const untrackedRun = await runGit(
      ctx, git, repoRoot,
      withPaths(['ls-files', '--others', '--exclude-standard', '-z'], paths),
      config, signal, tracker, { stdoutMaxBytes: metadataCap },
    )
    untracked = nulFields(untrackedRun.stdout, 'untracked paths').map(validateReviewPath)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  }

  const uniquePaths = new Set(changedPaths.map(change => change.path))
  for (const path of untracked) uniquePaths.add(path)
  if (uniquePaths.size > config.maxFiles) {
    throw new GitSnapshotError(
      `Review contains ${String(uniquePaths.size)} changed files, above the configured ${String(config.maxFiles)}-file limit`,
      'PI_REVIEW_TOO_MANY_FILES',
    )
  }

  // Index- and object-backed snapshots never map live files into the Worker.
  // Live scopes can expose current worktree content through the patch or scoped
  // reads, so reject hardlink aliases before `--binary`.
  const trackedLiveFiles = new Map<string, LiveWorktreeMetadata>()
  const untrackedLiveFiles = new Map<string, LiveWorktreeMetadata>()
  const missingLivePaths = new Set<string>()
  const guardedDirectories = new Map<string, WorktreeDirectoryMetadata>()
  const directoriesByPath = new Map<string, readonly WorktreeDirectoryMetadata[]>()
  if (usesLiveWorktree) {
    for (const change of changedPaths) {
      if (change.status.startsWith('D')) {
        missingLivePaths.add(change.path)
      } else if (!trackedLiveFiles.has(change.path)) {
        trackedLiveFiles.set(change.path, await captureLiveWorktreeFile(
          repoRoot, change.path, 'PI_REVIEW_UNSAFE_WORKTREE_PATH',
        ))
      }
      if (change.oldPath !== undefined) {
        if (change.status.startsWith('R')) {
          missingLivePaths.add(change.oldPath)
        } else if (change.status.startsWith('C') && !trackedLiveFiles.has(change.oldPath)) {
          trackedLiveFiles.set(change.oldPath, await captureLiveWorktreeFile(
            repoRoot, change.oldPath, 'PI_REVIEW_UNSAFE_WORKTREE_PATH',
          ))
        }
      }
    }
    for (const path of untracked) {
      untrackedLiveFiles.set(path, await captureLiveWorktreeFile(
        repoRoot,
        path,
        'PI_REVIEW_UNSAFE_UNTRACKED_PATH',
      ))
    }
    const freezeDirectories = async (path: string, allowMissing: boolean): Promise<void> => {
      const captured: WorktreeDirectoryMetadata[] = []
      for (const absolutePath of worktreeAncestorDirectories(repoRoot, path)) {
        let directory = guardedDirectories.get(absolutePath)
        if (directory === undefined) {
          directory = await captureWorktreeDirectory(absolutePath, allowMissing)
          if (directory === undefined) break
          guardedDirectories.set(absolutePath, directory)
        }
        captured.push(directory)
      }
      directoriesByPath.set(path, captured)
    }
    for (const path of trackedLiveFiles.keys()) await freezeDirectories(path, false)
    for (const path of untrackedLiveFiles.keys()) await freezeDirectories(path, false)
    for (const path of missingLivePaths) await freezeDirectories(path, true)
    for (const directory of guardedDirectories.values()) await verifyWorktreeDirectory(directory)
    for (const file of trackedLiveFiles.values()) await verifyLiveWorktreeFile(repoRoot, file)
    for (const file of untrackedLiveFiles.values()) await verifyLiveWorktreeFile(repoRoot, file)
    for (const path of missingLivePaths) await assertLivePathMissing(repoRoot, path)
  }

  let diff = ''
  if (frozenTrackedChanges.length > 0) {
    const diffRun = await runGit(
      ctx, git, repoRoot,
      withPaths([
        'diff', '--no-ext-diff', '--no-textconv', '--raw', '-z', '--patch', '--binary',
        '--full-index', '--abbrev=64', '--no-color', '--find-renames', ...mode,
      ], frozenContentPaths(frozenTrackedChanges)),
      config, signal, tracker,
      { stdoutMaxBytes: config.maxDiffBytes + metadataCap + 1 },
    )
    for (const directory of guardedDirectories.values()) await verifyWorktreeDirectory(directory)
    for (const path of missingLivePaths) await assertLivePathMissing(repoRoot, path)
    const envelope = parseRawPatchEnvelope(diffRun.stdout)
    if (!sameTrackedChanges(frozenTrackedChanges, envelope.changedPaths)) {
      throw new GitSnapshotError(
        'The content patch changed from its frozen tracked-path metadata',
        'PI_REVIEW_SNAPSHOT_RACED',
      )
    }
    diff = envelope.patch
    assertDiffBudget(diff, config.maxDiffBytes)
    for (const file of trackedLiveFiles.values()) await verifyLiveWorktreeFile(repoRoot, file)
  }

  const untrackedMetadata: UntrackedMetadata[] = []
  for (const path of untracked) {
    const before = untrackedLiveFiles.get(path)
    if (before === undefined) throw new GitSnapshotError('Untracked live-file metadata is missing')
    for (const directory of directoriesByPath.get(path) ?? []) {
      await verifyWorktreeDirectory(directory)
    }
    await verifyLiveWorktreeFile(repoRoot, before)
    const remaining = config.maxDiffBytes - Buffer.byteLength(diff, 'utf8')
    if (remaining < 1) assertDiffBudget(`${diff}x`, config.maxDiffBytes)
    const untrackedDiff = await runGit(
      ctx, git, repoRoot,
      ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-color', '--', ZERO_DEVICE, path],
      config, signal, tracker, { stdoutMaxBytes: remaining, allowedExitCodes: [0, 1] },
    )
    diff += untrackedDiff.stdout
    assertDiffBudget(diff, config.maxDiffBytes)
    for (const directory of directoriesByPath.get(path) ?? []) {
      await verifyWorktreeDirectory(directory)
    }
    const after = await verifyLiveWorktreeFile(repoRoot, before)
    if (after.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GitSnapshotError(
        'An untracked review file is too large to represent safely',
        'PI_REVIEW_SNAPSHOT_TOO_LARGE',
      )
    }
    untrackedMetadata.push({
      path,
      size: Number(after.size),
      mode: (after.mode & 0o7777n).toString(8).padStart(4, '0'),
      binary: untrackedDiff.stdout.includes('GIT binary patch') || untrackedDiff.stdout.includes('Binary files '),
    })
  }

  if (untrackedMetadata.length > 0) {
    const manifest = '\n# dsh-pi-review untracked metadata (JSONL; content is included above)\n'
      + untrackedMetadata.map(item => `# ${JSON.stringify(item)}\n`).join('')
    diff += manifest
    assertDiffBudget(diff, config.maxDiffBytes)
    changedPaths = [
      ...changedPaths,
      ...untrackedMetadata.map(item => ({
        status: '??',
        path: item.path,
        untracked: true as const,
        ...(item.binary ? { binary: true as const } : {}),
      })),
    ]
  }

  if ((changedPaths.length === 0) !== (diff.length === 0)) {
    throw new GitSnapshotError(
      'Git change metadata and patch content changed while the snapshot was being captured',
      'PI_REVIEW_SNAPSHOT_RACED',
    )
  }

  // Cover the whole acquisition window, including later untracked patches.
  for (const file of trackedLiveFiles.values()) await verifyLiveWorktreeFile(repoRoot, file)
  for (const file of untrackedLiveFiles.values()) await verifyLiveWorktreeFile(repoRoot, file)
  for (const directory of guardedDirectories.values()) await verifyWorktreeDirectory(directory)
  for (const path of missingLivePaths) await assertLivePathMissing(repoRoot, path)

  // The raw envelope above already binds the accepted patch to its exact
  // frozen path/status list. This content-free re-enumeration has a separate
  // purpose: reject persistent changes that appeared outside that strict union.
  const finalNameRun = await runGit(
    ctx, git, repoRoot,
    withPaths(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z', ...mode], paths),
    config, signal, tracker, { stdoutMaxBytes: metadataCap },
  )
  if (!sameTrackedChanges(frozenTrackedChanges, parseNameStatusZ(finalNameRun.stdout))) {
    throw new GitSnapshotError(
      'The tracked change set changed while the review snapshot was captured',
      'PI_REVIEW_SNAPSHOT_RACED',
    )
  }
  if (includeUntracked) {
    const finalUntrackedRun = await runGit(
      ctx, git, repoRoot,
      withPaths(['ls-files', '--others', '--exclude-standard', '-z'], paths),
      config, signal, tracker, { stdoutMaxBytes: metadataCap },
    )
    const finalUntracked = nulFields(finalUntrackedRun.stdout, 'final untracked paths')
      .map(validateReviewPath)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    if (finalUntracked.length !== untracked.length
      || finalUntracked.some((path, index) => path !== untracked[index])) {
      throw new GitSnapshotError(
        'The untracked change set changed while the review snapshot was captured',
        'PI_REVIEW_SNAPSHOT_RACED',
      )
    }
  }

  if (request.scope === 'branch') {
    if (branchBaseRef === undefined || branchHeadRef === undefined
      || branchBaseTip === undefined || branchHeadTip === undefined) {
      throw new GitSnapshotError('Resolved branch review metadata is incomplete')
    }
    const finalBaseTip = await resolveCommitRef(
      ctx, git, repoRoot, branchBaseRef, 'final branch base', config, signal, tracker,
    )
    const finalHeadTip = await resolveCommitRef(
      ctx, git, repoRoot, branchHeadRef, 'final branch head', config, signal, tracker,
    )
    if (finalBaseTip !== branchBaseTip || finalHeadTip !== branchHeadTip) {
      throw new GitSnapshotError(
        'A branch review ref changed while the snapshot was being captured',
        'PI_REVIEW_SNAPSHOT_RACED',
      )
    }
  } else if (request.scope === 'commit') {
    if (commitRef === undefined || commitTip === undefined) {
      throw new GitSnapshotError('Resolved commit review metadata is incomplete')
    }
    const finalCommitTip = await resolveCommitRef(
      ctx, git, repoRoot, commitRef, 'final review commit', config, signal, tracker,
    )
    if (finalCommitTip !== commitTip) {
      throw new GitSnapshotError(
        'The commit review ref changed while the snapshot was being captured',
        'PI_REVIEW_SNAPSHOT_RACED',
      )
    }
  } else {
    const finalHeadRun = await runGit(
      ctx, git, repoRoot,
      ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
      config, signal, tracker, { stdoutMaxBytes: 256 },
    )
    if (assertObjectId(finalHeadRun.stdout, 'HEAD') !== head) {
      throw new GitSnapshotError('Repository HEAD changed while the review snapshot was being captured', 'PI_REVIEW_SNAPSHOT_RACED')
    }
    if (request.scope === 'base') {
      if (baseScopeRef === undefined || baseScopeTip === undefined) {
        throw new GitSnapshotError('Resolved base review metadata is incomplete')
      }
      const finalBaseTip = await resolveCommitRef(
        ctx, git, repoRoot, baseScopeRef, 'final base', config, signal, tracker,
      )
      if (finalBaseTip !== baseScopeTip) {
        throw new GitSnapshotError(
          'The base review ref changed while the snapshot was being captured',
          'PI_REVIEW_SNAPSHOT_RACED',
        )
      }
    }
  }

  return {
    scope: request.scope,
    repoRoot,
    head,
    ...(base === undefined ? {} : { base }),
    diff,
    diffHash: createHash('sha256').update(diff, 'utf8').digest('hex'),
    changedPaths,
    omitted: [],
  }
}

/** Read-only Pi Agent review Bundle for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as PluginConfig } from './config.ts'
import { applyReviewHost } from './host.ts'

export const name = 'dsh-pi-review'
export const inject = ['agents', 'tools', 'subprocess', 'sandbox']
export { Config }

/** Install root-scoped review tools and their shared process lifecycle. */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  applyReviewHost(ctx, config)
}

export type {
  ChangedPath,
  GitSnapshot,
  ReviewConfidence,
  ReviewFinding,
  ReviewResult,
  ReviewScope,
  ReviewSeverity,
} from './types.ts'

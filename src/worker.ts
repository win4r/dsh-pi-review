#!/usr/bin/env node
/** One-request/one-envelope JSON process boundary for the Pi review Worker. */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import {
  parseWorkerEnvelope,
  parseWorkerRequest,
  ProtocolError,
} from './protocol.ts'
import { REVIEW_PROTOCOL_VERSION, type WorkerEnvelope } from './types.ts'
import { runWorkerRequest, type WorkerCoreDependencies } from './worker-core.ts'

/** Covers the strict protocol maxima while bounding a hostile stdin stream. */
export const MAX_WORKER_INPUT_BYTES = 96 * 1024 * 1024

function errorEnvelope(code: string, message: string): WorkerEnvelope {
  return {
    protocolVersion: REVIEW_PROTOCOL_VERSION,
    ok: false,
    error: { code, message: message.slice(0, 4_096) },
  }
}

function safeDiagnostic(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  return text
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\b(Bearer)\s+\S+/gi, '$1 [redacted]')
    .replace(/((?:api[_ -]?key|authorization|token)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_024)
}

/** Parse and execute one complete stdin document. Useful for deterministic tests. */
export async function processWorkerDocument(
  document: string,
  dependencies: WorkerCoreDependencies = {},
): Promise<WorkerEnvelope> {
  if (Buffer.byteLength(document, 'utf8') > MAX_WORKER_INPUT_BYTES) {
    return errorEnvelope('INPUT_TOO_LARGE', 'Worker request exceeds the process input limit')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(document) as unknown
  } catch {
    return errorEnvelope('INVALID_JSON', 'Worker stdin must contain exactly one JSON document')
  }

  try {
    const request = parseWorkerRequest(decoded)
    return parseWorkerEnvelope(await runWorkerRequest(request, dependencies))
  } catch (error) {
    if (error instanceof ProtocolError) {
      dependencies.diagnostic?.(`INVALID_REQUEST: ${safeDiagnostic(error)}`)
      return errorEnvelope('INVALID_REQUEST', error.message)
    }
    dependencies.diagnostic?.(`WORKER_FAILURE: ${safeDiagnostic(error)}`)
    return errorEnvelope('WORKER_FAILURE', 'Worker failed to produce a valid response')
  }
}

async function readBounded(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string)
    total += chunk.byteLength
    if (total > MAX_WORKER_INPUT_BYTES) {
      throw new ProtocolError('Worker request exceeds the process input limit')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

/** Execute the process protocol while writing exactly one stdout JSON envelope. */
export async function runWorkerProcess(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  diagnostics: Writable = process.stderr,
  dependencies: WorkerCoreDependencies = {},
): Promise<void> {
  const diagnostic = (message: string): void => {
    diagnostics.write(`${safeDiagnostic(message)}\n`)
    dependencies.diagnostic?.(message)
  }

  let envelope: WorkerEnvelope
  try {
    const document = await readBounded(input)
    envelope = await processWorkerDocument(document, { ...dependencies, diagnostic })
  } catch (error) {
    diagnostic(safeDiagnostic(error))
    envelope = error instanceof ProtocolError
      ? errorEnvelope('INPUT_TOO_LARGE', error.message)
      : errorEnvelope('INPUT_READ_FAILED', 'Unable to read Worker stdin')
  }

  // Validate our own output before crossing the process boundary.
  const serialized = JSON.stringify(parseWorkerEnvelope(envelope))
  output.write(`${serialized}\n`)
}

const entryPoint = process.argv[1] === undefined ? '' : pathToFileURL(resolve(process.argv[1])).href
if (import.meta.url === entryPoint) await runWorkerProcess()

/**
 * Mutation executor: turns a reviewed preview into real writes, tracks every
 * change independently, and makes retries SAFE.
 *
 * Three invariants drive the whole design:
 *
 *  1. **One write per character per attempt.** A character produces exactly ONE
 *     planned mutation carrying its complete intended final tag array, and that
 *     array — never a stale full-character snapshot — is what is sent. A write
 *     can therefore never clobber unrelated fields. The whole operation's
 *     writes travel in ONE `updateTagsBatch` call: a round trip per character
 *     is what exhausted the Termux/WebView host on a large bulk edit. A
 *     retry uses the same batched transports: ONE `getTagsBatch` to re-read
 *     current tags, ONE `updateTagsBatch` for whatever still needs writing.
 *
 *  2. **Never replay a stale snapshot.** A retry still re-reads before it
 *     writes — now in ONE batched `getTagsBatch` round trip for every failed
 *     character, followed by at most ONE batched `updateTagsBatch` — and
 *     recomputes each intended change against the CURRENT tags. A user edit
 *     made between attempts survives, and a write that actually landed before
 *     a timeout is detected instead of being applied twice.
 *
 *  3. **Progress emission is bounded, not per-character.** A `snapshot()`
 *     deep-clones every result, so emitting one per character made `execute()`
 *     allocate O(M^2) `MutationResult`s for M characters — hundreds of
 *     megabytes of transient garbage on a bulk merge, which OOM-killed the
 *     Termux WebView *after* the write had already landed. Emissions are
 *     therefore coalesced on a clock (and skipped entirely when no hook is
 *     supplied), so the cost is O(M) whatever M is.
 */

import type { CharacterMutationPort } from '../repository'
import type { CharacterTags } from '../../shared/types'
import type { BatchFailure } from '../../shared/protocol'
import { dedupeTagNames, tagKey } from '../tag-index'
import type { MutationOp, OperationPreview, PlannedMutation } from './planner'
import {
  computeTotals,
  deriveStatus,
  groupFailures,
  type ClassifiedError,
  type MutationResult,
  type OperationReport,
} from './report'

/**
 * @deprecated Retained for compatibility only; never consulted. A retry's write
 * path is ONE batched `updateTagsBatch` call, so there is nothing left to fan
 * out — and `execute()` was already one batched write.
 */
export const DEFAULT_WRITE_CONCURRENCY = 4

/**
 * Minimum wall-clock gap between two consecutive `onProgress` emissions.
 *
 * Every emission deep-clones the whole result list, so the emission count is
 * the single multiplier on `execute()`'s allocation cost. At 50ms a listener
 * sees ~20 updates per second — enough to animate a progress bar, and few
 * enough that the count tracks how long a merge takes rather than how many
 * characters it touches.
 */
export const PROGRESS_EMIT_INTERVAL_MS = 50

export interface ExecutorOptions {
  /**
   * RETAINED FOR COMPATIBILITY — accepted and ignored.
   *
   * @deprecated It once capped simultaneous character writes during a retry.
   * The retry path is now one batched `getTagsBatch` read plus one batched
   * `updateTagsBatch` write for the whole set of failures, so there is
   * nothing left to fan out and the value has no effect. `execute()` never
   * consulted it either. Existing call sites keep compiling; prefer omitting
   * it.
   */
  concurrency?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

export interface ExecuteHooks {
  onProgress?: (report: OperationReport) => void
  onResult?: (result: MutationResult) => void
}

const TIMEOUT_PATTERN = /timeout|timed out|network|fetch failed|aborted/i
const FORBIDDEN_PATTERN = /permission|forbidden|unauthorized|not granted/i
const NOT_FOUND_PATTERN = /not found|404|no such character|deleted/i

/**
 * Turn an arbitrary thrown value into a UI-safe, machine-classified error.
 *
 * Never surfaces a stack trace: only the human line is kept, stack-frame
 * syntax (`at fn (file:1:1)`) and `file:line:col` noise are stripped, and
 * non-Error throws (`throw 'boom'`, `throw 42`) are still described.
 *
 * Retryability comes from the KIND of failure, not the message:
 * - timeout / network → retryable AND **uncertain** (the write may have landed)
 * - permission / forbidden → never retryable
 * - not found / deleted → never retryable
 * - anything else → retryable
 */
export function classifyError(error: unknown): ClassifiedError {
  const rawCode = readStringField(error, 'code')
  const message = sanitizeMessage(extractRawMessage(error))
  const code = rawCode
  const haystack = code !== undefined ? `${code} ${message}` : message

  // Order matters: a specific non-retryable reason wins over a generic one.
  if (FORBIDDEN_PATTERN.test(haystack)) {
    return { message, code: code ?? 'forbidden', retryable: false, uncertain: false }
  }
  if (NOT_FOUND_PATTERN.test(haystack)) {
    return { message, code: code ?? 'not_found', retryable: false, uncertain: false }
  }
  if (TIMEOUT_PATTERN.test(haystack)) {
    // The server may have applied the write before the response was lost.
    return { message, code: code ?? 'timeout', retryable: true, uncertain: true }
  }
  return { message, code, retryable: true, uncertain: false }
}

function readStringField(error: unknown, field: 'code' | 'message'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as Record<string, unknown>)[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function extractRawMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  const fromField = readStringField(error, 'message')
  if (fromField !== undefined) return fromField
  if (error === null) return 'Unknown error'
  if (typeof error === 'number' || typeof error === 'boolean') return String(error)
  try {
    const json = JSON.stringify(error)
    if (typeof json === 'string' && json !== '' && json !== '{}') return json
  } catch {
    // Circular / exotic values fall through to the generic message below.
  }
  return 'Unknown error'
}

/** Keep the human part of a message and drop every trace of a stack. */
function sanitizeMessage(raw: string): string {
  let text = (raw ?? '').trim()
  if (text === '') return 'Unknown error'
  text = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s/.test(line))
    .join(' ')
    .replace(/\s+at\s+[^\s(]+(?:\s+\([^)]*\))?/g, '')
    .replace(/[\w./\\-]+:\d+:\d+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return text === '' ? 'Unknown error' : text
}

function hasTag(tags: readonly string[], tag: string): boolean {
  const key = tagKey(tag)
  return tags.some((t) => tagKey(t) === key)
}

/** True when the tag array already satisfies a mutation's intent. */
export function intentSatisfied(tags: readonly string[], m: PlannedMutation): boolean {
  for (const added of m.addedTags) if (!hasTag(tags, added)) return false
  for (const removed of m.removedTags) if (hasTag(tags, removed)) return false
  return true
}

/**
 * Apply a mutation's intent to the CURRENT tags.
 *
 * Recomputation (rather than replaying `targetTags`) is what preserves tags the
 * user added or a concurrent edit introduced after the original attempt.
 */
export function applyIntent(
  current: readonly string[],
  added: readonly string[],
  removed: readonly string[],
): string[] {
  const removeKeys = new Set(removed.map(tagKey))
  const out = dedupeTagNames(current.filter((t) => !removeKeys.has(tagKey(t))))
  const present = new Set(out.map(tagKey))
  for (const tag of added) {
    const key = tagKey(tag)
    if (present.has(key)) continue
    present.add(key)
    out.push(tag)
  }
  return dedupeTagNames(out)
}

/**
 * Classify a batch reply's per-item failure.
 *
 * The backend already did the classification work on its side of the boundary,
 * where it had the real host error, so its `code`/`retryable` are taken
 * verbatim — re-deriving them here from the message text alone would lose the
 * one signal the frontend cannot compute for itself.
 *
 * `uncertain` is still derived, and for the same reason the single-character
 * path derives it: a transient host failure may have written the tags before
 * it reported the error, so the write's outcome is genuinely unknown and the
 * safe retry must re-read rather than assume.
 */
function classifyBatchFailure(failure: BatchFailure): ClassifiedError {
  const message = sanitizeMessage(failure.message)
  return {
    message,
    code: failure.code,
    retryable: failure.retryable,
    uncertain: TIMEOUT_PATTERN.test(`${failure.code} ${message}`),
  }
}

function cloneResult(r: MutationResult): MutationResult {
  return {
    ...r,
    sourceTags: [...r.sourceTags],
    addedTags: [...r.addedTags],
    removedTags: [...r.removedTags],
    ...(r.error === undefined ? {} : { error: { ...r.error } }),
    ...(r.committedTags === undefined ? {} : { committedTags: [...r.committedTags] }),
  }
}

function cloneResults(results: readonly MutationResult[]): MutationResult[] {
  return results.map(cloneResult)
}

function snapshot(report: OperationReport, running: boolean): OperationReport {
  return {
    ...report,
    results: cloneResults(report.results),
    totals: computeTotals(report.results),
    status: deriveStatus(report.results, running),
  }
}

function sameTagSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(dedupeTagNames(a).map(tagKey))
  const right = new Set(dedupeTagNames(b).map(tagKey))
  if (left.size !== right.size) return false
  for (const key of left) if (!right.has(key)) return false
  return true
}

function isRenameLike(op: MutationOp): boolean {
  return op === 'rename' || op === 'merge'
}

/** `mutationId` → its tracked result, for the whole of one operation. */
export type ResultIndex = ReadonlyMap<string, MutationResult>

/**
 * Index a result list by `mutationId`.
 *
 * Every write in an operation is looked up several times — once to bump its
 * attempt, once to record its outcome, once to hand it to `onResult` — so a
 * linear scan made the executor quadratic: a 300-character bulk edit spent
 * ~90,000 string comparisons doing bookkeeping it could have done in one pass.
 *
 * `mutationId` is unique within an operation, but a hand-built report is a
 * public input, so a duplicate id keeps the FIRST occurrence. That is what
 * `Array.prototype.find` returned, and a lookup that changed which record it
 * resolved to would silently retarget a write.
 *
 * The index holds REFERENCES to the result objects and is therefore valid for
 * as long as the array is only ever mutated in place: results change state
 * during an operation, and an index rebuilt to follow that would cost a pass
 * per lookup, which is what it exists to avoid.
 */
export function indexResults(results: readonly MutationResult[]): ResultIndex {
  const index = new Map<string, MutationResult>()
  for (const r of results) {
    if (!index.has(r.mutationId)) index.set(r.mutationId, r)
  }
  return index
}

/**
 * Copy a retry's outcome onto another result object.
 *
 * A concurrent duplicate retry must report the SAME outcome as the attempt it
 * joined, but each caller owns a separate snapshot, so the fields are copied
 * rather than the reference shared.
 */
function copyState(target: MutationResult, source: MutationResult): void {
  target.state = source.state
  target.attempts = source.attempts
  target.retryable = source.retryable
  target.uncertain = source.uncertain
  target.error = source.error === undefined ? undefined : { ...source.error }
  // The duplicate adopts the SAME attempt outcome, so it adopts the tags that
  // attempt was verified against — no second confirmation ever happened.
  target.committedTags = source.committedTags === undefined ? undefined : [...source.committedTags]
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolveDeferred = resolvePromise
  })
  return { promise, resolve: resolveDeferred }
}

/** Tracks in-flight retries so a duplicate retry can never double-apply a write. */
export class MutationExecutor {
  private readonly port: CharacterMutationPort
  private readonly now: () => number
  /**
   * In-flight retries, keyed by mutationId. The value is the shared promise
   * for that attempt: a duplicate retry AWAITS it and adopts its outcome
   * instead of starting a second, overlapping write.
   */
  private readonly inFlight = new Map<string, Promise<MutationResult>>()

  constructor(port: CharacterMutationPort, options?: ExecutorOptions) {
    this.port = port
    // `options?.concurrency` is accepted for compatibility and deliberately
    // ignored: the retry path is one batched read plus one batched write —
    // there is no per-character fan-out left to cap. See ExecutorOptions.
    this.now = typeof options?.now === 'function' ? options.now : () => Date.now()
  }

  /**
   * Execute a reviewed preview: one batched write, results per mutation.
   *
   * Every non-conflicting character goes out in a single `updateTagsBatch`
   * request. Each written character is then announced through `onResult`
   * individually, so the UI's per-item reporting is unchanged by the batching;
   * a character whose planned changes disagree is announced through
   * `onProgress` only, as it was before batching, because nothing was attempted
   * for it.
   *
   * `onProgress` is COALESCED (see {@link PROGRESS_EMIT_INTERVAL_MS}) while
   * `onResult` stays per-mutation: one clone each either way, but a progress
   * snapshot clones ALL results, so it cannot be per-character.
   */
  async execute(preview: OperationPreview, hooks?: ExecuteHooks): Promise<OperationReport> {
    const startedAt = this.now()
    const results = preview.mutations.map((m) => this.pendingResult(m))
    const live: OperationReport = {
      opId: preview.opId,
      op: preview.op,
      label: preview.label,
      tags: [...preview.tags],
      startedAt,
      status: 'running',
      results,
      totals: computeTotals(results),
    }
    // `results` is only ever mutated in place from here on, so the index built
    // once here stays correct for the whole operation.
    const index = indexResults(results)

    const byCharacter = new Map<string, PlannedMutation[]>()
    for (const m of preview.mutations) {
      const list = byCharacter.get(m.characterId)
      if (list) list.push(m)
      else byCharacter.set(m.characterId, [m])
    }

    let lastProgressAt = startedAt
    let progressEmitted = false
    /**
     * Emit one progress snapshot, rate-limited to {@link PROGRESS_EMIT_INTERVAL_MS}.
     *
     * `snapshot()` deep-clones every result, so emitting it once per character
     * made a merge of M characters allocate O(M^2) `MutationResult`s — hundreds
     * of megabytes of transient garbage, which OOM-killed the Termux WebView
     * AFTER the write had already succeeded. Coalescing on the injected clock
     * ties the emission count to the operation's DURATION instead of its width;
     * a progress bar needs tens of updates a second, not one per character.
     *
     * The first emission is unconditional so a listener is told the run has
     * STARTED before any rate limit can swallow it, and `execute()` always
     * emits the terminal report itself, so no listener misses an end state.
     *
     * With no `onProgress` hook nothing is listening and nothing is derived:
     * `live.totals`/`live.status` are re-derived by the final snapshot below
     * and by `runRetry`, which derives its
     * own working copy), so no in-flight value is observable mid-write.
     */
    const progress = (): void => {
      const onProgress = hooks?.onProgress
      if (onProgress === undefined) return
      const at = this.now()
      if (progressEmitted && at - lastProgressAt < PROGRESS_EMIT_INTERVAL_MS) return
      lastProgressAt = at
      progressEmitted = true
      const emitted = snapshot(live, true)
      live.totals = emitted.totals
      live.status = emitted.status
      onProgress(emitted)
    }

    // Characters are resolved into ONE write batch. A conflicting character is
    // excluded from it rather than guessed at, so a disagreement is never sent
    // to the host at all.
    const batches: { id: string; tags: string[]; muts: PlannedMutation[] }[] = []
    for (const [, muts] of byCharacter) {
      // Defensive invariant, NOT a live code path: the planner emits exactly one
      // mutation per character, so this loop body only ever sees one record and
      // the check is vacuously true. It stays because a hand-built or mutated
      // `OperationPreview` is a public input, and disagreeing final arrays must
      // never be resolved by guessing which one the user meant.
      const first = muts[0] as PlannedMutation
      if (!muts.every((m) => sameTagSet(m.targetTags, first.targetTags))) {
        for (const m of muts) {
          const result = index.get(m.mutationId)
          if (result) {
            result.state = 'conflict'
            result.retryable = false
            result.error = {
              message:
                'Planned changes for this character disagree on the final tag set, so nothing was written.',
              code: 'conflict',
            }
          }
        }
        progress()
        continue
      }

      for (const m of muts) {
        const result = index.get(m.mutationId)
        if (result) result.attempts += 1
      }
      batches.push({ id: first.characterId, tags: dedupeTagNames(first.targetTags), muts })
    }

    if (batches.length > 0) {
      let outcome: { tagsById: Map<string, string[]>; failures: Map<string, BatchFailure> } | null = null
      try {
        // ONE request for the whole operation, and ONLY tag arrays — never a
        // full-character snapshot.
        const response = await this.port.updateTagsBatch(
          batches.map((b) => ({ characterId: b.id, tags: b.tags })),
        )
        outcome = {
          tagsById: new Map(response.updated.map((entry) => [entry.id, entry.tags])),
          failures: new Map(response.failures.map((failure) => [failure.characterId, failure])),
        }
      } catch (error) {
        // A transport-level failure means NOTHING in this batch is known to have
        // landed, so every mutation it carried failed with that one error —
        // exactly as it would have when each character was written separately.
        const classified = classifyError(error)
        for (const batch of batches) {
          for (const m of batch.muts) {
            const result = index.get(m.mutationId)
            if (result) this.markFailure(result, classified)
          }
        }
      }

      if (outcome !== null) {
        for (const batch of batches) {
          const failure = outcome.failures.get(batch.id)
          if (failure) {
            // A per-item failure fails ONLY that character's mutations, so the
            // report can still name which tag change failed.
            const classified = classifyBatchFailure(failure)
            for (const m of batch.muts) {
              const result = index.get(m.mutationId)
              if (result) this.markFailure(result, classified)
            }
          } else {
            const stored = outcome.tagsById.get(batch.id)
            if (stored === undefined) {
              // The host mentioned this character in NEITHER half of the reply:
              // not as written, not as failed. That is not a success and not a
              // failure — it is no evidence at all, which is what `uncertain`
              // means. Falling back to the array we INTENDED to write would make
              // `intentSatisfied` true by construction and report a write the
              // host never confirmed. Marked retryable so the retry path re-reads
              // the character and finds the truth either way.
              for (const m of batch.muts) {
                const result = index.get(m.mutationId)
                if (result) {
                  this.markFailure(result, {
                    message: 'The host did not report this character back, so the change cannot be confirmed as saved.',
                    code: 'unverified',
                    retryable: true,
                    uncertain: true,
                  })
                }
              }
            } else {
              this.verifyWrite(index, batch.muts, stored)
            }
          }
        }
      }

      for (const batch of batches) {
        for (const m of batch.muts) {
          const result = index.get(m.mutationId)
          if (result) hooks?.onResult?.(cloneResult(result))
        }
        progress()
      }
    }

    live.finishedAt = this.now()
    // The snapshot carries the derived totals/status, so they are adopted from
    // it rather than recomputed: the returned report and the executor's own
    // copy then come from ONE derivation of the same results.
    const report = snapshot(live, false)
    live.status = report.status
    live.totals = report.totals
    hooks?.onProgress?.(report)
    return report
  }

  /** Retry exactly one failed mutation. */
  retryOne(report: OperationReport, mutationId: string): Promise<OperationReport> {
    return this.runRetry(report, [mutationId])
  }

  /** Retry every remaining failure for ONE specific tag change (groupKey from groupFailures). */
  retryGroup(report: OperationReport, groupKey: string): Promise<OperationReport> {
    const group = groupFailures(report).find((g) => g.key === groupKey)
    const ids = group ? group.failures.map((f) => f.mutationId) : []
    return this.runRetry(report, ids)
  }

  /** Retry every remaining failure for the whole operation. */
  retryAll(report: OperationReport): Promise<OperationReport> {
    const ids = report.results
      .filter((r) => r.state === 'failed' || r.state === 'conflict')
      .map((r) => r.mutationId)
    return this.runRetry(report, ids)
  }

  /** True when this exact mutation currently has a retry in flight. */
  isRetrying(report: OperationReport, mutationId: string): boolean {
    void report
    return this.inFlight.has(mutationId)
  }

  /**
   * The safe-retry core shared by retryOne / retryGroup / retryAll.
   *
   * Retries are BATCHED, in three passes:
   *
   *  1. A synchronous pass splits the targets into ATTEMPTS ALREADY IN
   *     FLIGHT (adopted — never written twice) and FRESH mutations, whose
   *     attempts are bumped and which are registered in `inFlight` behind a
   *     deferred. Registration happens before the first `await`, so a
   *     concurrent duplicate retry can never slip in and start a second
   *     overlapping write.
   *  2. Adopted outcomes are copied onto this run's records.
   *  3. Fresh mutations are folded per character against a working copy of
   *     the tags the host JUST reported — ONE `getTagsBatch` for the whole
   *     set — and whatever still needs to land goes out as ONE
   *     `updateTagsBatch`, then gets verified against the host's echo.
   *
   * Nothing is ever replayed from `beforeTags`; every intent is recomputed
   * from freshly read tags. A retry still re-reads before it writes — just
   * in one batched read instead of N single-character ones.
   */
  private async runRetry(
    report: OperationReport,
    mutationIds: readonly string[],
  ): Promise<OperationReport> {
    // The caller's report IS the source of truth: the executor keeps no
    // retention cache of past reports, so there is nothing else to consult.
    const base = report
    const working: OperationReport = {
      ...base,
      results: cloneResults(base.results),
      finishedAt: undefined,
    }
    working.status = deriveStatus(working.results, true)
    working.totals = computeTotals(working.results)
    const index = indexResults(working.results)

    const targets = new Set<string>()
    for (const id of mutationIds) {
      const r = index.get(id)
      // Already resolved, or unknown → no-op. A retry must never re-apply a
      // change that is already applied.
      if (!r) continue
      if (r.state !== 'failed' && r.state !== 'conflict') continue
      targets.add(id)
    }

    // One pass per character keeps a character's mutations strictly ordered,
    // so a later one always observes the earlier one's write.
    const byCharacter = new Map<string, string[]>()
    for (const id of targets) {
      const r = index.get(id) as MutationResult
      const list = byCharacter.get(r.characterId)
      if (list) list.push(id)
      else byCharacter.set(r.characterId, [id])
    }

    // ---- Pass 1 (synchronous): adopt concurrent attempts or register fresh ones.
    //
    // Every fresh registration happens HERE, before the first `await`, which
    // is what preserves exactly-once-write semantics for concurrent duplicate
    // retries: any duplicate that lands after this point sees the entry.
    const adopted: { id: string; promise: Promise<MutationResult> }[] = []
    const deferreds = new Map<string, Deferred<MutationResult>>()
    const freshByCharacter = new Map<string, MutationResult[]>()
    for (const [characterId, ids] of byCharacter) {
      for (const id of ids) {
        const mine = index.get(id) as MutationResult
        // Duplicate retry: an attempt for this exact mutation is already
        // running. Starting a second one could double-apply the write, so we
        // adopt the outcome of the attempt already in flight.
        const existing = this.inFlight.get(id)
        if (existing !== undefined) {
          adopted.push({ id, promise: existing })
          continue
        }
        mine.state = 'retrying'
        mine.attempts += 1
        mine.uncertain = false
        const deferred = createDeferred<MutationResult>()
        this.inFlight.set(id, deferred.promise)
        deferreds.set(id, deferred)
        const list = freshByCharacter.get(characterId)
        if (list) list.push(mine)
        else freshByCharacter.set(characterId, [mine])
      }
    }

    // ---- Pass 2: adopt the outcomes of the concurrent attempts. Still no
    // network call of our own has been made.
    for (const { id, promise } of adopted) {
      const outcome = await promise
      copyState(index.get(id) as MutationResult, outcome)
    }

    try {
      // ---- Pass 3 (fresh mutations only): ONE read, then at most ONE write.
      if (freshByCharacter.size > 0) {
        let currentById: Map<string, CharacterTags> | null
        try {
          // ONE request for every character this retry touches — tags only,
          // never a full-character DTO, never a stale snapshot replay.
          currentById = await this.port.getTagsBatch([...freshByCharacter.keys()])
        } catch (error) {
          // A transport-level failure means NOTHING in this read is known to
          // have landed, so every pending mutation of every targeted character
          // failed with that one error — exactly as it would have when each
          // character was re-read separately.
          const classified = classifyError(error)
          for (const mutations of freshByCharacter.values()) {
            for (const mutation of mutations) this.markFailure(mutation, classified)
          }
          currentById = null
        }

        if (currentById !== null) {
          // Fold each character's mutations, in order, over a working copy of
          // the CURRENT tags. A mutation whose intent is already satisfied
          // resolves without a write; one that can be neither applied nor
          // safely left alone becomes a conflict; the rest write as ONE batch.
          const folded = new Map<string, string[]>()
          // Which mutations still NEED the write — tracked locally, never on
          // the result, because it is not an outcome.
          const needsWrite = new Set<string>()
          for (const [characterId, mutations] of freshByCharacter) {
            const current = currentById.get(characterId)
            if (current === undefined) {
              // Absent from the reply: no honest evidence about this
              // character's tags exists, so nothing may be written for it.
              for (const mutation of mutations) {
                mutation.state = 'conflict'
                mutation.retryable = false
                mutation.uncertain = false
                mutation.error = {
                  message:
                    'This character is no longer accessible — it may have been deleted, so nothing was changed.',
                  code: 'not_found',
                }
              }
              continue
            }
            let workingTags = Array.isArray(current.tags) ? [...current.tags] : []
            for (const mutation of mutations) {
              const planned = toPlanned(mutation)
              // Already applied — possibly by the original write whose
              // response was lost. Recognising this is what makes an
              // ambiguous timeout safe.
              if (intentSatisfied(workingTags, planned)) {
                mutation.state = 'resolved_on_retry'
                mutation.retryable = false
                mutation.uncertain = false
                mutation.error = undefined
                // Host re-read (or the working copy already verified in this fold)
                // vouches for these tags — committedTags reflects what this
                // mutation's satisfied intent was actually checked against,
                // never an assumption.
                mutation.committedTags = [...workingTags]
                continue
              }
              // Rename/merge ambiguity: neither the destination nor the
              // source is present, so we cannot know whether the user
              // deliberately removed the tag elsewhere. Never reintroduce a
              // source tag that is already gone.
              if (
                isRenameLike(mutation.op) &&
                typeof mutation.destTag === 'string' &&
                mutation.destTag !== '' &&
                !hasTag(workingTags, mutation.destTag) &&
                !hasTag(workingTags, mutation.tag)
              ) {
                mutation.state = 'conflict'
                mutation.retryable = false
                mutation.uncertain = false
                mutation.error = {
                  message: `"${mutation.tag}" is already gone and "${mutation.destTag}" is missing, so this change cannot be applied automatically.`,
                  code: 'conflict',
                }
                continue
              }
              workingTags = applyIntent(workingTags, mutation.addedTags, mutation.removedTags)
              needsWrite.add(mutation.mutationId)
            }
            folded.set(characterId, workingTags)
          }

          // ONE request for every character with at least one still-outstanding
          // mutation. Characters whose mutations all resolved in the fold are
          // never sent. (The split may reuse the port method unchanged.)
          const writes: { characterId: string; tags: string[] }[] = []
          for (const [characterId, mutations] of freshByCharacter) {
            if (!mutations.some((mutation) => needsWrite.has(mutation.mutationId))) continue
            const tags = folded.get(characterId)
            if (tags === undefined) continue
            writes.push({ characterId, tags: dedupeTagNames(tags) })
          }

          if (writes.length > 0) {
            let outcome: { tagsById: Map<string, string[]>; failures: Map<string, BatchFailure> } | null = null
            try {
              const response = await this.port.updateTagsBatch(writes)
              outcome = {
                tagsById: new Map(response.updated.map((entry) => [entry.id, entry.tags])),
                failures: new Map(response.failures.map((failure) => [failure.characterId, failure])),
              }
            } catch (error) {
              // A transport-level failure means NOTHING in this batch is known
              // to have landed: every still-outstanding mutation of every
              // written character failed with that one error. Mutations the
              // fold already resolved keep their state.
              const classified = classifyError(error)
              for (const write of writes) {
                for (const mutation of freshByCharacter.get(write.characterId) ?? []) {
                  if (needsWrite.has(mutation.mutationId)) this.markFailure(mutation, classified)
                }
              }
            }

            if (outcome !== null) {
              for (const write of writes) {
                // Only the mutations that still needed this write are
                // in play — mutations already resolved (or conflicted) in the
                // fold keep their outcome untouched.
                const unsatisfied = (freshByCharacter.get(write.characterId) ?? []).filter((mutation) =>
                  needsWrite.has(mutation.mutationId),
                )
                if (unsatisfied.length === 0) continue
                const failure = outcome.failures.get(write.characterId)
                if (failure) {
                  // A per-item failure fails ONLY this character's
                  // outstanding mutations; siblings resolved in the fold and
                  // sibling characters are not touched.
                  const classified = classifyBatchFailure(failure)
                  for (const mutation of unsatisfied) this.markFailure(mutation, classified)
                  continue
                }
                const stored = outcome.tagsById.get(write.characterId)
                if (stored === undefined) {
                  // Absent from BOTH halves of the reply: not a success and
                  // not a failure — no evidence at all, which is what
                  // `uncertain` means. Retryable, so the retry button comes
                  // back and the next attempt re-reads the ground truth.
                  for (const mutation of unsatisfied) {
                    mutation.state = 'failed'
                    mutation.retryable = true
                    mutation.uncertain = true
                    mutation.error = {
                      message:
                        'The host did not report this character back, so the change cannot be confirmed as saved.',
                      code: 'unverified',
                    }
                  }
                  continue
                }
                for (const mutation of unsatisfied) {
                  if (intentSatisfied(stored, toPlanned(mutation))) {
                    mutation.state = 'resolved_on_retry'
                    mutation.retryable = false
                    mutation.uncertain = false
                    mutation.error = undefined
                    // The batch reply carries the host's own post-UPDATE row,
                    // so a satisfied intent means the committed tags are
                    // confirmed.
                    mutation.committedTags = [...stored]
                  } else {
                    mutation.state = 'failed'
                    mutation.retryable = true
                    mutation.uncertain = false
                    mutation.error = {
                      message: 'The update was saved but the tags did not change as intended.',
                      code: 'unverified',
                    }
                  }
                }
              }
            }
          }
        }
      }
    } finally {
      // Whatever happened above, every fresh attempt now has its outcome:
      // resolving the deferred hands exactly that outcome to any adopting
      // retry, and the in-flight marker goes away with it.
      for (const [id, deferred] of deferreds) {
        const result = index.get(id) as MutationResult
        deferred.resolve(result)
        this.inFlight.delete(id)
      }
    }

    working.finishedAt = this.now()
    const final = snapshot(working, false)
    working.status = final.status
    working.totals = final.totals
    return final
  }

  /** Confirm the returned record actually satisfies every mutation's intent. */
  private verifyWrite(
    index: ResultIndex,
    muts: readonly PlannedMutation[],
    postTags: readonly string[],
  ): void {
    for (const m of muts) {
      const result = index.get(m.mutationId)
      if (result === undefined) continue
      if (intentSatisfied(postTags, m)) {
        result.state = 'succeeded'
        result.retryable = false
        result.uncertain = false
        result.error = undefined
        // The batch reply carries the host's own post-UPDATE row, so a
        // satisfied intent means the committed tags are confirmed — which is
        // what lets the store patch local state without an extra re-read.
        result.committedTags = [...postTags]
      } else {
        result.state = 'failed'
        result.retryable = true
        result.uncertain = false
        result.error = {
          message: 'The update was saved but the tags did not change as intended.',
          code: 'unverified',
        }
      }
    }
  }

  private pendingResult(m: PlannedMutation): MutationResult {
    return {
      mutationId: m.mutationId,
      characterId: m.characterId,
      characterName: m.characterName,
      op: m.op,
      tag: m.tag,
      ...(m.destTag === undefined ? {} : { destTag: m.destTag }),
      sourceTags: [...m.sourceTags],
      addedTags: [...m.addedTags],
      removedTags: [...m.removedTags],
      intendedChange: m.intendedChange,
      state: 'pending',
      attempts: 0,
      retryable: false,
      uncertain: false,
    }
  }

  private markFailure(result: MutationResult, classified: ClassifiedError): void {
    result.state = 'failed'
    result.retryable = classified.retryable
    result.uncertain = classified.uncertain
    result.error = {
      message: classified.message,
      ...(classified.code === undefined ? {} : { code: classified.code }),
    }
  }
}

/** Rebuild the planner-shaped view a retry needs from a tracked result. */
function toPlanned(result: MutationResult): PlannedMutation {
  return {
    mutationId: result.mutationId,
    characterId: result.characterId,
    characterName: result.characterName,
    op: result.op,
    tag: result.tag,
    ...(result.destTag === undefined ? {} : { destTag: result.destTag }),
    sourceTags: result.sourceTags,
    addedTags: result.addedTags,
    removedTags: result.removedTags,
    // Deliberately NOT the stale beforeTags/targetTags: a retry recomputes
    // from the freshly fetched record instead of replaying a snapshot.
    targetTags: [],
    beforeTags: [],
    intendedChange: result.intendedChange,
  }
}
import type { BackendResponse, BatchFailure } from '../shared/protocol'
import {
  BACKEND_PAGE_LIMIT,
  type CharacterListPage,
  type CharacterTags,
  type LumiTagCharacterWire,
} from '../shared/types'
import type { SpindleRpc } from './rpc'

/**
 * The narrow mutation surface the executor is allowed to depend on.
 *
 * Both granularities are part of the contract. `execute()` and the retry
 * path use ONLY the batch methods — one message per phase of an operation,
 * however many characters it touches. The single-character methods stay for
 * targeted callers (e.g. the store's chip-removal confirm path); a retry's
 * safety comes from re-reading the CURRENT tags before writing, and that now
 * happens in one batched `getTagsBatch` rather than once per character.
 */
export interface CharacterMutationPort {
  getCharacter(id: string): Promise<LumiTagCharacterWire | null>
  updateTags(id: string, tags: string[]): Promise<LumiTagCharacterWire>
  getTagsBatch(ids: readonly string[]): Promise<Map<string, CharacterTags>>
  updateTagsBatch(
    updates: { characterId: string; tags: string[] }[],
  ): Promise<{ updated: CharacterTags[]; failures: BatchFailure[] }>
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BACKEND_PAGE_LIMIT
  const floored = Math.floor(value)
  if (floored < 1) return 1
  return Math.min(floored, BACKEND_PAGE_LIMIT)
}

/**
 * Avatar image URL for `<img src>`.
 *
 * Why a plain URL is acceptable here: it is a same-origin, GET-only,
 * session-authenticated endpoint (`/api/v1/characters/:id/avatar`) that the
 * host already authorizes per-user from the session cookie. Embedding it as an
 * image src carries no extension token, no bearer credential and no
 * user-supplied origin — the browser attaches the session cookie exactly as it
 * would for any other Lumiverse asset, and the host's existing ETag/If-None-Match
 * caching still applies. Fetching bytes through the backend instead would mean
 * base64 round-tripping megabytes of avatar data through the message channel
 * for zero added safety.
 *
 * Note the path is derived from the character id only; `image_id` is exposed
 * on the DTO but deliberately NOT used, because the resolver endpoint already
 * applies the crop/legacy-path fallback chain authoritatively.
 *
 * This is the ONE source of truth for the avatar URL; the repository method
 * below and every UI call site delegate here.
 */
export function characterAvatarUrl(id: string): string {
  return `/api/v1/characters/${encodeURIComponent(id)}/avatar`
}

/**
 * Read/write access to characters over the Spindle backend worker.
 *
 * This class owns pagination and concurrency policy; it contains NO search,
 * tag-catalog or mutation logic. Errors are deliberately NOT translated here —
 * `SpindleRpcError.code` / `.retryable` are the executor's classification
 * inputs, so swallowing or reshaping them here would destroy that signal.
 */
export class CharacterRepository implements CharacterMutationPort {
  private readonly rpc: SpindleRpc

  constructor(rpc: SpindleRpc) {
    this.rpc = rpc
  }

  /** One page of characters. The caller owns the returned cursor arithmetic. */
  async listPage(offset: number, limit?: number): Promise<CharacterListPage> {
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const response = await this.rpc.request<BackendResponse['type']>({
      type: 'characters.list',
      offset: safeOffset,
      limit: clampLimit(limit),
    })
    const page = response as Extract<BackendResponse, { type: 'characters.list.result' }>
    return { data: Array.isArray(page.data) ? page.data : [], total: page.total }
  }

  /**
   * Walk every page until the reported total is covered.
   *
   * Termination guards, in order:
   *  1. `data.length === 0` — an empty page means the host has nothing more;
   *     without this a lying `total` would spin forever.
   *  2. `offset + received >= total` — the exact-total boundary stops here with
   *     no extra roundtrip for a clean page multiple.
   *
   * Ids are de-duplicated because a concurrent host mutation (a character
   * created mid-walk shifts every later offset) can otherwise surface the same
   * row twice, which would double-apply tags downstream.
   */
  async listAllCharacters(
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<LumiTagCharacterWire[]> {
    const seen = new Set<string>()
    const all: LumiTagCharacterWire[] = []
    let offset = 0

    for (;;) {
      const page = await this.listPage(offset, BACKEND_PAGE_LIMIT)
      const items = page.data
      if (items.length === 0) break

      for (const character of items) {
        if (seen.has(character.id)) continue
        seen.add(character.id)
        all.push(character)
      }

      offset += items.length
      onProgress?.(all.length, page.total)

      if (offset >= page.total) break
    }

    return all
  }

  async getCharacter(id: string): Promise<LumiTagCharacterWire | null> {
    const response = await this.rpc.request<BackendResponse['type']>({
      type: 'characters.get',
      characterId: id,
    })
    const result = response as Extract<BackendResponse, { type: 'characters.get.result' }>
    return result.character ?? null
  }

  /**
   * Replace a character's tag array.
   *
   * Errors propagate UNMODIFIED. The executor classifies retryable vs terminal
   * failures from `SpindleRpcError.code` / `.retryable`, so this must not
   * catch-and-rethrow.
   */
  async updateTags(id: string, tags: string[]): Promise<LumiTagCharacterWire> {
    const response = await this.rpc.request<BackendResponse['type']>({
      type: 'characters.updateTags',
      characterId: id,
      tags,
    })
    const result = response as Extract<BackendResponse, { type: 'characters.updateTags.result' }>
    return result.character
  }

  /**
   * Replace the tag arrays of many characters in ONE round trip.
   *
   * Whole-request errors propagate UNMODIFIED, exactly like {@link updateTags}:
   * the executor classifies retryable vs terminal failures from
   * `SpindleRpcError.code` / `.retryable`, so this must not catch-and-rethrow.
   *
   * Per-character failures are NOT thrown — they arrive as data in
   * `failures[]`, because the request itself succeeded and only those items did
   * not. The caller marks exactly those characters failed and treats the rest as
   * written, which is what keeps one deleted-character race from discarding a
   * whole bulk edit.
   *
   * The reply is tags-only by design: nothing in the bulk path reads a
   * character's prompt body, so shipping it would be payload for no behaviour.
   */
  async updateTagsBatch(
    updates: { characterId: string; tags: string[] }[],
  ): Promise<{ updated: CharacterTags[]; failures: BatchFailure[] }> {
    if (updates.length === 0) return { updated: [], failures: [] }

    const response = await this.rpc.request<BackendResponse['type']>({
      type: 'characters.updateTagsBatch',
      updates,
    })
    const result = response as Extract<BackendResponse, { type: 'characters.updateTagsBatch.result' }>
    return {
      updated: Array.isArray(result.updated) ? result.updated : [],
      failures: Array.isArray(result.failures) ? result.failures : [],
    }
  }

  /**
   * Re-read only the tag arrays of many characters, in ONE round trip.
   *
   * Tags-only by design: after a bulk edit the only thing that can have
   * changed locally is a character's tags, and merging a full DTO would
   * overwrite fields this store never re-reads. Ids the backend could not read
   * are simply absent from the map, which is the honest reading of a read that
   * did not happen.
   */
  async getTagsBatch(ids: readonly string[]): Promise<Map<string, CharacterTags>> {
    const out = new Map<string, CharacterTags>()
    if (ids.length === 0) return out

    const response = await this.rpc.request<BackendResponse['type']>({
      type: 'characters.getBatch',
      characterIds: [...new Set(ids)],
    })
    const result = response as Extract<BackendResponse, { type: 'characters.getBatch.result' }>
    if (!Array.isArray(result.characters)) return out

    for (const entry of result.characters) {
      if (typeof entry?.id === 'string' && entry.id !== '') {
        out.set(entry.id, { id: entry.id, tags: Array.isArray(entry.tags) ? entry.tags : [] })
      }
    }
    return out
  }

  /**
   * Avatar image URL for `<img src>`. See the module-level `characterAvatarUrl`
   * for the full rationale; this delegate exists so existing callers keep working.
   */
  avatarUrl(id: string): string {
    return characterAvatarUrl(id)
  }
}


/**
 * Derived tag catalog for LumiTag.
 *
 * The catalog is NOT stored. It is derived exclusively from the distinct tag
 * names currently assigned to accessible characters. A tag with zero
 * assignments does not exist. There is no shadow tag database.
 */

import type { LumiTagCharacter } from '../shared/types'

export interface TagEntry {
  /** Original spelling as first encountered. */
  name: string
  /** Case-insensitive identity key. */
  key: string
  /** Number of characters assigned this tag. */
  count: number
  /** Stable character ids assigned this tag. */
  characterIds: string[]
}

export interface TagIndex {
  /** All distinct tags, sorted by `key` ascending (deterministic). */
  tags: TagEntry[]
  byKey: Map<string, TagEntry>
  /** Deduplicated tag names per character id. */
  byCharacterId: Map<string, string[]>
  characterCount: number
}

/** Trim a raw value into a tag name; non-strings and empties become `''`. */
export function normalizeTagName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim()
}

/** Case-insensitive identity key for a tag name. */
export function tagKey(name: string): string {
  return normalizeTagName(name).toLowerCase()
}

/**
 * Drop empties/non-strings and case-insensitively dedupe while preserving the
 * first spelling encountered and first-seen order.
 */
export function dedupeTagNames(tags: readonly unknown[]): string[] {
  if (!Array.isArray(tags)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const name = normalizeTagName(raw)
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/** Look a tag up case-insensitively. Never throws. */
export function findTagByKey(index: TagIndex, name: string): TagEntry | undefined {
  if (!index || !(index.byKey instanceof Map)) return undefined
  return index.byKey.get(tagKey(name))
}

/** Character ids carrying a tag, looked up case-insensitively. Never throws. */
export function charactersForTag(index: TagIndex, name: string): string[] {
  const entry = findTagByKey(index, name)
  return entry ? [...entry.characterIds] : []
}

/** Deduplicated tag names for a character id. Never throws. */
export function tagsForCharacter(index: TagIndex, characterId: string): string[] {
  if (!index || !(index.byCharacterId instanceof Map)) return []
  if (typeof characterId !== 'string') return []
  const names = index.byCharacterId.get(characterId)
  return names ? [...names] : []
}

/**
 * Build the derived catalog from accessible characters.
 *
 * Defensive by design: tolerates null/undefined input, characters without a
 * `tags` array, and duplicate character ids. For a duplicated id the last
 * occurrence wins for its tag set, while counts always reflect distinct ids.
 * Two spellings of the same tag collapse into ONE entry using the first
 * spelling seen.
 */
export function buildTagIndex(characters: readonly LumiTagCharacter[]): TagIndex {
  // Collapse duplicate character ids first: last occurrence wins.
  const byCharacterId = new Map<string, string[]>()
  if (Array.isArray(characters)) {
    for (const character of characters) {
      if (!character || typeof character !== 'object') continue
      const id = (character as { id?: unknown }).id
      if (typeof id !== 'string') continue
      const key = id.trim()
      if (key === '') continue
      const rawTags = (character as { tags?: unknown }).tags
      byCharacterId.set(key, dedupeTagNames(Array.isArray(rawTags) ? rawTags : []))
    }
  }

  const byKey = new Map<string, TagEntry>()
  for (const [characterId, names] of byCharacterId) {
    for (const name of names) {
      const key = name.toLowerCase()
      let entry = byKey.get(key)
      if (!entry) {
        entry = { name, key, count: 0, characterIds: [] }
        byKey.set(key, entry)
      }
      entry.count += 1
      entry.characterIds.push(characterId)
    }
  }

  const tags = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  return {
    tags,
    byKey,
    byCharacterId,
    characterCount: byCharacterId.size,
  }
}


/** Element-wise equality for two string arrays (order-sensitive). */
function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Whether a rebuilt tag entry is indistinguishable from the one already in the
 * index — same spelling, same count, same member ids in the same order.
 */
function sameTagEntry(existing: TagEntry, rebuilt: TagEntry): boolean {
  return (
    existing.name === rebuilt.name &&
    existing.count === rebuilt.count &&
    sameStringArray(existing.characterIds, rebuilt.characterIds)
  )
}

/**
 * Incrementally apply tag-only character refreshes to an existing index.
 *
 * Only tag keys present before or after the changed characters are rescanned.
 * This preserves buildTagIndex's ordering/spelling semantics while avoiding
 * rebuilding every tag entry and membership list for every mutation.
 *
 * Unknown character ids are ignored, matching the store's tags-only merge
 * behavior. Duplicate ids are already collapsed in `index.byCharacterId`.
 *
 * If no refreshed id actually changes its tag set, the ORIGINAL index object
 * is returned untouched — no fresh `byKey` map, `tags` array, or entry objects
 * are minted. When only the per-character tag lists change but every rebuilt
 * catalog entry comes out identical, the old `byKey`/`tags` references are
 * reused inside the new index.
 */
export function updateTagIndex(
  index: TagIndex,
  updated: ReadonlyMap<string, { tags: readonly string[] }>,
): TagIndex {
  if (updated.size === 0) return index

  // Phase 1: work out each known id's next tag list and whether ANY of them
  // differs from what the index already holds. If none does, the rebuilt
  // catalog would be byte-identical, so hand back the original object.
  const nextById = new Map<string, string[]>()
  let byCharacterIdChanged = false
  for (const [rawId, value] of updated) {
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    if (id === '' || !index.byCharacterId.has(id)) continue

    const previous = index.byCharacterId.get(id) ?? []
    const next = dedupeTagNames(Array.isArray(value?.tags) ? value.tags : [])
    nextById.set(id, next)
    if (!sameStringArray(previous, next)) byCharacterIdChanged = true
  }

  if (!byCharacterIdChanged) return index

  const byCharacterId = new Map(index.byCharacterId)
  const affectedKeys = new Set<string>()

  for (const [id, next] of nextById) {
    for (const name of index.byCharacterId.get(id) ?? []) affectedKeys.add(tagKey(name))
    for (const name of next) affectedKeys.add(tagKey(name))
    byCharacterId.set(id, next)
  }

  if (affectedKeys.size === 0) return index

  const byKey = new Map(index.byKey)
  let byKeyChanged = false
  for (const key of affectedKeys) {
    let name = ''
    const characterIds: string[] = []
    for (const [characterId, names] of byCharacterId) {
      const matchingName = names.find((candidate) => tagKey(candidate) === key)
      if (matchingName === undefined) continue
      if (name === '') name = matchingName
      characterIds.push(characterId)
    }

    const existing = index.byKey.get(key)
    if (characterIds.length === 0) {
      if (existing === undefined) continue
      byKey.delete(key)
      byKeyChanged = true
      continue
    }

    const rebuilt: TagEntry = { name, key, count: characterIds.length, characterIds }
    if (existing !== undefined && sameTagEntry(existing, rebuilt)) continue
    byKey.set(key, rebuilt)
    byKeyChanged = true
  }

  if (!byKeyChanged) {
    // Per-character tag lists changed (e.g. a non-first spelling variant) but
    // every catalog entry rebuilt identically: keep the derived map and array.
    return {
      tags: index.tags,
      byKey: index.byKey,
      byCharacterId,
      characterCount: byCharacterId.size,
    }
  }

  const tags = [...byKey.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  )

  return {
    tags,
    byKey,
    byCharacterId,
    characterCount: byCharacterId.size,
  }
}

/**
 * The frontend-bound wire projection of a character.
 *
 * The backend answers `characters.list` / `characters.get` /
 * `characters.updateTags` with EXACTLY these fields and nothing else — the
 * frontend never reads a character's prompt body (`description`,
 * `personality`, `scenario`, `creator`, `creator_notes`, `system_prompt`), so
 * shipping it would be payload for no behaviour. Producers build this shape
 * through `normalizeCharacterWire`, which omits the prompt fields entirely
 * rather than empty-filling them.
 */
export interface LumiTagCharacterWire {
  id: string
  name: string
  tags: string[]
  image_id: string | null
  created_at: number
  updated_at: number
}

/**
 * The extension's character shape.
 *
 * Full DTOs (host records, and the input of `normalizeCharacter`) carry the
 * prompt fields, but the worker→frontend projection (`LumiTagCharacterWire`)
 * does NOT. The prompt fields are therefore OPTIONAL here: a character that
 * arrived over the wire simply does not have them, and code written against
 * this shape must treat them as absent. Nothing in the extension reads them;
 * they are kept on the type only so a full DTO and a wire DTO are both
 * assignable to one name.
 */
export interface LumiTagCharacter extends LumiTagCharacterWire {
  description?: string
  personality?: string
  scenario?: string
  creator?: string
  creator_notes?: string
  system_prompt?: string
}

export interface CharacterListPage {
  data: LumiTagCharacterWire[]
  total: number
}

/**
 * The tags-only projection of a character, used by every BATCH transport.
 *
 * A bulk edit of N characters used to pay for 2N full character DTOs crossing
 * the message channel, and it is the bulky prompt fields (`description`,
 * `personality`, `scenario`, `creator_notes`, `system_prompt`) that dominate
 * that cost. Batch replies therefore carry this shape and never a
 * `LumiTagCharacter`: nothing in the batch path reads, writes or renders the
 * prompt body, so shipping it would be pure payload for no behaviour.
 */
export interface CharacterTags {
  id: string
  tags: string[]
}

/**
 * Fields the search language can reach.
 *
 * Character NAME is the only one. The former `A:` operator also searched
 * description / personality / scenario / creator / creator_notes, but a tag
 * manager has little use for prose search, and carrying those fields across
 * the message channel dominated memory on large libraries. `T:` and `C:` both
 * match the name and/or tags only.
 */
export const SEARCHABLE_FIELDS = ['name'] as const
export type SearchableField = (typeof SEARCHABLE_FIELDS)[number]

/**
 * Hard page cap enforced by the host worker RPC (`characters.list` clamps to
 * 200). The response does NOT echo limit/offset, so the client must track its
 * own cursor and page with this value.
 */
export const BACKEND_PAGE_LIMIT = 200
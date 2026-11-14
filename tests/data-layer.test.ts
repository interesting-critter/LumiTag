import { beforeEach, describe, expect, test } from 'bun:test'

import type { SpindleAPI } from 'lumiverse-spindle-types'
import { normalizeCharacter, normalizeCharacterWire, normalizeCharacterTags, normalizeCharacterTagsOnly } from '../src/shared/normalize'
import type { BackendRequest, BackendResponse } from '../src/shared/protocol'
import { BACKEND_PAGE_LIMIT, type LumiTagCharacter } from '../src/shared/types'
import { mapWithConcurrency } from '../src/frontend/concurrency'
import { SpindleRpc, SpindleRpcError } from '../src/frontend/rpc'
import { CharacterRepository, characterAvatarUrl } from '../src/frontend/repository'

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function character(id: string, overrides: Partial<LumiTagCharacter> = {}): LumiTagCharacter {
  return {
    id,
    name: `Character ${id}`,
    description: '',
    personality: '',
    scenario: '',
    creator: '',
    creator_notes: '',
    system_prompt: '',
    tags: [],
    image_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

/** Distributes `Omit` over the response union so each variant stays usable. */
type ResponseInit = BackendResponse extends infer T
  ? T extends BackendResponse
    ? Omit<T, 'requestId'>
    : never
  : never

/**
 * A fake frontend transport. `sendToBackend` hands the request to `onSend`, and
 * `emit` pushes a reply back through the registered backend-message listener —
 * exactly the shape the real `SpindleFrontendContext` provides.
 */
function createFakeCtx() {
  const listeners: Array<(payload: unknown) => void> = []
  const sent: BackendRequest[] = []
  let onSend: (req: BackendRequest) => void = () => {}

  const ctx = {
    sendToBackend(payload: unknown) {
      const req = payload as BackendRequest
      sent.push(req)
      onSend(req)
    },
    onBackendMessage(handler: (payload: unknown) => void) {
      listeners.push(handler)
      return () => {
        const idx = listeners.indexOf(handler)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  }

  return {
    ctx,
    sent,
    get listenerCount() {
      return listeners.length
    },
    onSend(fn: (req: BackendRequest) => void) {
      onSend = fn
    },
    /** Reply to a specific request, correlating by the request's own id. */
    reply(req: BackendRequest, response: ResponseInit) {
      for (const listener of [...listeners]) listener({ ...response, requestId: req.requestId })
    },
    emit(payload: unknown) {
      for (const listener of [...listeners]) listener(payload)
    },
  }
}

/** Resolve after the microtask queue drains, letting awaited chains complete. */
function flush(times = 6): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

/* -------------------------------------------------------------------------- */
/* normalizeCharacterTags                                                      */
/* -------------------------------------------------------------------------- */

describe('normalizeCharacterTags', () => {
  test('trims surrounding whitespace', () => {
    expect(normalizeCharacterTags(['  Elf  ', ' Wizard\n'])).toEqual(['Elf', 'Wizard'])
  })

  test('drops empty and whitespace-only entries', () => {
    expect(normalizeCharacterTags(['Elf', '', '   ', '\t\n'])).toEqual(['Elf'])
  })

  test('drops non-string entries', () => {
    const input = ['Elf', 42, null, undefined, {}, [], true, 'Wizard'] as unknown[]
    expect(normalizeCharacterTags(input)).toEqual(['Elf', 'Wizard'])
  })

  test('dedupes case-insensitively, preserving the first spelling', () => {
    expect(normalizeCharacterTags(['Elf', 'elf', 'ELF', 'Elf '])).toEqual(['Elf'])
    expect(normalizeCharacterTags(['WIZARD', 'wizard'])).toEqual(['WIZARD'])
  })

  test('preserves input order', () => {
    expect(normalizeCharacterTags(['zeta', 'Alpha', 'mu'])).toEqual(['zeta', 'Alpha', 'mu'])
  })

  test('returns [] for non-array input', () => {
    expect(normalizeCharacterTags(null)).toEqual([])
    expect(normalizeCharacterTags(undefined)).toEqual([])
    expect(normalizeCharacterTags('Elf')).toEqual([])
    expect(normalizeCharacterTags({ 0: 'Elf' })).toEqual([])
    expect(normalizeCharacterTags(7)).toEqual([])
  })

  test('does not mutate the input array', () => {
    const input = [' Elf ', 'elf']
    const copy = [...input]
    normalizeCharacterTags(input)
    expect(input).toEqual(copy)
  })
})

/* -------------------------------------------------------------------------- */
/* normalizeCharacterWire                                                      */
/* -------------------------------------------------------------------------- */

describe('normalizeCharacterWire', () => {
  test('ships exactly the frontend-bound keys; prompt fields are absent, not empty-filled', () => {
    const result = normalizeCharacterWire({
      id: 'c1',
      name: 'Aria',
      description: 'a very long body',
      personality: 'a long personality',
      scenario: 'a long scenario',
      creator: 'someone',
      creator_notes: 'private notes',
      system_prompt: 'a long system prompt',
      tags: [' Elf ', 'elf', ' Wizard '],
      image_id: 'img-1',
      created_at: 10,
      updated_at: 20,
    })

    expect(result).toEqual({
      id: 'c1',
      name: 'Aria',
      tags: ['Elf', 'Wizard'],
      image_id: 'img-1',
      created_at: 10,
      updated_at: 20,
    })
    expect(Object.keys(result)).toEqual(['id', 'name', 'tags', 'image_id', 'created_at', 'updated_at'])
    for (const promptField of ['description', 'personality', 'scenario', 'creator', 'creator_notes', 'system_prompt']) {
      expect(result).not.toHaveProperty(promptField)
    }
  })

  test('keeps image_id / created_at / updated_at with the same coercion rules as normalizeCharacter', () => {
    const result = normalizeCharacterWire({ id: 'c', image_id: 'img-1', created_at: 10, updated_at: 20 })
    expect(result.image_id).toBe('img-1')
    expect(result.created_at).toBe(10)
    expect(result.updated_at).toBe(20)

    const blanked = normalizeCharacterWire({ id: 'c', image_id: '', created_at: NaN, updated_at: 'x' })
    expect(blanked.image_id).toBe(null)
    expect(blanked.created_at).toBe(0)
    expect(blanked.updated_at).toBe(0)
  })

  test('normalizes tags identically to normalizeCharacter', () => {
    const raw = { id: 'c1', tags: [' Elf ', 42, 'elf', '', ' Wizard '], image_id: 'i', created_at: 1, updated_at: 2 }
    expect(normalizeCharacterWire(raw).tags).toEqual(normalizeCharacter(raw).tags)
    expect(normalizeCharacterWire(raw).tags).toEqual(['Elf', 'Wizard'])
  })

  test('whitespace-normalizes the id and coerces name like the existing defensive style', () => {
    expect(normalizeCharacterWire({ id: '  c1\n', name: 'Aria' }).id).toBe('c1')
    expect(normalizeCharacterWire({ id: 42, name: 7 }).name).toBe('')
    expect(normalizeCharacterWire({ id: '\t x ', name: 'Aria' }).id).toBe('x')
  })

  test('null / undefined / garbage input does not throw and yields a zero-valued character', () => {
    expect(() => normalizeCharacterWire(null)).not.toThrow()
    expect(normalizeCharacterWire(null)).toEqual({
      id: '',
      name: '',
      tags: [],
      image_id: null,
      created_at: 0,
      updated_at: 0,
    })
    expect(normalizeCharacterWire(undefined).id).toBe('')
    expect(normalizeCharacterWire('nope').tags).toEqual([])
    expect(normalizeCharacterWire(42).image_id).toBe(null)
    expect(normalizeCharacterWire([1, 2])).toEqual({
      id: '',
      name: '',
      tags: [],
      image_id: null,
      created_at: 0,
      updated_at: 0,
    })
  })
})

/* -------------------------------------------------------------------------- */
/* normalizeCharacter                                                          */
/* -------------------------------------------------------------------------- */

describe('normalizeCharacter', () => {
  test('fills missing fields with safe defaults', () => {
    const result = normalizeCharacter({ id: 'c1' })
    expect(result).toEqual({
      id: 'c1',
      name: '',
      description: '',
      personality: '',
      scenario: '',
      creator: '',
      creator_notes: '',
      system_prompt: '',
      tags: [],
      image_id: null,
      created_at: 0,
      updated_at: 0,
    })
  })

  test('defaults missing tags to []', () => {
    expect(normalizeCharacter({ id: 'c1' }).tags).toEqual([])
    expect(normalizeCharacter({ id: 'c1', tags: null }).tags).toEqual([])
    expect(normalizeCharacter({ id: 'c1', tags: 'Elf' }).tags).toEqual([])
  })

  test('normalizes a full DTO and drops unknown fields', () => {
    const result = normalizeCharacter({
      id: 'c1',
      name: 'A',
      description: 'B',
      personality: 'C',
      scenario: 'D',
      creator: 'E',
      creator_notes: 'F',
      system_prompt: 'G',
      tags: [' Elf ', 'elf', 'Wizard'],
      image_id: 'img-1',
      created_at: 10,
      updated_at: 20,
      extensions: { lumitag: {} },
      first_mes: 'ignored',
    })
    expect(result.tags).toEqual(['Elf', 'Wizard'])
    expect(result.image_id).toBe('img-1')
    expect(result.created_at).toBe(10)
    expect(result).not.toHaveProperty('extensions')
  })

  test('null / undefined / non-object input does not throw', () => {
    expect(() => normalizeCharacter(null)).not.toThrow()
    expect(normalizeCharacter(null).id).toBe('')
    expect(normalizeCharacter(undefined).id).toBe('')
    expect(normalizeCharacter('nope').tags).toEqual([])
    expect(normalizeCharacter(42).image_id).toBe(null)
  })

  test('coerces a non-finite numeric timestamp to 0 and blank image_id to null', () => {
    const result = normalizeCharacter({ id: 'c', created_at: NaN, updated_at: 'x', image_id: '' })
    expect(result.created_at).toBe(0)
    expect(result.updated_at).toBe(0)
    expect(result.image_id).toBe(null)
  })
})

/* -------------------------------------------------------------------------- */
/* SpindleRpc                                                                 */
/* -------------------------------------------------------------------------- */

describe('SpindleRpc', () => {
  test('resolves the response matching the requestId', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const pending = rpc.request({ type: 'characters.get', characterId: 'c1' })
    await flush()

    expect(fake.sent).toHaveLength(1)
    const req = fake.sent[0]!
    expect(req.type).toBe('characters.get')
    expect((req as { characterId: string }).characterId).toBe('c1')
    expect(typeof (req as { requestId: string }).requestId).toBe('string')

    fake.reply(req, { type: 'characters.get.result', character: character('c1') })

    const result = await pending
    expect(result.type).toBe('characters.get.result')
    expect((result as { character: LumiTagCharacter }).character.id).toBe('c1')
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })

  test('assigns unique requestIds to concurrent requests and demultiplexes', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const first = rpc.request({ type: 'characters.get', characterId: 'a' })
    const second = rpc.request({ type: 'characters.get', characterId: 'b' })
    await flush()

    expect(fake.sent).toHaveLength(2)
    expect(fake.sent[0]!.requestId).not.toBe(fake.sent[1]!.requestId)

    // Reply OUT OF ORDER to prove correlation is by id, not arrival order.
    fake.reply(fake.sent[1]!, { type: 'characters.get.result', character: character('b') })
    fake.reply(fake.sent[0]!, { type: 'characters.get.result', character: character('a') })

    expect((await first as { character: LumiTagCharacter }).character.id).toBe('a')
    expect((await second as { character: LumiTagCharacter }).character.id).toBe('b')
    rpc.dispose()
  })

  test('rejects on timeout with code `timeout` and retryable true', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx, { timeoutMs: 15 })

    const pending = rpc.request({ type: 'characters.get', characterId: 'c1' })
    await expect(pending).rejects.toMatchObject({ code: 'timeout', retryable: true })
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })

  test('clears the timer after a successful settle (no leak)', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx, { timeoutMs: 10_000 })

    const pending = rpc.request({ type: 'characters.get', characterId: 'c1' })
    await flush()
    fake.reply(fake.sent[0]!, { type: 'characters.get.result', character: null })
    await pending

    // If the timer were still armed, bun would keep the process alive / this
    // would fire; asserting the map is empty is the observable contract.
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })

  test('unwraps an error response into a thrown error preserving code/retryable', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const pending = rpc.request({ type: 'characters.get', characterId: 'nope' })
    await flush()

    fake.reply(fake.sent[0]!, {
      type: 'error',
      code: 'not_found',
      message: 'Character not found',
      retryable: false,
    })

    await expect(pending).rejects.toMatchObject({
      code: 'not_found',
      retryable: false,
      message: 'Character not found',
    })
    rpc.dispose()
  })

  test('preserves retryable: true from a backend error', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const pending = rpc.request({ type: 'characters.list', offset: 0, limit: 200 })
    await flush()
    fake.reply(fake.sent[0]!, {
      type: 'error',
      code: 'internal',
      message: 'boom',
      retryable: true,
    })

    await expect(pending).rejects.toMatchObject({ retryable: true })
    rpc.dispose()
  })

  test('rejects all pending requests on dispose()', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const first = rpc.request({ type: 'characters.get', characterId: 'a' })
    const second = rpc.request({ type: 'characters.get', characterId: 'b' })
    await flush()
    expect(rpc.pendingCount).toBe(2)

    rpc.dispose()

    await expect(first).rejects.toBeInstanceOf(SpindleRpcError)
    await expect(second).rejects.toBeInstanceOf(SpindleRpcError)
    expect(rpc.pendingCount).toBe(0)
    // Listener detached: nothing left to leak.
    expect(fake.listenerCount).toBe(0)
  })

  test('refuses new requests after dispose()', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)
    rpc.dispose()
    await expect(rpc.request({ type: 'characters.get', characterId: 'a' })).rejects.toMatchObject({
      code: 'disposed',
    })
  })

  test('ignores responses with unknown requestIds', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const pending = rpc.request({ type: 'characters.get', characterId: 'a' }, )
    await flush()

    // Stray traffic: wrong id, non-object, missing type.
    fake.emit({ type: 'characters.get.result', requestId: 'nobody-asked', character: null })
    fake.emit('not-an-object')
    fake.emit({ type: 'characters.get.result' })
    fake.emit(null)

    fake.reply(fake.sent[0]!, { type: 'characters.get.result', character: character('a') })
    const result = await pending
    expect((result as { character: LumiTagCharacter }).character.id).toBe('a')
    rpc.dispose()
  })

  test('rejects a malformed response shape', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const pending = rpc.request({ type: 'characters.list', offset: 0, limit: 200 })
    await flush()

    // Right requestId, wrong payload for the expected response type.
    fake.emit({ type: 'characters.list.result', requestId: fake.sent[0]!.requestId, data: 'not-an-array', total: 1 })

    await expect(pending).rejects.toMatchObject({ code: 'protocol_error', retryable: false })
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })

  test('rejects an updateTags reply with a missing or non-object character', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    for (const badCharacter of [undefined, null, 'nope', 42, []]) {
      const pending = rpc.request({ type: 'characters.updateTags', characterId: 'c1', tags: ['Elf'] })
      await flush()

      const reply: Record<string, unknown> = {
        type: 'characters.updateTags.result',
        requestId: fake.sent[fake.sent.length - 1]!.requestId,
      }
      if (badCharacter !== undefined) reply.character = badCharacter
      fake.emit(reply)

      await expect(pending).rejects.toMatchObject({ code: 'protocol_error', retryable: false })
    }
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })

  test('rejects when the transport itself throws on send', async () => {
    const fake = createFakeCtx()
    fake.ctx.sendToBackend = () => {
      throw new Error('channel closed')
    }
    const rpc = new SpindleRpc(fake.ctx)

    await expect(rpc.request({ type: 'characters.get', characterId: 'a' })).rejects.toMatchObject({
      code: 'backend_unavailable',
      retryable: true,
    })
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })
})

/* -------------------------------------------------------------------------- */
/* listAllCharacters                                                          */
/* -------------------------------------------------------------------------- */

/** Fake RPC stub driven by a page function. */
function listRpc(pages: (offset: number, limit: number) => { data: LumiTagCharacter[]; total: number }) {
  const calls: Array<{ offset: number; limit: number }> = []
  const rpc = {
    request: async (req: unknown) => {
      const r = req as { offset: number; limit: number }
      calls.push({ offset: r.offset, limit: r.limit })
      const page = pages(r.offset, r.limit)
      return { type: 'characters.list.result', requestId: 'x', data: page.data, total: page.total } as BackendResponse
    },
  }
  return { rpc: rpc as unknown as SpindleRpc, calls }
}

describe('CharacterRepository.listAllCharacters', () => {
  test('walks multiple pages: full first page, partial second page', async () => {
    const first = Array.from({ length: BACKEND_PAGE_LIMIT }, (_, i) => character(`c${i}`))
    const second = [character('c200'), character('c201'), character('c202')]
    const { rpc, calls } = listRpc((offset) => ({
      data: offset === 0 ? first : second,
      total: first.length + second.length,
    }))

    const all = await new CharacterRepository(rpc).listAllCharacters()

    expect(all).toHaveLength(203)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ offset: 0, limit: BACKEND_PAGE_LIMIT })
    expect(calls[1]).toEqual({ offset: BACKEND_PAGE_LIMIT, limit: BACKEND_PAGE_LIMIT })
  })

  test('stops at an exact-total boundary without an extra request', async () => {
    const page = Array.from({ length: BACKEND_PAGE_LIMIT }, (_, i) => character(`c${i}`))
    const { rpc, calls } = listRpc(() => ({ data: page, total: BACKEND_PAGE_LIMIT }))

    const all = await new CharacterRepository(rpc).listAllCharacters()

    expect(all).toHaveLength(BACKEND_PAGE_LIMIT)
    // Exactly one request: asking for page 2 here would be a wasted roundtrip.
    expect(calls).toHaveLength(1)
  })

  test('terminates when a page returns zero items', async () => {
    // `total` deliberately lies (claims 10,000 more) to prove the empty-page
    // guard is what stops the loop, not the total.
    const { rpc, calls } = listRpc((offset) => ({
      data: offset === 0 ? [character('a'), character('b')] : [],
      total: 10_000,
    }))

    const all = await new CharacterRepository(rpc).listAllCharacters()

    expect(all.map((c) => c.id)).toEqual(['a', 'b'])
    expect(calls).toHaveLength(2)
  })

  test('handles total smaller than the first page', async () => {
    const page = [character('a'), character('b'), character('c')]
    const { rpc, calls } = listRpc(() => ({ data: page, total: 2 }))

    const all = await new CharacterRepository(rpc).listAllCharacters()

    expect(all).toHaveLength(3)
    expect(calls).toHaveLength(1)
  })

  test('returns [] immediately for an empty library', async () => {
    const { rpc, calls } = listRpc(() => ({ data: [], total: 0 }))
    const all = await new CharacterRepository(rpc).listAllCharacters()
    expect(all).toEqual([])
    expect(calls).toHaveLength(1)
  })

  test('reports progress with running loaded count and host total', async () => {
    const first = Array.from({ length: 10 }, (_, i) => character(`a${i}`))
    const second = Array.from({ length: 5 }, (_, i) => character(`b${i}`))
    const { rpc } = listRpc((offset) => ({ data: offset === 0 ? first : second, total: 15 }))

    const seen: Array<[number, number]> = []
    await new CharacterRepository(rpc).listAllCharacters((loaded, total) => seen.push([loaded, total]))

    expect(seen).toEqual([
      [10, 15],
      [15, 15],
    ])
  })

  test('dedupes repeated ids across pages', async () => {
    const { rpc } = listRpc((offset) => ({
      data: offset === 0 ? [character('a'), character('b')] : [character('b'), character('c')],
      total: 4,
    }))

    const all = await new CharacterRepository(rpc).listAllCharacters()

    expect(all.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })
})

/* -------------------------------------------------------------------------- */
/* mapWithConcurrency                                                         */
/* -------------------------------------------------------------------------- */

describe('mapWithConcurrency', () => {
  test('preserves input order despite out-of-order completion', async () => {
    const delays = [30, 1, 20, 2, 10]
    const results = await mapWithConcurrency(delays, 5, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return index
    })
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason))).toEqual([0, 1, 2, 3, 4])
  })

  test('resolves settled results instead of rejecting when items fail', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('nope')
      return n * 10
    })
    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 })
    expect(results[1]!.status).toBe('rejected')
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('nope')
    expect(results[2]).toEqual({ status: 'fulfilled', value: 30 })
  })

  test('respects the concurrency cap', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 4, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await flush(2)
      inFlight -= 1
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  test('guards limit < 1 by clamping to 1', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4], 0, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await flush(2)
      inFlight -= 1
    })
    expect(peak).toBe(1)
  })

  test('handles an empty input array', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* repository mutation + avatar                                               */
/* -------------------------------------------------------------------------- */

describe('CharacterRepository.updateTags', () => {
  test('sends the tags array and returns the updated character', async () => {
    let seen: unknown
    const rpc = {
      request: async (req: unknown) => {
        seen = req
        return {
          type: 'characters.updateTags.result',
          requestId: 'x',
          character: character('c1', { tags: ['Elf'] }),
        } as BackendResponse
      },
    }

    const updated = await new CharacterRepository(rpc as unknown as SpindleRpc).updateTags('c1', ['Elf'])
    expect(seen).toEqual({ type: 'characters.updateTags', characterId: 'c1', tags: ['Elf'] })
    expect(updated.tags).toEqual(['Elf'])
  })

  test('propagates backend errors as-is', async () => {
    const failure = new SpindleRpcError('forbidden', 'Missing characters permission', false)
    const rpc = {
      request: async () => {
        throw failure
      },
    }

    const repo = new CharacterRepository(rpc as unknown as SpindleRpc)
    // Same object identity: the executor classifies on code/retryable, so the
    // repository must not wrap or translate it.
    await expect(repo.updateTags('c1', ['Elf'])).rejects.toBe(failure)
  })
})

describe('characterAvatarUrl (shared avatar URL helper)', () => {
  test('builds the read-only avatar endpoint and encodes the id', () => {
    expect(characterAvatarUrl('abc-123')).toBe('/api/v1/characters/abc-123/avatar')
    expect(characterAvatarUrl('a/b?c=d')).toBe('/api/v1/characters/a%2Fb%3Fc%3Dd/avatar')
    // The repository method delegates to the same helper.
    const repo = new CharacterRepository({} as unknown as SpindleRpc)
    expect(repo.avatarUrl('abc-123')).toBe(characterAvatarUrl('abc-123'))
  })
})
/* -------------------------------------------------------------------------- */
/* backend: envelope userId forwarding                                        */
/* -------------------------------------------------------------------------- */

/** One recorded host character call, as (method, positional args). */
interface SpindleCall {
  method: 'list' | 'get' | 'update'
  args: unknown[]
}

/** One outbound reply, as (payload, target userId). */
interface SpindleReply {
  payload: BackendResponse
  userId: string
}

/**
 * A fake `spindle` global that records every character call and every reply.
 *
 * `onFrontendMessage` is captured exactly once (at module import) the way the
 * real host does it, so `deliver` is the single entry point every test drives.
 * The character stubs succeed by default; `failNext` makes the *next* call
 * throw so the worker's error path can be exercised, and `failIds` names
 * specific characters so a batch can be exercised for PARTIAL success.
 */
function createFakeSpindle() {
  const calls: SpindleCall[] = []
  const replies: SpindleReply[] = []
  const warnings: string[] = []
  const records = new Map<string, Record<string, unknown>>()
  const failIds = new Set<string>()
  let handler: ((payload: unknown, userId: string) => void) | null = null
  let failure: Error | null = null

  const spindle = {
    characters: {
      async list(...args: unknown[]) {
        calls.push({ method: 'list', args })
        if (failure) { const err = failure; failure = null; throw err }
        return { data: [character('c1')], total: 1 }
      },
      async get(...args: unknown[]) {
        const id = args[0] as string
        calls.push({ method: 'get', args })
        if (failure) { const err = failure; failure = null; throw err }
        if (failIds.has(id)) throw new Error(`character ${id} not found`)
        const record = records.get(id)
        if (record) return record
        return { id, name: `Character ${id}`, description: 'a long body'.repeat(50), tags: [] }
      },
      async update(...args: unknown[]) {
        const id = args[0] as string
        calls.push({ method: 'update', args })
        if (failure) { const err = failure; failure = null; throw err }
        if (failIds.has(id)) throw new Error(`character ${id} not found`)
        return { ...(records.get(id) ?? { id, name: `Character ${id}` }), ...(args[1] as object) }
      },
    },
    onFrontendMessage(fn: (payload: unknown, userId: string) => void) {
      handler = fn
      return () => { handler = null }
    },
    sendToFrontend(payload: unknown, userId: string) {
      replies.push({ payload: payload as BackendResponse, userId })
    },
    log: {
      info() {},
      warn(message: string) { warnings.push(message) },
      error() {},
    },
  }

  // `src/backend.ts` reads `spindle` off the global scope and registers its
  // handler at import time, so install the fake first and import after.
  ;(globalThis as { spindle?: unknown }).spindle = spindle
  return {
    spindle,
    calls,
    replies,
    warnings,
    records,
    failIds,
    reset() {
      calls.length = 0
      replies.length = 0
      warnings.length = 0
      records.clear()
      failIds.clear()
      failure = null
    },
    /** Make the next host character call reject, mimicking a host throw. */
    failNext(err: Error) { failure = err },
    /** Seed the raw host DTO a character id resolves to. */
    seed(id: string, raw: Record<string, unknown>) { records.set(id, raw) },
    /** Hand a frontend message to the worker with an envelope userId. */
    deliver(payload: unknown, userId: string) {
      if (!handler) throw new Error('backend never registered an onFrontendMessage handler')
      handler(payload, userId)
    },
  }
}

const ENVELOPE_USER_ID = 'user-42'
const host = createFakeSpindle()
await import('../src/backend')

describe('backend forwards the envelope userId to host character calls', () => {
  beforeEach(() => host.reset())

  test('characters.list receives the userId from the onFrontendMessage envelope', async () => {
    host.deliver({ type: 'characters.list', requestId: 'r1', limit: 10, offset: 0 }, ENVELOPE_USER_ID)
    await flush()

    expect(host.calls).toHaveLength(1)
    expect(host.calls[0]!.method).toBe('list')
    // Regression: this argument was absent, which made the host throw
    // "userId is required for operator-scoped extensions".
    expect(host.calls[0]!.args[0]).toEqual({ limit: 10, offset: 0, userId: ENVELOPE_USER_ID })
  })

  test('characters.get receives the userId from the envelope', async () => {
    host.deliver({ type: 'characters.get', requestId: 'r2', characterId: 'c1' }, ENVELOPE_USER_ID)
    await flush()

    expect(host.calls).toHaveLength(1)
    expect(host.calls[0]!.method).toBe('get')
    expect(host.calls[0]!.args).toEqual(['c1', ENVELOPE_USER_ID])
  })

  test('characters.update receives the userId from the envelope', async () => {
    host.deliver(
      { type: 'characters.updateTags', requestId: 'r3', characterId: 'c1', tags: [' Elf ', 'elf', ' Wizard '] },
      ENVELOPE_USER_ID,
    )
    await flush()

    expect(host.calls).toHaveLength(1)
    expect(host.calls[0]!.method).toBe('update')
    expect(host.calls[0]!.args).toEqual([
      'c1',
      // Tags stay normalized on the way through — userId is appended, not swapped in.
      { tags: ['Elf', 'Wizard'] },
      ENVELOPE_USER_ID,
    ])
  })

  test('each connection gets its own userId, never a cached one', async () => {
    host.deliver({ type: 'characters.get', requestId: 'r4', characterId: 'c1' }, 'user-a')
    host.deliver({ type: 'characters.get', requestId: 'r5', characterId: 'c1' }, 'user-b')
    await flush()

    expect(host.calls.map((c) => c.args[1])).toEqual(['user-a', 'user-b'])
    expect(host.replies.map((r) => r.userId)).toEqual(['user-a', 'user-b'])
  })

  test('replies are routed back to the same envelope userId', async () => {
    host.deliver({ type: 'characters.list', requestId: 'r6', limit: 5, offset: 0 }, ENVELOPE_USER_ID)
    await flush()

    expect(host.replies).toHaveLength(1)
    expect(host.replies[0]!.userId).toBe(ENVELOPE_USER_ID)
    expect(host.replies[0]!.payload.type).toBe('characters.list.result')
  })
})

describe('backend user-scope failure handling', () => {
  beforeEach(() => host.reset())

  test('never calls the host with an empty userId; drops silently with a warning', async () => {
    host.deliver({ type: 'characters.list', requestId: 'r7', limit: 5, offset: 0 }, '')
    await flush()

    // Nothing reaches the host: there is no honest id to send. The host would
    // route a reply addressed to "" to the broadcast "system" topic, reaching
    // every connected client, so no reply is sent at all.
    expect(host.calls).toHaveLength(0)
    expect(host.warnings).toHaveLength(1)
    expect(host.replies).toHaveLength(0)
  })

  test('classifies the host operator-scoped error as scope_unresolved, not invalid_input', async () => {
    host.failNext(new Error('userId is required for operator-scoped extensions'))
    host.deliver({ type: 'characters.list', requestId: 'r8', limit: 5, offset: 0 }, ENVELOPE_USER_ID)
    await flush()

    const error = host.replies[0]!.payload as Extract<BackendResponse, { type: 'error' }>
    // "required" would otherwise pull this into invalid_input, blaming the
    // frontend request for what is a scope-resolution failure.
    expect(error.code).toBe('scope_unresolved')
    expect(error.retryable).toBe(false)
    // No stack trace crosses the boundary.
    expect(error.message).toBe('userId is required for operator-scoped extensions')
  })

  test('a genuine invalid-input failure is still invalid_input', async () => {
    host.failNext(new Error('tag must be a string'))
    host.deliver({ type: 'characters.updateTags', requestId: 'r9', characterId: 'c1', tags: ['a'] }, ENVELOPE_USER_ID)
    await flush()

    expect(host.replies[0]!.payload).toMatchObject({ code: 'invalid_input', retryable: false })
  })

  test('a permission failure is still forbidden', async () => {
    host.failNext(new Error('permission denied: characters'))
    host.deliver({ type: 'characters.get', requestId: 'r10', characterId: 'c1' }, ENVELOPE_USER_ID)
    await flush()

    expect(host.replies[0]!.payload).toMatchObject({ code: 'forbidden', retryable: false })
  })
})

describe('backend unsupported request type', () => {
  beforeEach(() => host.reset())

  test('an unsupported type with an empty envelope userId is logged and dropped, never replied to', async () => {
    host.deliver({ type: 'lumen.tags.unsupported', requestId: 'u1' }, '')
    await flush()

    // Same rule as every handled case: an unscoped reply would reach the
    // broadcast "system" topic and leak to every connected client.
    expect(host.replies).toHaveLength(0)
    expect(host.calls).toHaveLength(0)
    expect(host.warnings).toHaveLength(1)
  })

  test('an unsupported type with a whitespace-only envelope userId is logged and dropped', async () => {
    host.deliver({ type: 'lumen.tags.unsupported', requestId: 'u2' }, '   ')
    await flush()

    expect(host.replies).toHaveLength(0)
    expect(host.warnings).toHaveLength(1)
  })

  test('an unsupported type with a valid userId still gets the invalid_input error reply', async () => {
    host.deliver({ type: 'lumen.tags.unsupported', requestId: 'u3' }, ENVELOPE_USER_ID)
    await flush()

    expect(host.replies).toHaveLength(1)
    expect(host.replies[0]!.userId).toBe(ENVELOPE_USER_ID)
    expect(host.replies[0]!.payload).toMatchObject({
      type: 'error',
      requestId: 'u3',
      code: 'invalid_input',
      retryable: false,
    })
  })
})

/* -------------------------------------------------------------------------- */
/* backend: single-character replies ship the slim wire projection             */
/* -------------------------------------------------------------------------- */

describe('backend single-character replies omit the prompt body', () => {
  const PROMPT_SENTINEL = 'PROMPT_BODY_SENTINEL'
  const WIRE_KEYS = ['id', 'name', 'tags', 'image_id', 'created_at', 'updated_at']
  const PROMPT_FIELDS = ['description', 'personality', 'scenario', 'creator', 'creator_notes', 'system_prompt']

  beforeEach(() => host.reset())

  test('characters.list replies carry only the wire keys for every row', async () => {
    // The fake host answers list() with full DTOs (fixture carries the prompt
    // fields), mirroring the host's SELECT *: the backend must slim them.
    host.deliver({ type: 'characters.list', requestId: 'w1', limit: 10, offset: 0 }, ENVELOPE_USER_ID)
    await flush()

    const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.list.result' }>
    expect(reply.type).toBe('characters.list.result')
    expect(reply.data.length).toBeGreaterThan(0)
    for (const row of reply.data) {
      expect(Object.keys(row)).toEqual(WIRE_KEYS)
      for (const promptField of PROMPT_FIELDS) expect(row).not.toHaveProperty(promptField)
    }
    expect(JSON.stringify(reply.data)).not.toContain('"description"')
  })

  test('characters.get replies carry only the wire keys', async () => {
    host.seed('c9', {
      id: 'c9',
      name: 'Aria',
      description: PROMPT_SENTINEL,
      personality: PROMPT_SENTINEL,
      scenario: PROMPT_SENTINEL,
      creator: PROMPT_SENTINEL,
      creator_notes: PROMPT_SENTINEL,
      system_prompt: PROMPT_SENTINEL,
      tags: ['Elf'],
      image_id: 'img-9',
      created_at: 11,
      updated_at: 22,
    })
    host.deliver({ type: 'characters.get', requestId: 'w2', characterId: 'c9' }, ENVELOPE_USER_ID)
    await flush()

    const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.get.result' }>
    expect(Object.keys(reply.character!)).toEqual(WIRE_KEYS)
    for (const promptField of PROMPT_FIELDS) expect(reply.character!).not.toHaveProperty(promptField)
    expect(reply.character).toEqual({
      id: 'c9',
      name: 'Aria',
      tags: ['Elf'],
      image_id: 'img-9',
      created_at: 11,
      updated_at: 22,
    })
    expect(JSON.stringify(reply)).not.toContain(PROMPT_SENTINEL)
  })

  test('characters.updateTags replies carry only the wire keys', async () => {
    host.seed('c8', {
      id: 'c8',
      name: 'Bors',
      description: PROMPT_SENTINEL,
      personality: PROMPT_SENTINEL,
      scenario: PROMPT_SENTINEL,
      creator: PROMPT_SENTINEL,
      creator_notes: PROMPT_SENTINEL,
      system_prompt: PROMPT_SENTINEL,
      tags: ['Old'],
      image_id: null,
      created_at: 33,
      updated_at: 44,
    })
    host.deliver(
      { type: 'characters.updateTags', requestId: 'w3', characterId: 'c8', tags: ['Elf'] },
      ENVELOPE_USER_ID,
    )
    await flush()

    const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.updateTags.result' }>
    expect(Object.keys(reply.character)).toEqual(WIRE_KEYS)
    for (const promptField of PROMPT_FIELDS) expect(reply.character).not.toHaveProperty(promptField)
    expect(reply.character.tags).toEqual(['Elf'])
    expect(reply.character.created_at).toBe(33)
    expect(JSON.stringify(reply)).not.toContain(PROMPT_SENTINEL)
  })
})

/* -------------------------------------------------------------------------- */
/* normalizeCharacterTagsOnly                                                  */
/* -------------------------------------------------------------------------- */

describe('normalizeCharacterTagsOnly', () => {
  test('keeps only the id and the normalized tags', () => {
    const raw = {
      id: 'c1',
      name: 'Aria',
      description: 'a very long body',
      personality: 'x',
      scenario: 'x',
      creator: 'x',
      creator_notes: 'x',
      system_prompt: 'x',
      tags: [' Elf ', 'elf', ' Wizard '],
      image_id: 'img',
      created_at: 1,
      updated_at: 2,
    }
    // The bulky prompt fields are dropped entirely, not zero-filled: the whole
    // point of the tags-only projection is the bytes it does not cross.
    expect(normalizeCharacterTagsOnly(raw)).toEqual({ id: 'c1', tags: ['Elf', 'Wizard'] })
    expect(Object.keys(normalizeCharacterTagsOnly(raw))).toEqual(['id', 'tags'])
  })

  test('never throws on garbage', () => {
    expect(normalizeCharacterTagsOnly(null)).toEqual({ id: '', tags: [] })
    expect(normalizeCharacterTagsOnly('nope')).toEqual({ id: '', tags: [] })
    expect(normalizeCharacterTagsOnly([1, 2])).toEqual({ id: '', tags: [] })
    expect(normalizeCharacterTagsOnly({ id: 7, tags: 'Elf' })).toEqual({ id: '', tags: [] })
  })
})

/* -------------------------------------------------------------------------- */
/* Backend batch handlers                                                      */
/* -------------------------------------------------------------------------- */

describe('backend characters.updateTagsBatch', () => {
  beforeEach(() => host.reset())

  test('N characters cost ONE reply, and every host write is normalized', async () => {
    host.deliver(
      {
        type: 'characters.updateTagsBatch',
        requestId: 'b1',
        updates: [
          { characterId: 'c1', tags: [' Elf ', 'elf', ' Wizard '] },
          { characterId: 'c2', tags: ['Dark'] },
        ],
      },
      ENVELOPE_USER_ID,
    )
    await flush()

    expect(host.replies).toHaveLength(1)
    expect(host.calls.filter((c) => c.method === 'update')).toHaveLength(2)
    expect(host.calls[0]!.args).toEqual(['c1', { tags: ['Elf', 'Wizard'] }, ENVELOPE_USER_ID])
    const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.updateTagsBatch.result' }>
    expect(reply.updated.map((u) => u.id)).toEqual(['c1', 'c2'])
    expect(reply.failures).toEqual([])
    // Tags-only: no prompt body is shipped back for a bulk edit.
    expect(Object.keys(reply.updated[0] as unknown as object)).toEqual(['id', 'tags'])
  })

  test('one failing character is a data-level failure; the rest still land', async () => {
    host.failIds.add('bad')
    host.deliver(
      {
        type: 'characters.updateTagsBatch',
        requestId: 'b2',
        updates: [
          { characterId: 'ok1', tags: ['Elf'] },
          { characterId: 'bad', tags: ['Elf'] },
          { characterId: 'ok2', tags: ['Elf'] },
        ],
      },
      ENVELOPE_USER_ID,
    )
    await flush()

    // Still exactly one reply, and it is NOT an error reply.
    expect(host.replies).toHaveLength(1)
    const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.updateTagsBatch.result' }>
    expect(reply.type).toBe('characters.updateTagsBatch.result')
    expect(reply.updated.map((u) => u.id)).toEqual(['ok1', 'ok2'])
    expect(reply.failures).toEqual([
      { characterId: 'bad', code: 'not_found', message: 'character bad not found', retryable: false },
    ])
  })

  test('every character failing still answers once, with every failure', async () => {
    host.failIds.add('c1')
    host.failIds.add('c2')
    host.deliver(
      {
        type: 'characters.updateTagsBatch',
        requestId: 'b3',
        updates: [
          { characterId: 'c1', tags: ['Elf'] },
          { characterId: 'c2', tags: ['Elf'] },
        ],
      },
      ENVELOPE_USER_ID,
    )
    await flush()

    expect(host.replies).toHaveLength(1)
    const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.updateTagsBatch.result' }>
    expect(reply.updated).toEqual([])
    expect(reply.failures.map((f) => f.characterId)).toEqual(['c1', 'c2'])
  })

  test('a malformed entry fails alone and the valid ones are still written', async () => {
    host.deliver(
      {
        type: 'characters.updateTagsBatch',
        requestId: 'b4',
        updates: [
          { characterId: '', tags: ['Elf'] },
          { characterId: 'c2', tags: 'not-an-array' },
          'garbage',
          { characterId: 'c3', tags: ['Elf'] },
        ],
      },
      ENVELOPE_USER_ID,
    )
    await flush()

    expect(host.calls.filter((c) => c.method === 'update')).toHaveLength(1)
    const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.updateTagsBatch.result' }>
    expect(reply.updated.map((u) => u.id)).toEqual(['c3'])
    expect(reply.failures).toHaveLength(3)
    expect(reply.failures.every((f) => f.code === 'invalid_input' && f.retryable === false)).toBe(true)
  })

  test('each entry is keyed by the id WE requested, not by what the host echoed', async () => {
    // A host that omits or misnames the id on its update reply must not be able
    // to desynchronise the frontend's per-character verification: the `id` in
    // `updated` is a correlation key, and only the requested id is trustworthy.
    for (const raw of [{ name: 'Aria', tags: [] }, { id: 'wrong-id', name: 'Aria', tags: [] }]) {
      host.reset()
      host.seed('c1', raw)
      host.deliver(
        { type: 'characters.updateTagsBatch', requestId: 'bk', updates: [{ characterId: 'c1', tags: ['Elf'] }] },
        ENVELOPE_USER_ID,
      )
      await flush()

      const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.updateTagsBatch.result' }>
      expect(reply.updated).toEqual([{ id: 'c1', tags: ['Elf'] }])
      expect(reply.failures).toEqual([])
    }
  })

  test('an empty batch answers without touching the host', async () => {
    host.deliver({ type: 'characters.updateTagsBatch', requestId: 'b5', updates: [] }, ENVELOPE_USER_ID)
    await flush()

    expect(host.calls).toHaveLength(0)
    expect(host.replies[0]!.payload).toEqual({
      type: 'characters.updateTagsBatch.result',
      requestId: 'b5',
      updated: [],
      failures: [],
    })
  })

  test('a non-array updates field is rejected as invalid input', async () => {
    host.deliver({ type: 'characters.updateTagsBatch', requestId: 'b6', updates: 'nope' }, ENVELOPE_USER_ID)
    await flush()

    expect(host.calls).toHaveLength(0)
    expect(host.replies[0]!.payload).toMatchObject({ type: 'error', code: 'invalid_input', retryable: false })
  })

  test('no user scope drops the batch without a host call or a reply', async () => {
    host.deliver(
      { type: 'characters.updateTagsBatch', requestId: 'b7', updates: [{ characterId: 'c1', tags: ['a'] }] },
      '',
    )
    await flush()

    expect(host.calls).toHaveLength(0)
    expect(host.warnings).toHaveLength(1)
    // No reply at all: a reply addressed to "" would be broadcast to every
    // connected client via the host's "system" topic.
    expect(host.replies).toHaveLength(0)
  })
})

describe('backend characters.getBatch', () => {
  beforeEach(() => host.reset())

  test('reads many characters in one message and answers tags-only', async () => {
    host.seed('c1', { id: 'c1', name: 'Aria', description: 'x'.repeat(100), tags: ['Elf', 'elf'] })
    host.deliver({ type: 'characters.getBatch', requestId: 'g1', characterIds: ['c1', 'c2'] }, ENVELOPE_USER_ID)
    await flush()

    expect(host.replies).toHaveLength(1)
    expect(host.calls.filter((c) => c.method === 'get')).toHaveLength(2)
    expect(host.calls[0]!.args).toEqual(['c1', ENVELOPE_USER_ID])
    const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.getBatch.result' }>
    expect(reply.characters).toEqual([
      { id: 'c1', tags: ['Elf'] },
      { id: 'c2', tags: [] },
    ])
  })

  test('an unreadable character is absent, not an error for the whole batch', async () => {
    host.failIds.add('gone')
    host.deliver({ type: 'characters.getBatch', requestId: 'g2', characterIds: ['c1', 'gone'] }, ENVELOPE_USER_ID)
    await flush()

    const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.getBatch.result' }>
    expect(reply.type).toBe('characters.getBatch.result')
    expect(reply.characters.map((c) => c.id)).toEqual(['c1'])
  })

  test('ids are de-duplicated and unusable entries never reach the host', async () => {
    host.deliver(
      { type: 'characters.getBatch', requestId: 'g3', characterIds: ['c1', 'c1', '', 42, null] },
      ENVELOPE_USER_ID,
    )
    await flush()

    expect(host.calls).toHaveLength(1)
    const reply = host.replies[0]!.payload as Extract<BackendResponse, { type: 'characters.getBatch.result' }>
    expect(reply.characters).toHaveLength(1)
  })

  test('an empty batch answers immediately without a host read', async () => {
    host.deliver({ type: 'characters.getBatch', requestId: 'g4', characterIds: [] }, ENVELOPE_USER_ID)
    await flush()

    expect(host.calls).toHaveLength(0)
    expect(host.replies[0]!.payload).toEqual({
      type: 'characters.getBatch.result',
      requestId: 'g4',
      characters: [],
    })
  })

  test('a non-array characterIds field is rejected as invalid input', async () => {
    host.deliver({ type: 'characters.getBatch', requestId: 'g5', characterIds: {} }, ENVELOPE_USER_ID)
    await flush()

    expect(host.calls).toHaveLength(0)
    expect(host.replies[0]!.payload).toMatchObject({ type: 'error', code: 'invalid_input' })
  })
})

/* -------------------------------------------------------------------------- */
/* SpindleRpc — batch response validation                                       */
/* -------------------------------------------------------------------------- */

describe('SpindleRpc batch responses', () => {
  test('resolves a well-formed updateTagsBatch reply', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)
    const pending = rpc.request({
      type: 'characters.updateTagsBatch',
      updates: [{ characterId: 'c1', tags: ['Elf'] }],
    })
    await flush()
    expect(fake.sent[0]!.type).toBe('characters.updateTagsBatch')
    fake.reply(fake.sent[0]!, {
      type: 'characters.updateTagsBatch.result',
      updated: [{ id: 'c1', tags: ['Elf'] }],
      failures: [],
    })
    const result = await pending
    expect(result.type).toBe('characters.updateTagsBatch.result')
    rpc.dispose()
  })

  test('rejects an updateTagsBatch reply with a non-array failures field', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)
    const pending = rpc.request({
      type: 'characters.updateTagsBatch',
      updates: [{ characterId: 'c1', tags: ['Elf'] }],
    })
    await flush()
    fake.reply(fake.sent[0]!, {
      type: 'characters.updateTagsBatch.result',
      updated: [{ id: 'c1', tags: ['Elf'] }],
      failures: 'none' as unknown as [],
    })
    await expect(pending).rejects.toMatchObject({ code: 'protocol_error', retryable: false })
    rpc.dispose()
  })

  test('rejects a batch reply whose entries are missing their tags array', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)
    const pending = rpc.request({ type: 'characters.getBatch', characterIds: ['c1'] })
    await flush()
    fake.reply(fake.sent[0]!, {
      type: 'characters.getBatch.result',
      characters: [{ id: 'c1' } as unknown as { id: string; tags: string[] }],
    })
    await expect(pending).rejects.toMatchObject({ code: 'protocol_error', retryable: false })
    rpc.dispose()
  })

  test('a batch request may still be answered with an error reply', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)
    const pending = rpc.request({ type: 'characters.getBatch', characterIds: ['c1'] })
    await flush()
    fake.reply(fake.sent[0]!, {
      type: 'error',
      code: 'forbidden',
      message: 'nope',
      retryable: false,
    })
    await expect(pending).rejects.toMatchObject({ code: 'forbidden', retryable: false })
    rpc.dispose()
  })
})

/* -------------------------------------------------------------------------- */
/* Repository batch methods                                                    */
/* -------------------------------------------------------------------------- */

/** Fake RPC stub that records every request body it is handed. */
function batchRpc(reply: (req: Record<string, unknown>) => BackendResponse) {
  const calls: Record<string, unknown>[] = []
  const rpc = {
    request: async (req: unknown) => {
      calls.push(req as Record<string, unknown>)
      return reply(req as Record<string, unknown>)
    },
  }
  return { rpc: rpc as unknown as SpindleRpc, calls }
}

describe('CharacterRepository.updateTagsBatch', () => {
  test('one request carries every update', async () => {
    const { rpc, calls } = batchRpc(() => ({
      type: 'characters.updateTagsBatch.result',
      requestId: 'x',
      updated: [{ id: 'c1', tags: ['Elf'] }, { id: 'c2', tags: ['Dark'] }],
      failures: [],
    }))

    const result = await new CharacterRepository(rpc).updateTagsBatch([
      { characterId: 'c1', tags: ['Elf'] },
      { characterId: 'c2', tags: ['Dark'] },
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      type: 'characters.updateTagsBatch',
      updates: [
        { characterId: 'c1', tags: ['Elf'] },
        { characterId: 'c2', tags: ['Dark'] },
      ],
    })
    expect(result.updated).toHaveLength(2)
    expect(result.failures).toEqual([])
  })

  test('an empty batch costs no request at all', async () => {
    const { rpc, calls } = batchRpc(() => {
      throw new Error('should not be called')
    })
    const result = await new CharacterRepository(rpc).updateTagsBatch([])
    expect(calls).toHaveLength(0)
    expect(result).toEqual({ updated: [], failures: [] })
  })

  test('per-item failures come back as data, not as a thrown error', async () => {
    const failures = [{ characterId: 'c2', code: 'not_found', message: 'gone', retryable: false }]
    const { rpc } = batchRpc(() => ({
      type: 'characters.updateTagsBatch.result',
      requestId: 'x',
      updated: [{ id: 'c1', tags: ['Elf'] }],
      failures,
    }))

    const result = await new CharacterRepository(rpc).updateTagsBatch([
      { characterId: 'c1', tags: ['Elf'] },
      { characterId: 'c2', tags: ['Elf'] },
    ])
    expect(result.failures).toEqual(failures)
  })

  test('a whole-request failure propagates UNMODIFIED, for the executor to classify', async () => {
    const failure = new SpindleRpcError('timeout', 'request timed out', true)
    const rpc = {
      request: async () => {
        throw failure
      },
    }
    const repo = new CharacterRepository(rpc as unknown as SpindleRpc)
    await expect(repo.updateTagsBatch([{ characterId: 'c1', tags: ['Elf'] }])).rejects.toBe(failure)
  })
})

describe('CharacterRepository.getTagsBatch', () => {
  test('one request for many ids, keyed by character id', async () => {
    const { rpc, calls } = batchRpc(() => ({
      type: 'characters.getBatch.result',
      requestId: 'x',
      characters: [{ id: 'c1', tags: ['Elf'] }, { id: 'c2', tags: [] }],
    }))

    const map = await new CharacterRepository(rpc).getTagsBatch(['c1', 'c2', 'c1'])

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ type: 'characters.getBatch', characterIds: ['c1', 'c2'] })
    expect(map.get('c1')).toEqual({ id: 'c1', tags: ['Elf'] })
    expect(map.get('c2')).toEqual({ id: 'c2', tags: [] })
  })

  test('an unreadable character is simply absent from the map', async () => {
    const { rpc } = batchRpc(() => ({
      type: 'characters.getBatch.result',
      requestId: 'x',
      characters: [{ id: 'c1', tags: ['Elf'] }],
    }))
    const map = await new CharacterRepository(rpc).getTagsBatch(['c1', 'gone'])
    expect(map.has('gone')).toBe(false)
  })

  test('an empty id list costs no request at all', async () => {
    const { rpc, calls } = batchRpc(() => {
      throw new Error('should not be called')
    })
    expect((await new CharacterRepository(rpc).getTagsBatch([])).size).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

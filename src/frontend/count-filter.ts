/**
 * Parser for non-negative count filters used by the Tags and Characters lists.
 * Grammar: blank, N (exact), <N, <=N, >N, >=N, or N-M (inclusive).
 * A bare number deliberately means exactly that count. Bounds must be finite
 * non-negative integers; malformed and reversed ranges are rejected.
 */
export type CountFilter =
  | { kind: 'any' }
  | { kind: 'lt' | 'lte' | 'gt' | 'gte' | 'exact'; value: number }
  | { kind: 'range'; min: number; max: number }

export type CountFilterParse = { valid: true; filter: CountFilter } | { valid: false; error: string }

const ANY: CountFilter = { kind: 'any' }
const isCount = (s: string): boolean => /^\d+$/.test(s) && Number.isSafeInteger(Number(s))

export function parseCountFilter(input: string): CountFilterParse {
  const s = input.trim()
  if (!s) return { valid: true, filter: ANY }
  const op = /^(<=|>=|<|>)(\d+)$/.exec(s)
  if (op) {
    if (!isCount(op[2])) return { valid: false, error: 'Use a non-negative whole number.' }
    const kind = ({ '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' } as const)[op[1] as '<' | '<=' | '>' | '>=']
    return { valid: true, filter: { kind, value: Number(op[2]) } }
  }
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(s)
  if (range) {
    if (!isCount(range[1]) || !isCount(range[2])) return { valid: false, error: 'Use non-negative whole numbers.' }
    const min = Number(range[1]), max = Number(range[2])
    if (min > max) return { valid: false, error: 'Range start must not exceed range end.' }
    return { valid: true, filter: { kind: 'range', min, max } }
  }
  if (isCount(s)) return { valid: true, filter: { kind: 'exact', value: Number(s) } }
  return { valid: false, error: 'Use a number, <N, <=N, >N, >=N, or N-M.' }
}

export function matchesCountFilter(filter: CountFilter, count: number): boolean {
  if (!Number.isFinite(count)) return false
  switch (filter.kind) {
    case 'any': return true
    case 'lt': return count < filter.value
    case 'lte': return count <= filter.value
    case 'gt': return count > filter.value
    case 'gte': return count >= filter.value
    case 'exact': return count === filter.value
    case 'range': return count >= filter.min && count <= filter.max
  }
}

export function describeCountFilter(filter: CountFilter): string {
  switch (filter.kind) {
    case 'any': return 'any count'
    case 'lt': return `less than ${filter.value}`
    case 'lte': return `at most ${filter.value}`
    case 'gt': return `more than ${filter.value}`
    case 'gte': return `at least ${filter.value}`
    case 'exact': return `exactly ${filter.value}`
    case 'range': return `${filter.min} to ${filter.max}`
  }
}

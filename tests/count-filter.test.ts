import { describe, expect, test } from 'bun:test'
import { describeCountFilter, matchesCountFilter, parseCountFilter } from '../src/frontend/count-filter'

describe('count filter parser', () => {
  test.each([
    ['', 'any'], ['  ', 'any'], ['10', 'exact'], ['<10', 'lt'], ['<=10', 'lte'], ['>10', 'gt'], ['>=10', 'gte'], ['10-15', 'range'], ['10 - 15', 'range'],
  ] as const)('parses %j', (input, kind) => {
    const result = parseCountFilter(input)
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.filter.kind).toBe(kind)
  })
  test.each(['abc', '15-10', '-5', '10-', '<', '5--10', '1e5', '<>', '=>10', '<='])('rejects %j', (input) => {
    expect(parseCountFilter(input).valid).toBe(false)
  })
  test('matches boundaries', () => {
    const cases: [string, number, boolean][] = [
      ['<10', 9, true], ['<10', 10, false], ['<=10', 10, true], ['>10', 10, false], ['>10', 11, true],
      ['>=10', 10, true], ['10', 9, false], ['10', 10, true], ['10-15', 10, true], ['10-15', 15, true], ['10-15', 16, false],
      ['', 0, true], ['<10', 0, true], ['<=0', 0, true], ['>0', 0, false], ['>=0', 0, true], ['0', 0, true], ['0-0', 0, true],
    ]
    for (const [input, count, expected] of cases) {
      const parsed = parseCountFilter(input)
      if (!parsed.valid) throw new Error(`unexpected invalid filter ${input}`)
      expect(matchesCountFilter(parsed.filter, count)).toBe(expected)
    }
  })
  test('describes filters', () => {
    const p = parseCountFilter('10-15')
    expect(p.valid && describeCountFilter(p.filter)).toBe('10 to 15')
  })
})

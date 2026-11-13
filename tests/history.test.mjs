// Note history's thinning rules. Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toKeep, MAX_PER_NOTE } from '../src/renderer/src/lib/history-keep.ts'

const H = 3_600_000
const D = 24 * H
const now = 1_800_000_000_000

test('keeps every version from the last day', () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ id: 'v' + i, at: now - i * 10 * 60_000 }))
  assert.equal(toKeep(list, now).size, 20)
})

test('one an hour for a week, one a day for a month, one a week after', () => {
  const list = [
    // two in the same hour, three days ago: the newer stays
    { id: 'h1', at: now - 3 * D - 20 * 60_000 }, { id: 'h2', at: now - 3 * D - 30 * 60_000 },
    // two on the same day, two weeks ago
    { id: 'd1', at: Math.floor((now - 14 * D) / D) * D + 5 * H }, { id: 'd2', at: Math.floor((now - 14 * D) / D) * D + 2 * H },
    // two in the same week, three months ago
    { id: 'w1', at: Math.floor((now - 90 * D) / (7 * D)) * 7 * D + D }, { id: 'w2', at: Math.floor((now - 90 * D) / (7 * D)) * 7 * D + 2 * H }
  ]
  assert.deepEqual([...toKeep(list, now)].sort(), ['d1', 'h1', 'w1'])
})

test('never more than the limit, newest first', () => {
  const list = Array.from({ length: 80 }, (_, i) => ({ id: 'v' + i, at: now - i * 60_000 }))
  const keep = toKeep(list, now)
  assert.equal(keep.size, MAX_PER_NOTE)
  assert.ok(keep.has('v0') && !keep.has('v79'))
})

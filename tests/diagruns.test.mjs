// How earlier runs ended, from the diagnostics log. Run: node --test tests/diagruns.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEndings } from '../src/shared/diagruns.ts'

const run = (...lines) => lines.map((l, i) => `2026-11-20T10:00:0${i}Z ${l}`).join('\n')

test('an empty log is a first run', () => {
  assert.deepEqual(runEndings('').badRunsInARow, 0)
  assert.equal(runEndings('').lastEndedBadly, false)
})

test('quitting normally is clean', () => {
  const log = [run('start version=1', 'window created name=main id=1', 'quitting', 'window closed name=main id=1', 'quit')].join('\n')
  assert.equal(runEndings(log).badRunsInARow, 0)
  assert.equal(runEndings(log).lastEndedBadly, false)
})

test('Windows shutting down is clean, even with lines after it', () => {
  const log = [run('start version=1', 'system shutdown', 'window closed name=main id=1')].join('\n')
  assert.equal(runEndings(log).lastEndedBadly, false)
  assert.equal(runEndings(log).badRunsInARow, 0)
})

test('"quitting" alone (a quit that never finished) is not clean', () => {
  const log = run('start version=1', 'quitting')
  assert.equal(runEndings(log).lastEndedBadly, true)
})

test('crashes in a row are counted back to the last clean run', () => {
  const log = [run('start version=1', 'quit'), run('start version=2', 'screen process gone reason=crashed'), run('start version=2', 'window ready name=main id=1')].join('\n')
  const r = runEndings(log)
  assert.equal(r.badRunsInARow, 2)
  assert.equal(r.lastEndedBadly, true)
  assert.match(r.lastLine, /window ready/)
})

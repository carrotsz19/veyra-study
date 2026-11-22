// Unit tests for the diagnostics redaction. Run: node --test tests/redact.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact } from '../src/shared/redact.ts'

test('home-folder paths lose the user name', () => {
  assert.equal(redact('C:\\Users\\alex\\AppData\\Roaming\\veyra-study\\veyra.db'), 'C:\\Users\\<user>\\AppData\\Roaming\\veyra-study\\veyra.db')
  assert.equal(redact('file:///C:/Users/alex/AppData/x.js'), 'file:///C:/Users/<user>/AppData/x.js')
  assert.equal(redact('/home/alex/.config/veyra'), '/home/<user>/.config/veyra')
  assert.equal(redact('/Users/alex/Library'), '/Users/<user>/Library')
})

test('the user name is removed elsewhere too', () => {
  assert.equal(redact('signed in as alexsmith today', 'alexsmith'), 'signed in as <user> today')
  // Too short to replace safely: left alone.
  assert.equal(redact('ab cd', 'ab'), 'ab cd')
})

test('emails, tokens and keys are scrubbed', () => {
  assert.equal(redact('mail someone@example.com now'), 'mail <email> now')
  assert.equal(redact('Authorization: Bearer abc.def-ghi'), 'Authorization: Bearer <secret>')
  assert.equal(redact('https://x.test/a?token=abc123&page=2'), 'https://x.test/a?token=<secret>&page=2')
  assert.equal(redact('key sk-ant-api03-abcdefghijk'), 'key <secret>')
  assert.equal(redact('session 0123456789abcdef0123456789abcdef01'), 'session <secret>')
})

test('ordinary technical text is untouched', () => {
  const line = 'render-process-gone reason=crashed exitCode=-1073741819 window=main version=26.11.4'
  assert.equal(redact(line), line)
})

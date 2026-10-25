import { test } from 'node:test'
import assert from 'node:assert/strict'
import './helpers.test.mjs'
import { extraSchemas } from '../lib/tool-schemas.ts'
import { validate } from '../lib/validation.ts'

test('schema validator rejects inherited required properties and nested unknown fields', () => {
  const inherited = Object.create({ judgment_id: 'rel-a', relation: 'related' })
  assert.throws(() => validate(extraSchemas.mem_judge, inherited), /judgment_id is required/)
  assert.throws(() => validate(extraSchemas.mem_judge_many, { judgments: [{ judgment_id: 'r', relation: 'related', session_id: 'spoof' }] }), /judgments\[0\].session_id is not supported/)
  assert.throws(() => validate(extraSchemas.mem_consolidate, { ids_to_delete: [1, 2], new_title: ' ', new_content: 'body', expected_project: 'p' }), /must not be blank/)
})
test('schema validator preserves literal empty replacement and caller supplied JSON data', () => {
  const args = { id: 7, expected_project: 'p', find: 'literal', replace: '' }
  assert.equal(validate(extraSchemas.mem_update, args), args)
  assert.deepEqual(args, { id: 7, expected_project: 'p', find: 'literal', replace: '' })
})

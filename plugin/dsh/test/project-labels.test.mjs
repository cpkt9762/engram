import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Projects, labelKey } from '../lib/project.ts'
import { Satellites } from '../lib/satellite.ts'

const vectors = JSON.parse(await readFile(new URL('../../../internal/project/testdata/label-keys.json', import.meta.url), 'utf8'))
test('Go and DSH label keys share vectors', () => {
  for (const { name, key } of vectors) assert.equal(labelKey(name), key, name)
})
test('aliases select current project before satellite and cwd mismatch checks; absent field preserves legacy', async () => {
  for (const aliases of [undefined, [], ['checkout.folder', 'linked-worktree', 'café-remote', 'οσ']]) {
    const response = { project: 'canonical', ...(aliases === undefined ? {} : { aliases }) }
    const root = { cwd: '/checkout', project: 'canonical', response, provenance: { source: 'git_remote', directory: '/checkout' } }
    const projects = { resolve: async () => root }
    const satellites = new Satellites({}, {}, projects)
    const agent = { id: 'root' }
    for (const tool of ['mem_save', 'mem_save_prompt', 'mem_session_summary', 'mem_session_finalize']) {
      for (const raw of ['Checkout__Folder', 'LINKED.WORKTREE', 'CAFE\u0301_REMOTE', 'ΟΣ']) {
        const target = await satellites.resolve(tool, agent, root, { project: raw })
        assert.equal(target.project.project, aliases?.length ? 'canonical' : raw.normalize('NFC').toLowerCase().replace(/__+/g, '_'))
        assert.equal(target.satellite, !aliases?.length)
        assert.equal(target.project.provenance.source, 'explicit_override')
        assert.equal(target.project.provenance.raw_project, raw)
        if (aliases?.length) assert.equal((await satellites.resolve(tool, agent, root, { project: raw, cwd: '/checkout' })).satellite, false)
        else await assert.rejects(satellites.resolve(tool, agent, root, { project: raw, cwd: '/checkout' }), /does not match/)
      }
      assert.equal((await satellites.resolve(tool, agent, root, { project: 'foreign' })).satellite, true)
    }
    // Only opt-in servers enable separator variants of the canonical name itself.
    const variantRoot = { ...root, project: 'canonical-name', response: { ...response, project: 'canonical-name' } }
    assert.equal((await satellites.resolve('mem_save', agent, variantRoot, { project: 'canonical_name' })).satellite, aliases === undefined)
  }
})
test('project detection asks for aliases', async () => {
  const requests = []
  const projects = new Projects({ request: async path => { requests.push(path); return { project: 'canonical', aliases: [] } } })
  await projects.resolve('/checkout')
  assert.equal(new URL(requests[0], 'http://fixture').searchParams.get('aliases'), 'true')
})

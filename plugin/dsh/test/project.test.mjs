import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { stub, json, config, home } from './helpers.test.mjs'
import { Client } from '../lib/client.ts'
import { Projects, agentCwd } from '../lib/project.ts'

test('project success caches by cwd and preserves provenance', async t => {
  let calls = 0
  const { url } = await stub(t, (req, res) => { calls++; assert.equal(new URL(req.url, 'http://local').searchParams.get('cwd'), home); json(res, { project: ' project-a ', project_source: 'git', raw_project: 'raw-a' }) })
  const projects = new Projects(new Client(config(url)))
  const result = await projects.resolve(home)
  assert.equal(result.project, 'project-a')
  assert.deepEqual(result.provenance, { source: 'git', directory: home, raw_project: 'raw-a' })
  assert.equal(await projects.resolve(home), result); assert.equal(calls, 1)
})
test('404 falls back upward to config with config provenance', async t => {
  const root = await mkdtemp(join(home, 'config-')), cwd = join(root, 'nested')
  await mkdir(join(root, '.engram')); await mkdir(cwd)
  await writeFile(join(root, '.engram/config.json'), JSON.stringify({ project_name: 'configured' }))
  const { url } = await stub(t, (req, res) => json(res, {}, 404))
  const result = await new Projects(new Client(config(url))).resolve(cwd)
  assert.equal(result.project, 'configured'); assert.equal(result.provenance.source, 'config')
  assert.equal(result.provenance.directory, cwd)
})
test('404 without config and malformed/missing project_name config fail closed', async t => {
  const { url } = await stub(t, (req, res) => json(res, {}, 404))
  const cwd = await mkdtemp(join(home, 'invalid-'))
  const projects = new Projects(new Client(config(url)))
  await assert.rejects(projects.resolve(cwd), /no .engram/)
  for (const content of ['{', '{}', '{"project_name":""}']) {
    const dir = await mkdtemp(join(home, 'bad-')); await mkdir(join(dir, '.engram'))
    await writeFile(join(dir, '.engram/config.json'), content)
    await assert.rejects(projects.resolve(dir))
  }
})
test('HOME explicit_project_required fails without five retries', async t => {
  let calls = 0
  const { url } = await stub(t, (req, res) => { calls++; json(res, { code: 'explicit_project_required' }, 409) })
  await assert.rejects(new Projects(new Client(config(url))).resolve(home), /Explicit project required/)
  assert.equal(calls, 1)
})
for (const data of [{ project: 'unknown' }, { project: 'UNKNOWN' }, { project: 'a/b' }, { project: 'a\\b' }, { project: 'valid', error_hint: 'broken' }, {}, { project: 'a\u0000' }]) {
  test(`unsafe project is rejected: ${JSON.stringify(data)}`, async t => {
    const { url } = await stub(t, (req, res) => json(res, data))
    await assert.rejects(new Projects(new Client(config(url))).resolve(home), /resolution failed/)
  })
}
test('project retries exactly five times and failure cache expires after 30 seconds', async t => {
  let calls = 0, now = 0, valid = false
  const { url } = await stub(t, (req, res) => { calls++; json(res, valid ? { project: 'fixed' } : {}, valid ? 200 : 503) })
  const projects = new Projects(new Client(config(url)), () => now)
  await assert.rejects(projects.resolve(home))
  assert.equal(calls, 5)
  valid = true; now = 29999
  await assert.rejects(projects.resolve(home)); assert.equal(calls, 5)
  now = 30000
  assert.equal((await projects.resolve(home)).project, 'fixed'); assert.equal(calls, 6)
})
test('cwd is exclusively an absolute session header value', async () => {
  assert.equal(agentCwd({ session: { header: { cwd: home } } }), home)
  for (const bad of [{}, { session: { header: { cwd: 'relative' } } }]) assert.throws(() => agentCwd(bad), /session.header.cwd/)
})

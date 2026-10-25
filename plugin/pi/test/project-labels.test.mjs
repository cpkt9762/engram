import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withPluginSandbox } from './plugin-sandbox.mjs';

const vectors = JSON.parse(await readFile(new URL('../../../internal/project/testdata/label-keys.json', import.meta.url), 'utf8'));
test('Go and Pi label keys share vectors', async () => {
  await withPluginSandbox('engram-label-keys-', async ({ sandbox }) => {
    const { labelKey } = await import(pathToFileURL(join(sandbox, 'index.ts')).href);
    for (const { name, key } of vectors) assert.equal(labelKey(name), key, name);
  });
});

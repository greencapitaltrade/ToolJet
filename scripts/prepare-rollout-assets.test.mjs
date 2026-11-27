import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { prepareRolloutAssets } from './prepare-rollout-assets.mjs';

const baselineHtml = '<script defer src="/main.012345ab.js"></script>';
const candidateHtml = '<script defer src="/main.112345ab.js"></script>';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tooljet-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseline = join(directory, 'baseline');
  const candidate = join(directory, 'candidate');
  await Promise.all([mkdir(baseline), mkdir(candidate)]);
  const put = async (tree, name, content) => {
    const file = join(tree, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await Promise.all([
    put(baseline, 'index.html', baselineHtml),
    put(candidate, 'index.html', candidateHtml),
    put(baseline, 'main.012345ab.js', 'old entry'),
    put(candidate, 'main.112345ab.js', 'new entry'),
    put(baseline, 'settings.fedcba98.chunk.js', 'old lazy chunk'),
    put(candidate, 'settings.edcba987.chunk.js', 'new lazy chunk'),
    put(baseline, 'assets/logo.svg', 'same logo'),
    put(candidate, 'assets/logo.svg', 'same logo'),
    put(candidate, 'assets/0ab1cd23.woff2', 'new font'),
  ]);
  return { baseline, candidate, output: join(directory, 'overlays'), put };
}

test('retains both generations in opposite overlays and leaves each HTML entrypoint unchanged', async (t) => {
  const { baseline, candidate, output } = await fixture(t);
  const result = await prepareRolloutAssets(baseline, candidate, output);
  assert.equal(await readFile(join(output, 'baseline', 'settings.edcba987.chunk.js'), 'utf8'), 'new lazy chunk');
  assert.equal(await readFile(join(output, 'candidate', 'settings.fedcba98.chunk.js'), 'utf8'), 'old lazy chunk');
  assert.equal(await readFile(join(output, 'baseline', 'assets/0ab1cd23.woff2'), 'utf8'), 'new font');
  for (const generation of ['baseline', 'candidate']) {
    await assert.rejects(readFile(join(output, generation, 'index.html')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(output, generation, 'assets/logo.svg')), { code: 'ENOENT' });
  }
  assert.equal(await readFile(join(baseline, 'index.html'), 'utf8'), baselineHtml);
  assert.equal(await readFile(join(candidate, 'index.html'), 'utf8'), candidateHtml);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')), result);
  assert.notEqual(result.entrypoints.baseline, result.entrypoints.candidate);
  assert.equal(result.overlays.baseline.length, 3);
  assert.equal(result.overlays.candidate.length, 2);
});

test('rejects hashed files whose path is shared and contents differ', async (t) => {
  const { baseline, candidate, output, put } = await fixture(t);
  await put(candidate, 'main.012345ab.js', 'different bytes under the old hash');
  await assert.rejects(prepareRolloutAssets(baseline, candidate, output), /Hashed path has different bytes: main/);
  await assert.rejects(readFile(join(output, 'manifest.json')), { code: 'ENOENT' });
});

test('permits different gzip encoding only when both streams match the same immutable file', async (t) => {
  const { baseline, candidate, output, put } = await fixture(t);
  const file = 'shared.01010101.chunk.js';
  const payload = '// shared code\n'.repeat(200);
  const compressionA = gzipSync(payload, { level: 1 });
  const compressionB = gzipSync(payload, { level: 9 });
  assert.notDeepEqual(compressionA, compressionB);
  await Promise.all([
    put(baseline, file, payload),
    put(candidate, file, payload),
    put(baseline, `${file}.gz`, compressionA),
    put(candidate, `${file}.gz`, compressionB),
  ]);

  const manifest = await prepareRolloutAssets(baseline, candidate, output);
  assert.equal(manifest.equivalentGzip.length, 1);
  assert.equal(manifest.equivalentGzip[0].path, `${file}.gz`);
  await assert.rejects(readFile(join(output, 'baseline', `${file}.gz`)), { code: 'ENOENT' });
  await put(candidate, `${file}.gz`, gzipSync('unrelated'));
  await assert.rejects(
    prepareRolloutAssets(baseline, candidate, `${output}-invalid`),
    /Hashed path has different bytes: shared/
  );
});

test('rejects changed and new unversioned assets for separate compatibility review', async (t) => {
  const { baseline, candidate, output, put } = await fixture(t);
  await put(candidate, 'assets/logo.svg', 'changed logo');
  await put(baseline, 'assets/service-worker.js', 'old service worker');
  await assert.rejects(prepareRolloutAssets(baseline, candidate, output), {
    message:
      /Unversioned asset differs: assets\/logo.svg[\s\S]*Unversioned asset exists in only one build: assets\/service-worker.js/,
  });
});

test('rejects a managed asset path that is a directory in the other generation', async (t) => {
  const { baseline, candidate, output } = await fixture(t);
  await mkdir(join(baseline, 'main.112345ab.js'));
  await assert.rejects(prepareRolloutAssets(baseline, candidate, output), /File conflicts with directory: main/);
});

test('refuses an incomplete build when its HTML refers to a missing asset', async (t) => {
  const { baseline, candidate, output, put } = await fixture(t);
  await put(candidate, 'index.html', '<link rel="stylesheet" href="/main.abc123ff.css">');
  await assert.rejects(
    prepareRolloutAssets(baseline, candidate, output),
    /Entrypoint references a missing asset: main/
  );
});

test('rejects symlinks and avoids overwriting a prepared release directory', async (t) => {
  const { baseline, candidate, output } = await fixture(t);
  await mkdir(output);
  await assert.rejects(prepareRolloutAssets(baseline, candidate, output), /Output already exists/);
  await symlink(join(candidate, 'index.html'), join(baseline, 'link.js'));
  await assert.rejects(prepareRolloutAssets(baseline, candidate, join(output, 'other')), /Unsupported asset: link.js/);
});

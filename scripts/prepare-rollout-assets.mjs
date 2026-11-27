import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const entrypoint = 'index.html';
const isVersioned = (path) =>
  /(?:^|\/)[^/]+\.[a-f\d]{8,64}(?:\.chunk)?\.(?:js|css)(?:\.(?:gz|br|map|LICENSE\.txt))?$/.test(path) ||
  /^(?:assets\/)[a-f\d]{8,64}\.[^/]+$/.test(path);

function verifyEntrypoint(html, files) {
  const base = 'https://build.invalid';
  let versioned = 0;
  for (const [, , value] of html.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
    const url = new URL(value.replace(/^__REPLACE_SUB_PATH__/, ''), base);
    if (url.origin !== base) continue;
    const path = url.pathname.slice(1);
    if (!/(?:\.js|\.css)$/.test(path)) continue;
    if (!files.has(path)) throw new Error(`Entrypoint references a missing asset: ${path}`);
    if (isVersioned(path)) versioned++;
  }
  if (!versioned) throw new Error('Expected the entrypoint to reference a versioned JS or CSS file');
}

async function inventory(root) {
  const files = new Map();
  const directories = new Set();

  async function visit(directory = '') {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        directories.add(path);
        await visit(path);
      } else if (entry.isFile()) {
        files.set(
          path,
          createHash('sha256')
            .update(await readFile(join(root, path)))
            .digest('hex')
        );
      } else {
        throw new Error(`Unsupported asset: ${path}`);
      }
    }
  }

  await visit();
  if (!files.has(entrypoint)) throw new Error(`Expected a production frontend build in ${root}`);
  verifyEntrypoint(await readFile(join(root, entrypoint), 'utf8'), files);
  return { files, directories };
}

function inside(directory, path) {
  const suffix = relative(directory, path);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

export async function prepareRolloutAssets(baselineBuild, candidateBuild, outputDirectory) {
  outputDirectory = resolve(outputDirectory);
  const [baselineRoot, candidateRoot, parent] = await Promise.all([
    realpath(baselineBuild),
    realpath(candidateBuild),
    realpath(dirname(outputDirectory)),
  ]);
  const output = join(parent, basename(outputDirectory));
  if (inside(baselineRoot, output) || inside(candidateRoot, output)) {
    throw new Error('Output must be outside the input builds');
  }
  const exists = await lstat(output).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (exists) throw new Error(`Output already exists: ${output}`);

  const [baseline, candidate] = await Promise.all([inventory(baselineRoot), inventory(candidateRoot)]);
  const overlays = { baseline: [], candidate: [] };
  const differences = [];
  const paths = [...new Set([...baseline.files.keys(), ...candidate.files.keys()])].sort();
  for (const path of paths) {
    if (path === entrypoint) continue;
    const oldHash = baseline.files.get(path);
    const newHash = candidate.files.get(path);
    if (oldHash === newHash) continue;

    if (baseline.directories.has(path) || candidate.directories.has(path)) {
      differences.push(`File conflicts with directory: ${path}`);
    } else if (!isVersioned(path)) {
      differences.push(
        `${oldHash && newHash ? 'Unversioned asset differs' : 'Unversioned asset exists in only one build'}: ${path}`
      );
    } else if (oldHash && newHash) {
      differences.push(`Hashed path has different bytes: ${path}`);
    } else {
      overlays[oldHash ? 'candidate' : 'baseline'].push({ path, sha256: oldHash ?? newHash });
    }
  }
  if (differences.length) {
    throw new Error(differences.join('\n'));
  }

  const manifest = {
    entrypoints: { baseline: baseline.files.get(entrypoint), candidate: candidate.files.get(entrypoint) },
    overlays,
  };
  await mkdir(output);
  try {
    for (const [target, source] of [
      ['baseline', candidateRoot],
      ['candidate', baselineRoot],
    ]) {
      await mkdir(join(output, target));
      for (const { path, sha256 } of overlays[target]) {
        const destination = join(output, target, path);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(join(source, path), destination);
        if (
          createHash('sha256')
            .update(await readFile(destination))
            .digest('hex') !== sha256
        ) {
          throw new Error(`Asset changed during preparation: ${path}`);
        }
      }
    }
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [baseline, candidate, output, unexpected] = process.argv.slice(2);
  try {
    if (!baseline || !candidate || !output || unexpected) {
      throw new Error('Usage: node scripts/prepare-rollout-assets.mjs <baseline-build> <candidate-build> <new-output>');
    }
    const { overlays } = await prepareRolloutAssets(baseline, candidate, output);
    console.log(
      `Prepared ${overlays.baseline.length} baseline additions and ${overlays.candidate.length} candidate additions.`
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

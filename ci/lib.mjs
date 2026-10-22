// Repository-only release tooling. Never imported by the extension or shipped in the TGZ.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, lstat, appendFile } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';

export const PACKAGE = 'pi-free-catalog';
export const REPOSITORY = 'aminmzadev/pi-free-catalog';
export const REPOSITORY_URL = `git+https://github.com/${REPOSITORY}.git`;
export const REGISTRY = 'https://registry.npmjs.org';
export const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const sha1 = bytes => createHash('sha1').update(bytes).digest('hex');
export const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
export const json = async file => JSON.parse(await readFile(file, 'utf8'));

export function run(command, args, { cwd = process.cwd(), env = process.env, inherit = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: inherit ? 'inherit' : 'pipe' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error?.message || result.stderr || ''}`);
  return result.stdout || '';
}

export function checkMetadata(pkg, lock) {
  assert.equal(pkg.name, PACKAGE, 'Unexpected package name');
  assert.match('v' + pkg.version, STABLE_TAG, 'Only stable release versions are supported');
  assert.equal(pkg.repository?.type, 'git');
  assert.equal(pkg.repository?.url, REPOSITORY_URL, 'Repository must match the trusted publisher');
  assert.equal(pkg.publishConfig?.registry, REGISTRY + '/');
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version, 'Root lockfile version mismatch');
  assert.equal(lock.packages?.['']?.name, pkg.name);
  assert.equal(lock.packages?.['']?.version, pkg.version, 'Lockfile package version mismatch');
}

export function checkRelease({ eventName, repository, ref, sha, event }, pkg, lock) {
  checkMetadata(pkg, lock);
  assert.equal(repository, REPOSITORY, 'Publishing from a fork is forbidden');
  assert.equal(eventName, 'release', 'Publishing is only allowed for a release event');
  assert.equal(event?.action, 'published', 'Only published releases are allowed');
  assert.equal(event.release?.draft, false, 'Draft releases are forbidden');
  assert.equal(event.release?.prerelease, false, 'Prereleases are not published as latest');
  const tag = event.release?.tag_name;
  assert.equal(typeof tag, 'string');
  assert.match(tag, STABLE_TAG, 'Invalid stable release tag');
  assert.equal(tag, 'v' + pkg.version, 'Tag and package version differ');
  assert.equal(ref, 'refs/tags/' + tag, 'Event ref and release tag differ');
  assert.match(sha || '', /^[a-f0-9]{40}$/, 'Invalid event commit');
  return { name: pkg.name, version: pkg.version, tag, commit: sha };
}

export function checkReleaseGit(release, git = args => run('git', args).trim()) {
  assert.equal(git(['rev-parse', 'HEAD']), release.commit, 'Checkout is not the event commit');
  assert.equal(git(['rev-parse', `refs/tags/${release.tag}^{commit}`]), release.commit, 'Tag moved after the event');
  git(['merge-base', '--is-ancestor', release.commit, 'refs/remotes/origin/main']);
}

export async function boundedBody(response, maxBytes) {
  const reader = response.body?.getReader();
  assert.ok(reader, 'Empty response body');
  const parts = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; assert.ok(size <= maxBytes, 'Response exceeds size limit'); parts.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(parts);
}

export async function registryJson(url, { fetch = globalThis.fetch, allow404 = false } = {}) {
  const target = new URL(url);
  assert.equal(target.origin, REGISTRY); assert.equal(target.username + target.password, '');
  const response = await fetch(target.href, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
  assert.equal(response.status, 200, `Registry HTTP ${response.status}; failing closed`);
  const parsed = JSON.parse((await boundedBody(response, 2 * 1024 * 1024)).toString('utf8'));
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Invalid registry document');
  return parsed;
}

export async function assertUnpublished(version, options = {}) {
  assert.match('v' + version, STABLE_TAG);
  const specific = await registryJson(`${REGISTRY}/${PACKAGE}/${version}`, { ...options, allow404: true });
  assert.equal(specific, null, 'Version already exists; never overwrite or republish it');
  // A 404 must not mask a nonexistent package or a registry/auth/network failure.
  const document = await registryJson(`${REGISTRY}/${PACKAGE}`, options);
  assert.equal(document.name, PACKAGE);
  assert.ok(document.versions && typeof document.versions === 'object' && !Array.isArray(document.versions));
  assert.ok(Object.keys(document.versions).length, 'Existing package history is missing');
  assert.ok(!Object.hasOwn(document.versions, version), 'Version already exists in package history');
}

export function tarballUrl(dist, version) {
  const expected = `${REGISTRY}/${PACKAGE}/-/${PACKAGE}-${version}.tgz`;
  assert.equal(dist?.tarball, expected, 'Unexpected tarball origin/path');
  return expected;
}

export function checkPublishedBytes(receipt, versionDocument, tags, bytes) {
  assert.equal(versionDocument.name, receipt.name);
  assert.equal(versionDocument.version, receipt.version);
  assert.equal(tags.latest, receipt.version, 'latest does not point to this release');
  tarballUrl(versionDocument.dist, receipt.version);
  assert.equal(bytes.length, receipt.bytes, 'Published size mismatch');
  assert.equal(sha256(bytes), receipt.sha256, 'Published SHA256 mismatch');
  assert.equal(integrity(bytes), receipt.integrity, 'Published SHA512 mismatch');
  assert.equal(versionDocument.dist.integrity, receipt.integrity, 'Registry integrity differs');
  assert.equal(versionDocument.dist.shasum, sha1(bytes), 'Registry SHA1 differs');
}

export async function checkArtifact(directory, pkg, { expectedSha256, commit } = {}) {
  const receipt = await json(join(directory, 'release.json'));
  assert.equal(receipt.name, pkg.name); assert.equal(receipt.version, pkg.version);
  assert.equal(receipt.filename, `${pkg.name}-${pkg.version}.tgz`);
  assert.equal(basename(receipt.filename), receipt.filename);
  assert.match(receipt.sha256 || '', /^[a-f0-9]{64}$/);
  if (expectedSha256 !== undefined) { assert.match(expectedSha256, /^[a-f0-9]{64}$/); assert.equal(receipt.sha256, expectedSha256); }
  if (commit !== undefined) assert.equal(receipt.commit, commit, 'Artifact came from another commit');
  const file = resolve(directory, receipt.filename), stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Artifact must be a regular file');
  assert.ok(stat.size > 0 && stat.size <= 5 * 1024 * 1024, 'Artifact size out of bounds');
  const bytes = await readFile(file);
  assert.equal(bytes.length, receipt.bytes); assert.equal(sha256(bytes), receipt.sha256); assert.equal(integrity(bytes), receipt.integrity);
  return { file, bytes, receipt };
}

export function checkDryRunResult(status, stderr, alreadyPublished, version) {
  assert.match('v' + version, STABLE_TAG);
  if (!alreadyPublished) { assert.equal(status, 0, 'npm publish dry-run failed'); return 'unpublished-version-dry-run-passed'; }
  assert.equal(status, 1, 'Expected npm to refuse an already published version');
  const expected = `npm error You cannot publish over the previously published versions: ${version}.`;
  const errors = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('npm error '));
  assert.ok(errors.includes(expected), 'Expected immutable-version refusal was not returned');
  assert.ok(errors.every(line => line === expected || line.startsWith('npm error A complete log of this run can be found in: ')), 'Unexpected additional npm error; failing closed');
  return 'existing-version-refusal-verified';
}

export async function outputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const value of Object.values(values)) assert.match(String(value), /^[a-zA-Z0-9._-]+$/, 'Unsafe workflow output');
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k,v]) => `${k}=${v}\n`).join(''));
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const packageDirectory = new URL('..', import.meta.url);
const outputIndex = new URL('../dist/public/index.html', import.meta.url);

function build(environment = {}) {
  const env = Object.fromEntries(
    ['HOME', 'LANG', 'PATH', 'TMPDIR'].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );

  return spawnSync('pnpm', ['run', 'build'], {
    cwd: packageDirectory,
    env: { ...env, ...environment },
    encoding: 'utf8',
  });
}

test('production build succeeds without workflow-only environment variables', () => {
  const result = build();

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('production build prefixes generated asset URLs with BASE_PATH', () => {
  const basePath = '/music-studio-build-check/';
  const result = build({ BASE_PATH: basePath });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = readFileSync(outputIndex, 'utf8');
  const assetUrls = Array.from(
    html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g),
    (match) => match[1],
  );

  assert.ok(assetUrls.length > 0, 'expected generated asset URLs in index.html');
  assert.ok(
    assetUrls.every((url) => url.startsWith(`${basePath}assets/`)),
    `expected every asset URL to start with ${basePath}: ${assetUrls.join(', ')}`,
  );
});

test('production build rejects an explicitly invalid PORT', () => {
  const result = build({ PORT: 'not-a-port' });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0, 'expected the build to reject an invalid PORT');
  assert.match(output, /Invalid PORT value: "not-a-port"/);
});
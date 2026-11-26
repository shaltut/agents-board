// #4415: the deploy image copies some top-level folders, not the repo. PR 11 made cli/agents/codex.ts import kit/guard,
// which the Dockerfile did not copy, and every cb command in the container died at load (ERR_MODULE_NOT_FOUND) while
// the web server stayed healthy. This reads the Dockerfile's COPY lines and checks that every relative import in the
// code the image runs lands in a folder the image has. Pure: no database, no Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** The repo paths the runtime stage copies (COPY <src...> <dest>, not --from=: those come from a build stage). */
function copied(dockerfile: string): string[] {
  const stages = dockerfile.split(/^FROM\s/m);
  const last = stages[stages.length - 1]!;
  return last.split('\n').map((l) => l.trim()).filter((l) => /^COPY\s/i.test(l) && !/--from=/i.test(l))
    .flatMap((l) => l.split(/\s+/).slice(1, -1).filter((w) => !w.startsWith('--')))
    .map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''));
}

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|mjs|js)$/.test(e.name) && !e.parentPath.includes('node_modules'))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)).split(sep).join('/'));
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;

test('the image copies kit, which the CLI imports', () => {
  assert.ok(copied(readFileSync(join(ROOT, 'Dockerfile'), 'utf8')).includes('kit'));
});

test('every relative import in the code the image runs is in a folder the image copies', () => {
  const have = copied(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'));
  const inImage = (p: string) => have.some((c) => p === c || p.startsWith(`${c}/`));
  const ran = ['bin', 'cli', 'db', 'server', 'hooks'].filter(inImage);
  assert.ok(ran.includes('cli') && ran.includes('server'), `the image runs cli and server: COPY lines read as ${have.join(', ')}`);
  const missing: string[] = [];
  for (const dir of ran) {
    for (const f of sources(dir)) {
      for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(IMPORT)) {
        const target = relative(ROOT, resolve(ROOT, dirname(f), m[2]!)).split(sep).join('/');
        if (!inImage(target)) missing.push(`${f} imports ${m[2]} (${target})`);
      }
    }
  }
  assert.deepEqual(missing, [], 'add a COPY line for each folder');
});

test('the COPY reader sees the runtime stage only, and skips --from lines', () => {
  const df = 'FROM node AS web\nCOPY web/ ./\nFROM node\nCOPY package.json pnpm-lock.yaml ./\nCOPY --chown=node:node cli ./cli\nCOPY --from=web /app/web/dist ./web/dist\n';
  assert.deepEqual(copied(df), ['package.json', 'pnpm-lock.yaml', 'cli']);
});

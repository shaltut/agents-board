// #3776: a job owns its slot's worktree, so it can leave a link where a tracked folder was (a junction on Windows).
// checkout --force kept it and clean -ffdx then deleted untracked files inside its target, outside the clone. Before the
// checkout the runner now removes every link in the worktree (the checkout puts tracked ones back), except under
// node_modules (the install's own links; clean leaves node_modules alone). Pure: a temp folder, no git, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropLinks } from '../cli/slot-links.ts';

test('dropLinks removes every link in the worktree but under .git and node_modules, never what they point at', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cb-slot-links-'));
  try {
    const slot = join(tmp, 'slot'), outside = join(tmp, 'outside');
    mkdirSync(join(outside, 'deep'), { recursive: true });
    writeFileSync(join(outside, 'package.json'), '{}'); writeFileSync(join(outside, 'untracked.txt'), 'keep me');
    writeFileSync(join(outside, 'deep', 'f'), 'keep me');
    for (const d of ['.git/refs', 'apps/a/src', 'node_modules/.pnpm', 'apps/a/node_modules']) mkdirSync(join(slot, d), { recursive: true });
    writeFileSync(join(slot, 'apps/a/src/x.ts'), '');
    // a folder link where a tracked package was, a nested one, a file link, a dangling one
    symlinkSync(outside, join(slot, 'apps/b'), 'junction');
    symlinkSync(join(outside, 'deep'), join(slot, 'apps/a/src/deep'), 'junction');
    symlinkSync(join(outside, 'untracked.txt'), join(slot, 'apps/a/file-link'));
    symlinkSync(join(tmp, 'nowhere'), join(slot, 'dangling'));
    // the install's links, and git's own folder, stay
    symlinkSync(join(slot, 'node_modules/.pnpm'), join(slot, 'node_modules/pkg'), 'junction');
    symlinkSync(join(slot, 'node_modules'), join(slot, 'apps/a/node_modules/up'), 'junction');
    symlinkSync(outside, join(slot, '.git/refs/linked'), 'junction');

    const gone = dropLinks(slot).sort();
    assert.deepEqual(gone, ['apps/a/file-link', 'apps/a/src/deep', 'apps/b', 'dangling']);
    for (const p of gone) assert.equal(lstatSync(join(slot, p), { throwIfNoEntry: false }), undefined, p);
    for (const p of ['package.json', 'untracked.txt', 'deep/f']) assert.ok(existsSync(join(outside, p)), `outside ${p} survived`);
    assert.ok(existsSync(join(slot, 'apps/a/src/x.ts')));
    for (const p of ['node_modules/pkg', 'apps/a/node_modules/up', '.git/refs/linked']) assert.ok(lstatSync(join(slot, p)).isSymbolicLink(), p);
    assert.deepEqual(dropLinks(slot), [], 'nothing left to drop');
    assert.deepEqual(dropLinks(join(tmp, 'no-such-slot')), []);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

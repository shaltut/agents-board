// #3776: a job owns its slot's worktree between the runner's git calls, so it can leave a link where a tracked folder
// was (a junction on Windows, which git there walks as a folder). checkout --force kept it, and clean -ffdx then
// deleted untracked files inside its target, outside the clone. Before the checkout the runner removes every link in
// the worktree: the checkout puts the tracked ones (mode 120000) back as git writes them. Not under .git (the runner
// resets what matters there itself) and not under node_modules (the install's own links; the clean keeps node_modules).
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const KEEP = new Set(['.git', 'node_modules']);

/** Remove every link under root (never what it points at) but under .git and node_modules; returns them, relative. */
export function dropLinks(root: string): string[] {
  const gone: string[] = [];
  const dirs = [''];
  while (dirs.length) {
    const rel = dirs.pop()!;
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; } // gone, or not a folder
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      // readdir does not follow links: a link (a junction too) reads as one, so nothing behind it is walked
      if (e.isSymbolicLink()) {
        rmSync(join(root, p), { recursive: true, force: true }); // removes the link, never what it points at
        gone.push(p);
      } else if (e.isDirectory() && !KEEP.has(e.name)) {
        dirs.push(p);
      }
    }
  }
  return gone;
}

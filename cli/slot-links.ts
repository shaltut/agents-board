// #3776: a job owns its slot's worktree between the runner's git calls, so it can leave a link where a tracked folder
// was (a junction on Windows, which git there walks as a folder). checkout --force kept it, and clean -ffdx then
// deleted untracked files inside its target, outside the clone. Before the checkout the runner removes every link in
// the worktree: the checkout puts the tracked ones (mode 120000) back as git writes them. Not under .git and not under
// node_modules (the install's own links; the clean keeps node_modules). A link under .git is the runner's own check
// before the fetch (#4412: it walks .git with an empty keep set). Out of scope here: a process a job left running that
// plants a link again between this walk and the clean, and tracked files under a node_modules folder (a link there is kept).
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const KEEP = new Set(['.git', 'node_modules']);

/** Remove every link under root (never what it points at) but under folders named in keep (.git and node_modules);
 *  returns them, relative. */
export function dropLinks(root: string, keep: ReadonlySet<string> = KEEP): string[] {
  const gone: string[] = [];
  const dirs = [''];
  while (dirs.length) {
    const rel = dirs.pop()!;
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch (e: any) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') continue; // gone, or not a folder
      throw e; // a folder it cannot read may hold a link: fail closed (review M4), the job ends as a runner fault
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      // readdir does not follow links: a link (a junction too) reads as one, so nothing behind it is walked
      if (e.isSymbolicLink()) {
        rmSync(join(root, p), { recursive: true, force: true, maxRetries: 3 }); // the link, never its target; retries ride out an indexer's handle (M5)
        gone.push(p);
      } else if (e.isDirectory() && !keep.has(e.name)) {
        dirs.push(p);
      }
    }
  }
  return gone;
}

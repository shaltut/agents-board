// Live check for Codex, agy and OpenCode seats (#4612), step 1: a scratch repo and the squad file for it. Synthetic only:
// no client data goes near a seat that runs on another provider (agy runs on a personal Google account).
//   node kit/live-check/setup.mjs --dir <new empty folder> --machine <name in the squad file> --board <board checkout>
//     [--herdr <label>] [--workspace <herdr workspace>] [--codex-model <m>] [--agy-model <m>] [--opencode-model <m>]
// It makes <dir> a git repo with a few synthetic files and one commit, writes <dir>.squad.json beside it (never inside
// the repo), and prints the commands that follow. Nothing here starts a seat or writes to the board.
// Where it may go (PR 108 review K1): never inside a git repo (a client's files could reach a seat), and never under a
// root in CB_SCRATCH_DENY unless under one in CB_SCRATCH_ALLOW (each a path list, ; on Windows, : elsewhere). The roots
// are the owner's, set in his terminal, so no name or path of his is in this repo. An existing <dir>.squad.json is never
// overwritten, and a setup that fails removes what it made, parent folders included (K5, r2 R7). Review r2: an unset
// CB_SCRATCH_DENY refuses (R2), any git answer but "not a git repository" refuses (R3/R4: dubious ownership, inside
// .git, no git), and both sides are compared through real paths too, so a junction, link or 8.3 name of a denied root is
// under it (R6).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Explicit models (squad up refuses a model its agent cannot take); change them to what this machine's CLIs offer.
export const DEFAULT_MODELS = Object.freeze({ codex: 'gpt-6.1-sol', agy: 'gemini-3-pro', opencode: 'anthropic/claude-opus-5-5' });
export const PROJECT = 'live-check';

const FILES = {
  'README.md': '# live-check scratch\n\nSynthetic repo for the #4612 live check. No real data.\n',
  'package.json': `${JSON.stringify({ name: 'live-check-scratch', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  'src/add.js': 'export const add = (a, b) => a + b;\n',
  'test/add.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\n\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  // a decoy .env with a value that is not a secret: the secret-read check asks a seat to read it (the guard must refuse)
  '.env': 'SCRATCH_ONLY=not-a-secret\n',
  '.gitignore': '.env\nnode_modules/\n',
};

/** The squad file for the scratch project: the lead stays Claude; builders 1-3 are codex, agy and opencode; reviewer 1
 *  is agy (the read-only role checks). The machine gives the scratch repo and the board checkout. */
export function squadFile({ machine, repo, board, herdr = null, workspace, models = DEFAULT_MODELS }) {
  const m = { ...DEFAULT_MODELS, ...models };
  return {
    roles: {
      lead: { count: 1, model: 'opus', machine },
      builder: { count: 3, model: 'opus', machine, seats: { 1: { agent: 'codex', model: m.codex }, 2: { agent: 'agy', model: m.agy }, 3: { agent: 'opencode', model: m.opencode } } },
      reviewer: { count: 1, model: 'opus', machine, seats: { 1: { agent: 'agy', model: m.agy } } },
    },
    machines: { [machine]: { repo: repo.replace(/\\/g, '/'), board: board.replace(/\\/g, '/'), herdr, ...(workspace ? { workspace } : {}) } },
    areas: [],
    supervise: false,
  };
}

// The repo-locating variables an operator's terminal may export: they would point git at another repo, so a check would
// answer for it and an init, config or commit would write into it (#4683). GIT_CONFIG is git config's default --file, so
// the scratch identity would land in that file instead (#4694). Every git call here runs without them.
const GIT_REPO_VARS = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG)$/i;
const cleanGitEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !GIT_REPO_VARS.test(k)));

function git(dir, args, bin = 'git', env = process.env) {
  const r = spawnSync(bin, ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, env: cleanGitEnv(env) });
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.error?.message || r.stderr || r.stdout || '').trim()}`);
  return r.stdout;
}

const roots = (v) => String(v ?? '').split(delimiter).map((s) => s.trim()).filter(Boolean).map((s) => resolve(s));
const under1 = (p, root, win) => {
  const rel = relative(win ? root.toLowerCase() : root, win ? p.toLowerCase() : p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
// a path as given and through the real path of its nearest existing folder (the rest appended as given)
const forms = (p) => {
  let near = p;
  while (!existsSync(near) && dirname(near) !== near) near = dirname(near);
  try { return [...new Set([p, join(realpathSync.native(near), relative(near, p))])]; } catch { return [p]; }
};
const under = (p, root, win) => forms(p).some((a) => forms(root).some((b) => under1(a, b, win)));

/** Why the scratch repo may not go at dir (K1), or null. A folder that does not exist yet is judged by its nearest
 *  existing parent. */
export function placeProblem(dir, env = process.env, platform = process.platform, gitBin = 'git') {
  const p = resolve(dir), win = platform === 'win32';
  let near = p;
  while (!existsSync(near) && dirname(near) !== near) near = dirname(near);
  // the repo's own variables would answer for another repo
  const gitEnv = cleanGitEnv(env);
  // safe.directory=*: a repo another user owns still answers (r2 R3), instead of failing as if it were none
  const top = spawnSync(gitBin, ['-c', 'safe.directory=*', '-C', near, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, env: gitEnv });
  if (top.error) return `could not ask git whether ${p} is inside a repo (${top.error.code ?? top.error.message}): install git or put it on PATH`;
  if (top.status === 0 && top.stdout.trim()) return `${p} is inside the git repo ${top.stdout.trim()}: make the scratch repo outside any repo, so no other project's files sit where a seat works`;
  if (!/not a git repository/i.test(top.stderr ?? '')) {
    return `git could not say whether ${p} is outside every repo (${String(top.stderr ?? '').trim().split('\n')[0].slice(0, 160) || `exit ${top.status}`}): make the scratch repo in a plain folder outside any repo`;
  }
  const denied = roots(env.CB_SCRATCH_DENY);
  if (!denied.length) return 'CB_SCRATCH_DENY is not set: name the folders that hold client work in it (a path list, ; on Windows), so setup can keep the scratch repo out of them';
  const deny = denied.find((r) => under(p, r, win));
  if (deny && !roots(env.CB_SCRATCH_ALLOW).some((r) => under(p, r, win))) {
    return `${p} is under ${deny}, which CB_SCRATCH_DENY names (client work), and under no root CB_SCRATCH_ALLOW names: make the scratch repo elsewhere`;
  }
  return null;
}

/** Makes the scratch repo and the squad file; returns { repo, squadPath }. Refuses a folder that exists and is not empty,
 *  a place placeProblem refuses, and an existing squad file; on a failure it removes what it made. */
export function setup(o) {
  const repo = resolve(o.dir), env = o.env ?? process.env, bin = o.gitBin ?? 'git';
  for (const k of ['machine', 'board']) if (!o[k]) throw new Error(`--${k} is required`);
  const existed = existsSync(repo);
  if (existed && readdirSync(repo).length) throw new Error(`${repo} is not empty: give a new folder (the scratch repo is made from nothing)`);
  const squadPath = `${repo}.squad.json`;
  if (existsSync(squadPath)) throw new Error(`${squadPath} already exists: remove it or give another folder (setup never overwrites one)`);
  const why = placeProblem(repo, env);
  if (why) throw new Error(why);
  // the highest folder this run makes (r2 R7): a failure removes it, so no empty parents are left
  let made = repo;
  while (!existsSync(dirname(made)) && dirname(made) !== made) made = dirname(made);
  try {
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git(repo, ['init', '-q', '-b', 'main'], bin, env);
    // a scratch identity in this repo only: never the machine's own
    git(repo, ['config', 'user.name', 'Live Check'], bin, env);
    git(repo, ['config', 'user.email', 'live-check@example.invalid'], bin, env);
    git(repo, ['add', '-A'], bin, env);
    git(repo, ['commit', '-q', '-m', 'scratch: synthetic files for the live check'], bin, env);
    writeFileSync(squadPath, `${JSON.stringify(squadFile({ ...o, repo, board: resolve(o.board) }), null, 2)}\n`, { flag: 'wx' });
  } catch (e) {
    // only what this run made: the folder if it made it, else what it wrote into the empty one
    if (existed) for (const f of readdirSync(repo)) rmSync(join(repo, f), { recursive: true, force: true });
    else rmSync(made, { recursive: true, force: true });
    throw e;
  }
  return { repo, squadPath };
}

const isMain = () => { try { return import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href; } catch { return false; } };
if (isMain()) {
  const a = process.argv.slice(2), o = { models: {} };
  for (let i = 0; i < a.length; i++) {
    const v = a[i + 1];
    if (a[i] === '--dir') o.dir = a[++i];
    else if (a[i] === '--machine') o.machine = a[++i];
    else if (a[i] === '--board') o.board = a[++i];
    else if (a[i] === '--herdr') o.herdr = a[++i];
    else if (a[i] === '--workspace') o.workspace = a[++i];
    else if (/^--(codex|agy|opencode)-model$/.test(a[i]) && v) { o.models[a[i].slice(2, -6)] = v; i++; }
    else { console.error(`unknown argument ${a[i]}`); process.exit(2); }
  }
  if (!o.dir || !o.machine || !o.board) {
    console.error('usage: node kit/live-check/setup.mjs --dir <new folder> --machine <name> --board <board checkout> [--herdr <label>] [--workspace <ws>] [--codex-model m] [--agy-model m] [--opencode-model m]');
    process.exit(2);
  }
  try {
    const r = setup(o);
    console.log(`scratch repo: ${r.repo}\nsquad file:   ${r.squadPath}\n`);
    console.log('Next (see kit/live-check/README.md; the installs come first):');
    console.log(`  cb add ${PROJECT} "Live check: Codex, agy and OpenCode seats (#4612)" -s in_progress -p P1   # creates the project`);
    console.log(`  cb squad set ${PROJECT} -f "${r.squadPath}"                                                   # Ahmed or the lead`);
    console.log(`  cb squad trust ${PROJECT}                                                                        # Ahmed, own terminal`);
    console.log(`  node kit/live-check/check.mjs --guard ~/.claude-board/guard --seat "${r.repo}"                  # part A, no seat starts`);
    console.log('\nAfterwards (K4): close the seats, then remove the scratch folder, its squad file and report:');
    console.log(`  "${r.repo}", "${r.squadPath}", "${r.repo}.live-check.md"   (and archive the ${PROJECT} project, or keep it for the next check)`);
  } catch (e) {
    console.error(`setup failed: ${e?.message ?? e}`);
    process.exit(1);
  }
}

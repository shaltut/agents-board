// Live check for Codex, agy and OpenCode seats (#4612), step 1: a scratch repo and the squad file for it. Synthetic only:
// no client data goes near a seat that runs on another provider (agy runs on a personal Google account).
//   node kit/live-check/setup.mjs --dir <new empty folder> --machine <name in the squad file> --board <board checkout>
//     [--herdr <label>] [--workspace <herdr workspace>] [--codex-model <m>] [--agy-model <m>] [--opencode-model <m>]
// It makes <dir> a git repo with a few synthetic files and one commit, writes <dir>.squad.json beside it (never inside
// the repo), and prints the commands that follow. Nothing here starts a seat or writes to the board.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
}

/** Makes the scratch repo and the squad file; returns { repo, squadPath }. Refuses a folder that exists and is not empty. */
export function setup(o) {
  const repo = resolve(o.dir);
  if (existsSync(repo) && readdirSync(repo).length) throw new Error(`${repo} is not empty: give a new folder (the scratch repo is made from nothing)`);
  for (const k of ['machine', 'board']) if (!o[k]) throw new Error(`--${k} is required`);
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'init', '-q', '-b', 'main');
  // a scratch identity in this repo only: never the machine's own
  git(repo, 'config', 'user.name', 'Live Check');
  git(repo, 'config', 'user.email', 'live-check@example.invalid');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'scratch: synthetic files for the live check');
  const squadPath = `${repo}.squad.json`;
  writeFileSync(squadPath, `${JSON.stringify(squadFile({ ...o, repo, board: resolve(o.board) }), null, 2)}\n`);
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
  } catch (e) {
    console.error(`setup failed: ${e?.message ?? e}`);
    process.exit(1);
  }
}

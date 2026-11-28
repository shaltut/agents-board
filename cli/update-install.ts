// cb update and cb update --rollback (#4352 slice 3): install the release the board serves on a copy (the Mac's), and
// go back to the version before it.
//
// Layout. The copy's path stays what hooks, PATH and herdr use; the first update turns it into a link:
//   <copy>                     -> link (symlink on macOS, junction on Windows) to the version in use
//   <copy>.home/               the copy as it was (its node_modules, package.json, pnpm-lock.yaml, .env stay here)
//   <copy>.home/versions/<sha> one release, the 7 folders only, written from the verified archive
//   <copy>.home/versions/state.json {current, previous}: what --rollback flips back to ("original" = <copy>.home)
// A version finds <copy>.home/node_modules and package.json by Node's upward lookup, and its .env through
// server/db.ts: nothing is linked, copied or installed into a version, and node_modules is never touched.
//
// The safe point. A flip swaps one link (an atomic rename on macOS; unlink then rename on Windows, a gap of
// microseconds). New cb calls run the new code at once. A running process keeps the modules it loaded, and the
// version it loaded them from stays (no version is ever deleted here), so it carries on unchanged: relays notice
// their code path now points at new files and restart themselves into it (cli/started-as.ts); a runner or supervisor
// running from the copy would not, so the update refuses while one runs (--force goes ahead and leaves it on the old
// code until it is restarted by its pid). Nothing is killed, ever, and never by name.
// A git checkout (the PC) is refused: git pull --ff-only updates it.
// The schema gate. Before anything is written, the board's database must have the schema the release needs (the
// sha256 of its db/schema.sql, cb.schema_covers): otherwise the new cb would call functions the board lacks.
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { compareManifest, type Manifest } from './release.ts';
import { LOCKFILE, lockfileSha } from './release-archive.ts';
import { boardBase, fetchRelease, needAddress } from './update.ts';
import { call } from './board.ts';

const win = process.platform === 'win32';
const short = (s: string) => s.slice(0, 7);

export type Layout = { live: string; home: string; versions: string; state: string; lock: string };
export function layout(root: string): Layout {
  const live = resolve(root);
  const home = `${live}.home`;
  return { live, home, versions: join(home, 'versions'), state: join(home, 'versions', 'state.json'), lock: `${live}.update.lock` };
}
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
const same = (a: string | null, b: string | null) => !!a && !!b && (win ? a.toLowerCase() === b.toLowerCase() : a === b);
const targetOf = (L: Layout, id: string) => (id === 'original' ? L.home : join(L.versions, id));

/** The version the copy's link points at: a sha, "original" (the copy as it was), or null when it is no link of ours. */
export function currentId(L: Layout): string | null {
  if (!isLink(L.live)) return null;
  const r = real(L.live);
  if (same(r, real(L.home))) return 'original';
  return r && same(dirname(r), real(L.versions)) ? basename(r) : null;
}
function readState(L: Layout): { current: string; previous: string | null } | null {
  try { const s = JSON.parse(readFileSync(L.state, 'utf8')); return typeof s?.current === 'string' ? s : null; } catch { return null; }
}

/** Refuses what cb update must not change: a git checkout, a folder that is no cb copy, a link it did not make.
 *  Finishes an update cut off while the copy's path was missing (between adopt's rename and its link, or a Windows
 *  flip's unlink and rename): the path is linked again to what state.json says is in use, else the original copy.
 *  Returns what it did. */
function preflight(L: Layout): string[] {
  // a copy's .home (cb started as <copy>.home/cli/cb.ts, the way back when the copy's path is gone) is never a root:
  // adopting it would move the copy's real folder and leave its path pointing nowhere
  if (!isLink(L.live) && (basename(L.live).endsWith('.home') || existsSync(join(L.live, 'versions')))) {
    const copy = L.live.endsWith('.home') ? L.live.slice(0, -'.home'.length) : `${L.live} (the copy's own path)`;
    throw new Error(`${L.live} holds a copy's installed releases, it is not a copy: run cb update --root ${copy}`);
  }
  if (!isLink(L.live) && !existsSync(L.live) && existsSync(join(L.home, 'cli', 'cb.ts'))) {
    takeLock(L);
    try {
      if (isLink(L.live) || existsSync(L.live)) return []; // another run repaired it meanwhile
      const st = readState(L);
      const to = st && existsSync(targetOf(L, st.current)) ? targetOf(L, st.current) : L.home;
      symlinkSync(to, L.live, 'junction');
      return [`repaired: ${L.live} was missing (an earlier cb update was cut off); it links to ${to} again. `
        + `When the path is gone, cb cannot start from it: node ${join(L.home, 'cli', 'cb.ts')} update --root ${L.live}`];
    } finally { dropLock(L); }
  }
  if (!isLink(L.live)) {
    if (!existsSync(L.live)) throw new Error(`no cb copy at ${L.live}: pass --root <the copy's folder>`);
    if (existsSync(join(L.live, '.git'))) throw new Error(`${L.live} is a git checkout: update it with git pull --ff-only (cb update installs releases on copies, such as the Mac's)`);
    if (!existsSync(join(L.live, 'cli', 'cb.ts'))) throw new Error(`${L.live} is not a cb copy (no cli/cb.ts)`);
    if (basename(dirname(L.live)) === 'versions') throw new Error(`${L.live} is an installed version: run cb update on the copy's own folder`);
    if (existsSync(L.home)) throw new Error(`${L.home} exists but ${L.live} is not a link to it: something was moved by hand; put it back by hand first`);
    return [];
  }
  if (currentId(L) === null) throw new Error(`${L.live} is a link, but not to ${L.home} or one of its versions: leave it alone and ask the lead`);
  return [];
}

export type Proc = { pid: number; cmd: string };
/** Every process with its command line (ps; on Windows, CIM through PowerShell). Reads only. */
export function processes(): Proc[] {
  const r = win
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    : spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`cannot list processes (${String(r.stderr || r.error?.message || '').trim().slice(0, 200)})`);
  return r.stdout.split(/\r?\n/).map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m![1]), cmd: m![2]! }));
}
/** The folder in `lsof -a -p <pid> -d cwd -Fn` output (its n line), or null. */
export function lsofCwd(out: string): string | null {
  const n = out.split(/\r?\n/).find((l) => l.startsWith('n/'));
  return n ? n.slice(1) : null;
}
/** A process's working folder (/proc on Linux, lsof on macOS), or null when it cannot be read: another user's
 *  process, no lsof, or Windows, which does not show another process's folder. Reads only. */
export function cwdOf(pid: number): string | null {
  if (win) return null;
  if (process.platform === 'linux') { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }
  const r = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 10_000 });
  return typeof r.stdout === 'string' ? lsofCwd(r.stdout) : null;
}
/** The processes running code from this copy, by kind: relays restart themselves; a runner or supervisor does not.
 *  A runner or supervisor started by a relative path (node cli/cb.ts runner) names no folder in its command line: it
 *  counts when its working folder is the copy (or one of its versions; #4572), not when it is another checkout. One
 *  whose folder cannot be read is `unsure`: it may be this copy's. */
export function runningFrom(L: Layout, procs: Proc[], folderOf: (pid: number) => string | null = cwdOf) {
  const norm = (s: string) => (win ? s.replace(/\\/g, '/').toLowerCase() : s);
  const roots = [...new Set([L.live, L.home, real(L.live), real(L.home)].filter((r): r is string => !!r).map((r) => norm(r) + '/'))];
  const mine = new Set([process.pid, process.ppid]);
  const DAEMON = /(^|[\s"'/])cli\/(runner|supervise)\.ts\b|(^|[\s"'/])(cli\/cb\.ts|bin\/cb)["']?\s+(runner|supervise)\b/;
  const RELATIVE = /(?:^|[\s"'])((?:\.\/)?(?:cli|bin)\/(?:runner\.ts|supervise\.ts|cb\.ts|cb))["']?(?:\s|$)/;
  const kind = (c: string) => /\/cli\/relay\.ts\b/.test(norm(c)) ? 'relay' : DAEMON.test(norm(c)) ? 'daemon' : 'other';
  const unsure: Proc[] = [];
  const ours = procs.filter((p) => {
    if (mine.has(p.pid)) return false;
    if (roots.some((r) => norm(p.cmd).includes(r))) return true;
    const rel = kind(p.cmd) === 'daemon' ? RELATIVE.exec(norm(p.cmd))?.[1] : undefined;
    if (!rel) return false;
    const dir = folderOf(p.pid);
    if (!dir) { unsure.push(p); return false; }
    return roots.some((r) => norm(resolve(dir, rel)).startsWith(r));
  });
  return { relays: ours.filter((p) => kind(p.cmd) === 'relay'), daemons: ours.filter((p) => kind(p.cmd) === 'daemon'), others: ours.filter((p) => kind(p.cmd) === 'other'), unsure };
}
const unsureSay = (run: ReturnType<typeof runningFrom>) => `pid ${run.unsure.map((p) => p.pid).join(', ')} runs a runner or supervisor by a relative path `
  + `and its working folder could not be read${win ? ' (Windows does not show it)' : ''}: it may be this copy's or another checkout's`;
function refuseDaemons(run: ReturnType<typeof runningFrom>, force: boolean) {
  if (force) return;
  if (run.daemons.length) throw new Error(`the runner or supervisor runs from this copy (pid ${run.daemons.map((p) => p.pid).join(', ')}) and would stay on the old code: `
    + 'stop it by its pid (never by name), update, then start it again; or pass --force (it keeps the old code until it restarts)');
  if (run.unsure.length) throw new Error(`${unsureSay(run)}. If it is this copy's it would stay on the old code: stop it by its pid (never by name), `
    + 'update, then start it again; if it is not, pass --force');
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } };
/** One cb update at a time per copy (a lock file beside it); a lock whose pid is gone is taken over. */
function takeLock(L: Layout) {
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(L.lock, 'wx'); writeSync(fd, String(process.pid)); closeSync(fd); return; } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      let held = '';
      try { held = readFileSync(L.lock, 'utf8'); } catch { continue; } // released meanwhile: try again
      const pid = Number(held) || 0;
      if (pid && alive(pid)) throw new Error(`another cb update is running on this copy (pid ${pid}); if it is not, delete ${L.lock}`);
      // a dead pid's lock: moved aside atomically, so of two takers only one gets it; one that moved a lock taken
      // meanwhile by a live update puts it back and stops
      const aside = `${L.lock}.stale-${process.pid}`;
      try { renameSync(L.lock, aside); } catch { continue; }
      const moved = readFileSync(aside, 'utf8');
      if (moved !== held) {
        try { if (!existsSync(L.lock)) renameSync(aside, L.lock); } catch {}
        throw new Error(`another cb update took ${L.lock} just now (pid ${Number(moved) || '?'})`);
      }
      unlinkSync(aside);
    }
  }
  throw new Error(`cannot take ${L.lock}`);
}

/** What a cut-off earlier run left: its staging folder and (Windows) its spare link. Only a dead pid's. */
function cleanLeftovers(L: Layout): string[] {
  const out: string[] = [];
  const pidOf = (name: string) => Number(/-(\d+)$/.exec(name)?.[1]) || 0;
  try {
    for (const d of readdirSync(L.versions)) {
      const pid = pidOf(d);
      if (d.startsWith('.staging-') && pid && pid !== process.pid && !alive(pid)) { rmSync(join(L.versions, d), { recursive: true, force: true }); out.push(d); }
    }
  } catch {}
  try {
    for (const d of readdirSync(dirname(L.live))) {
      const pid = pidOf(d), f = join(dirname(L.live), d);
      if (d.startsWith(`${basename(L.live)}.flip-`) && pid && pid !== process.pid && !alive(pid) && isLink(f)) { unlinkSync(f); out.push(d); }
      if (d.startsWith(`${basename(L.lock)}.stale-`) && pid && pid !== process.pid && !alive(pid) && !isLink(f)) { unlinkSync(f); out.push(d); }
    }
  } catch {}
  return out.length ? [`cleaned: ${out.join(', ')} (left by a cut-off run)`] : [];
}
const dropLock = (L: Layout) => { try { if (Number(readFileSync(L.lock, 'utf8')) === process.pid) unlinkSync(L.lock); } catch {} };

/** A link under node_modules that names the copy's own path absolutely, or null. pnpm on Windows makes its links
 *  junctions with absolute targets; once the copy moves to .home they would point through the copy's path at a
 *  version, which has no node_modules. pnpm on macOS and Linux links relatively, which survives the move. */
export function linkThroughCopy(nodeModules: string, live: string): string | null {
  const norm = (s: string) => { s = s.replace(/^\\\\\?\\/, ''); return win ? s.replace(/\\/g, '/').toLowerCase() : s; };
  const prefix = norm(live) + '/';
  const walk = (d: string): string | null => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const f = join(d, e.name);
      if (e.isSymbolicLink()) {
        let t: string;
        try { t = readlinkSync(f); } catch { continue; }
        if (isAbsolute(t) && (norm(t) + '/').startsWith(prefix)) return f;
      } else if (e.isDirectory()) { const r = walk(f); if (r) return r; }
    }
    return null;
  };
  return walk(nodeModules);
}

/** First update: the copy moves to <copy>.home and its path becomes a link to it, the same code as before. The path
 *  is never left missing for longer than the rename and the link; a failed link puts the folder back. */
function adopt(L: Layout) {
  try { renameSync(L.live, L.home); } catch (e: any) {
    throw new Error(`cannot move ${L.live} to ${L.home} (${e?.code ?? e?.message}): on Windows a process with files or its working folder there blocks it; stop it and try again`);
  }
  try { symlinkSync(L.home, L.live, 'junction'); } catch (e: any) {
    renameSync(L.home, L.live);
    throw new Error(`cannot link ${L.live} (${e?.code ?? e?.message}); the copy is back as it was`);
  }
  mkdirSync(L.versions, { recursive: true });
}

/** Points the copy's path at `to`: a new link renamed over the old one (macOS: atomic); Windows cannot rename over a
 *  junction, so it unlinks first, and puts the old link back if the rename fails. */
function flip(L: Layout, to: string) {
  const tmp = `${L.live}.flip-${process.pid}`;
  if (isLink(tmp)) unlinkSync(tmp);
  symlinkSync(to, tmp, 'junction'); // the type is ignored off Windows: a directory symlink
  if (!win) { renameSync(tmp, L.live); return; }
  const old = readlinkSync(L.live);
  unlinkSync(L.live);
  try { renameSync(tmp, L.live); } catch (e) {
    try { symlinkSync(old, L.live, 'junction'); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

const PROBES = [['cli/cb.ts', 'help'], ['cli/cb.ts', 'sessions'], ['cli/relay.ts']];
const probeName = (p: string[]) => (p[0] === 'cli/cb.ts' ? `cb ${p.slice(1).join(' ')}` : `node ${p.join(' ')}`);

/** Writes the release into a staging folder, verifies it file by file, and runs the probes from it. */
function stage(L: Layout, m: Manifest, files: Map<string, Buffer>, env: NodeJS.ProcessEnv) {
  const dir = join(L.versions, `.staging-${short(m.sha)}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true }); // holds only written files: no link is ever made inside a version
  try {
    for (const [p, body] of files) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body); }
    if (existsSync(join(dir, 'bin', 'cb'))) chmodSync(join(dir, 'bin', 'cb'), 0o755); // git keeps it 644
    const d = compareManifest(dir, m);
    const off = [...d.missing, ...d.changed, ...d.extra, ...d.outside];
    if (off.length) throw new Error(`the staged files do not match the release: ${off.slice(0, 5).join(', ')}`);
    // the new code loads (every module cb.ts imports) and reads the live board (its schema answers the new code); the
    // relay loads every module it imports and exits before connecting (no pane): a relay that cannot load would die at
    // import on every seat once the flip restarts them
    for (const [file, ...args] of PROBES) {
      const r = spawnSync(process.execPath, [join(dir, file!), ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000, windowsHide: true,
        env: { ...env, HERDR_PANE_ID: '', CB_ACTOR: env.CB_ACTOR || 'cb-update@probe', CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '' } });
      if (r.status !== 0) throw new Error(`the new code failed its probe ${probeName([file!, ...args])} (exit ${r.status}): ${String(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
    }
    return dir;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** What the board's database says of a schema (cb.schema_check): covers, whether it has it; null when it cannot say
 *  (a board from before the gate); current, the schema it runs. */
export type SchemaAnswer = { covers: boolean | null; current: string | null };
/** Asks the database this cb uses (the board's) about the schema `need` (a sha256 of db/schema.sql). */
export async function askSchema(sql: any, need: string): Promise<SchemaAnswer> {
  try {
    const r = await call('schema_check', { need }, sql);
    return { covers: !!r.covers, current: r.current ?? null };
  } catch (e: any) {
    if (e?.code === '42883') return { covers: null, current: null }; // undefined_function: the board predates the gate
    throw new Error(`cannot read the board's schema (${e?.code ?? e?.message ?? e}): cb update checks it before installing; try again when the board answers`);
  }
}

/** Refuses, writing nothing, a release whose schema (the sha256 of its db/schema.sql) the board's database does not
 *  have: the new cb would call functions the board does not have yet. Schema before code (CLAUDE.md, Releasing). */
async function schemaGate(m: Manifest, ask: (need: string) => Promise<SchemaAnswer>) {
  const need = m.files['db/schema.sql'];
  if (!need) return; // a release with no schema needs none
  const a = await ask(need);
  const deploy = `deploy release ${short(m.sha)} to the board first (docs/ops/maintain.md, Upgrade: the board and its schema go first), then cb update again`;
  if (a.covers === null) throw new Error(`the board's database does not say which schema it runs (it runs a board from before cb update's schema check): ${deploy}`);
  if (!a.covers) throw new Error(`the board's database runs an older schema than release ${short(m.sha)} needs `
    + `(the release's db/schema.sql ${need.slice(0, 8)}, the board's ${a.current ? a.current.slice(0, 8) : 'unknown'}): ${deploy}`);
}

export async function install(o: { root: string; from: string; force?: boolean; procs?: () => Proc[]; env?: NodeJS.ProcessEnv; timeoutMs?: number;
  schema: (need: string) => Promise<SchemaAnswer> }) {
  const L = layout(o.root);
  const repaired = preflight(L);
  const base = boardBase(needAddress(o.from));
  const f = await fetchRelease(base, o.timeoutMs);
  const m = f.manifest;
  if (f.archiveProblem || !f.files) throw new Error(`the release ${short(m.sha)} from ${base} is not usable: ${f.archiveProblem}. Tell the lead (cb tell)`);
  const lines = [...repaired, `release: ${short(m.sha)} from ${base} (${Object.keys(m.files).length} files; archive verified)`];
  const was = currentId(L) ?? 'original';
  if (was === m.sha) {
    // a run cut off between its flip and its note leaves state.json behind the link: settle it, so --rollback works
    const st = readState(L);
    if (st?.current !== m.sha) {
      const previous = st && st.current !== m.sha && existsSync(targetOf(L, st.current)) ? st.current : 'original';
      takeLock(L);
      try { writeFileSync(L.state, JSON.stringify({ current: m.sha, previous }, null, 2) + '\n'); } finally { dropLock(L); }
      lines.push(`settled: ${L.state} now says ${short(m.sha)} is in use (back: ${previous === 'original' ? 'the original copy' : short(previous)})`);
    }
    return { ok: true, lines: [...lines, `update: already on ${short(m.sha)}`], json: { ok: true, release: m.sha, current: m.sha, changed: false } };
  }

  await schemaGate(m, o.schema);

  // packages: reused from the copy when the lockfile is the same; never installed or touched here
  const want = f.served?.deps?.[LOCKFILE];
  if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want))
    throw new Error(`the board at ${base} does not say which ${LOCKFILE} its release runs with (it runs an older board): update the board first, then cb update again`);
  const homeDir = isLink(L.live) ? L.home : L.live; // before the first update, the copy itself
  const have = lockfileSha(homeDir);
  if (have !== want)
    throw new Error(`the release needs other packages (its ${LOCKFILE} ${short(want)}, this copy's ${have ? short(have) : 'missing'}): cb update reuses this copy's node_modules and never installs packages. `
      + `Update package.json, ${LOCKFILE} and node_modules in ${homeDir} as docs/ops/maintain.md (Upgrade) says, then cb update again`);
  if (!existsSync(join(homeDir, 'node_modules'))) throw new Error(`${homeDir} has no node_modules: install the packages there first (pnpm install --frozen-lockfile)`);
  const through = isLink(L.live) ? null : linkThroughCopy(join(homeDir, 'node_modules'), L.live);
  if (through) throw new Error(`this copy's packages link to it by its absolute path (${through}; pnpm does this on Windows): moving the copy to ${L.home} would break them. `
    + 'Install them without links first (pnpm install --frozen-lockfile --config.node-linker=hoisted), then cb update again');

  const run = runningFrom(L, (o.procs ?? processes)());
  refuseDaemons(run, !!o.force);
  takeLock(L);
  try {
    lines.push(...cleanLeftovers(L));
    const adopted = !isLink(L.live);
    if (adopted) { adopt(L); lines.push(`adopted: ${L.live} is now a link to ${L.home}, the copy as it was (nothing in it changed)`); }
    lines.push(`packages: ${L.home}/node_modules reused (${LOCKFILE} unchanged, ${short(want)})`);
    const dir = stage(L, m, f.files, o.env ?? process.env);
    const to = join(L.versions, m.sha);
    if (existsSync(to)) renameSync(to, `${to}.replaced-${Date.now()}`); // an earlier install of the same release: kept aside, never deleted
    renameSync(dir, to);
    lines.push(`staged: ${to} (${Object.keys(m.files).length} files verified, bin/cb executable); probes passed: ${PROBES.map(probeName).join(', ')}`);
    flip(L, to);
    writeFileSync(L.state, JSON.stringify({ current: m.sha, previous: was }, null, 2) + '\n');
    lines.push(`flipped: ${L.live} -> ${to} (was ${was === 'original' ? 'the original copy' : short(was)}). Back: cb update --rollback`);
    lines.push(...after(run));
    return { ok: true, lines, json: { ok: true, release: m.sha, current: m.sha, previous: was, changed: true, adopted, packages: 'reused',
      relays: run.relays.map((p) => p.pid), daemons: run.daemons.map((p) => p.pid) } };
  } finally { dropLock(L); }
}

/** What the processes running from the copy do now (nothing is stopped). */
function after(run: ReturnType<typeof runningFrom>) {
  const out: string[] = [];
  if (run.relays.length) out.push(`relays: ${run.relays.length} running from this copy restart themselves into the new code within seconds (one that does not: cb relay --restart in its pane)`);
  if (run.daemons.length) out.push(`runner/supervisor: pid ${run.daemons.map((p) => p.pid).join(', ')} still run the old code: restart each by its pid (never by name)`);
  if (run.unsure.length) out.push(`runner/supervisor: ${unsureSay(run)}; if it is this copy's, restart it by its pid (never by name)`);
  return out;
}

export function rollback(o: { root: string; force?: boolean; procs?: () => Proc[] }) {
  const L = layout(o.root);
  const repaired = preflight(L);
  if (!isLink(L.live)) throw new Error(`nothing to roll back: ${L.live} is not a link (cb update has not installed a release here)`);
  const st = readState(L);
  const now = currentId(L)!;
  if (!st?.previous) throw new Error(`no previous version recorded in ${L.state}`);
  if (st.current !== now) throw new Error(`${L.state} says ${st.current} is in use, but ${L.live} points at ${now} (an update stopped between its flip and its note): `
    + 'run cb update again to settle it, or point the link by hand');
  const to = targetOf(L, st.previous);
  if (!existsSync(to)) throw new Error(`the previous version is gone (${to})`);
  const run = runningFrom(L, (o.procs ?? processes)());
  refuseDaemons(run, !!o.force);
  takeLock(L);
  try {
    flip(L, to);
    writeFileSync(L.state, JSON.stringify({ current: st.previous, previous: now }, null, 2) + '\n');
    const name = (id: string) => (id === 'original' ? 'the original copy' : short(id));
    const lines = [...repaired, `rolled back: ${L.live} -> ${to} (${name(st.previous)}; was ${name(now)}). Again: cb update --rollback`, ...after(run)];
    // the original copy's relay.ts predates started-as.ts: relays that restart into it watch its real folder, so the
    // next flip does not restart them
    if (st.previous === 'original') lines.push('relays: the original copy\'s relays do not follow later flips: after the next cb update, run cb relay --restart in each pane');
    return { ok: true, lines, json: { ok: true, current: st.previous, previous: now, relays: run.relays.map((p) => p.pid), daemons: run.daemons.map((p) => p.pid) } };
  } finally { dropLock(L); }
}

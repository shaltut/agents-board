// Runner recipes: load and validate runner.json, check job parameters, build argv/cwd/env. Pure: no DB, no spawn.
import { resolve, sep } from 'node:path';

export type Param = { pattern: string; min: number; max: number };
export type Recipe = { steps: string[][]; finally: string[][]; cwd: string; env: Record<string, string>; timeout: number; db: boolean; params: Record<string, Param> };
export type Repo = { git: string; lockfile: string; install: string[]; installTimeout: number; recipes: Record<string, Recipe> };
// a flat project in runner.json (git, lockfile, ... at its top) is one repo, main (#3703)
export type Project = { base: string; repos: Record<string, Repo> };
export type RunnerConfig = { name?: string; slots: number; dbLanes: number; log: { host: string; port: number; peers: string[] }; passEnv: string[]; projects: Record<string, Project> };

const NAME = /^[a-z][a-z0-9-]*$/;
const SLOT = /\{([^{}]*)\}/g;
const VALUE = /^[A-Za-z0-9@._/-]{1,200}$/;
const MAX_VALUES = 20;
const LANE = '{lane}'; // a DB recipe's env names its lane: two DB jobs at once each get their own test stack and ports
const BASE_ENV = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'VOLTA_HOME'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const slotsOf = (s: string) => [...s.matchAll(SLOT)].map((m) => m[1]!);

function fail(path: string, why: string): never {
  throw new Error(`${path}: ${why}`);
}
// a misspelled key (`finaly`, `dbb`) would silently change what runs: refuse it
function only(o: Record<string, unknown>, path: string, allowed: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(path, `unknown key "${k}"`);
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v) fail(path, 'must be a non-empty string');
  return v;
}
function int(v: unknown, path: string, lo: number, hi: number, dflt?: number): number {
  if (v === undefined && dflt !== undefined) return dflt;
  if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) fail(path, `must be an integer ${lo}-${hi}`);
  return v as number;
}
function strList(v: unknown, path: string, dflt?: string[]): string[] {
  if (v === undefined && dflt) return dflt;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(path, 'must be a list of strings');
  return v as string[];
}
function argvList(v: unknown, path: string, params: Record<string, Param>, required: boolean): string[][] {
  if (v === undefined && !required) return [];
  if (!Array.isArray(v) || (required && !v.length)) fail(path, 'must be a list of argv lists');
  return v.map((argv, i) => {
    const p = `${path}[${i}]`;
    if (!Array.isArray(argv) || !argv.length || argv.some((x) => typeof x !== 'string' || !x)) fail(p, 'must be a non-empty list of strings');
    for (const el of argv as string[]) {
      const names = slotsOf(el);
      if (names.length > 1) fail(p, `"${el}" holds more than one slot`);
      for (const n of names) if (!Object.hasOwn(params, n)) fail(p, `unknown parameter {${n}}`);
    }
    return argv as string[];
  });
}

function loadRecipe(raw: unknown, path: string, dbLanes: number): Recipe {
  if (!isObj(raw)) fail(path, 'must be an object');
  only(raw, path, ['params', 'cwd', 'steps', 'finally', 'env', 'timeout', 'db']);
  const params: Record<string, Param> = {};
  if (raw.params !== undefined && !isObj(raw.params)) fail(`${path}.params`, 'must be an object');
  for (const [n, pr] of Object.entries(raw.params ?? {})) {
    const pp = `${path}.params.${n}`;
    if (!NAME.test(n)) fail(`${path}.params`, `name "${n}" must match ${NAME}`);
    if (!isObj(pr)) fail(pp, 'must be an object');
    only(pr, pp, ['pattern', 'min', 'max']);
    const pattern = str(pr.pattern, `${pp}.pattern`);
    try { new RegExp(pattern); } catch { fail(`${pp}.pattern`, 'does not compile'); }
    const min = int(pr.min, `${pp}.min`, 0, MAX_VALUES, 1);
    const max = int(pr.max, `${pp}.max`, 1, MAX_VALUES, 1);
    if (min > max) fail(pp, 'min is above max');
    params[n] = { pattern, min, max };
  }
  const cwd = raw.cwd === undefined ? '.' : str(raw.cwd, `${path}.cwd`);
  for (const n of slotsOf(cwd)) {
    if (!Object.hasOwn(params, n)) fail(`${path}.cwd`, `unknown parameter {${n}}`);
    if (params[n]!.max !== 1) fail(`${path}.cwd`, `{${n}} is a list parameter; cwd may use only max 1`);
    if (params[n]!.min < 1) fail(`${path}.cwd`, `{${n}} may be left out; cwd may use only min 1`);
  }
  const env = raw.env ?? {};
  if (!isObj(env) || Object.values(env).some((x) => typeof x !== 'string')) fail(`${path}.env`, 'must be an object of strings');
  if (raw.db !== undefined && typeof raw.db !== 'boolean') fail(`${path}.db`, 'must be true or false');
  const lane = Object.values(env).some((x) => (x as string).includes(LANE));
  if (lane && raw.db !== true) fail(`${path}.env`, `${LANE} is for DB recipes only`);
  if (!lane && raw.db === true && dbLanes > 1) fail(`${path}.env`, `needs ${LANE} in a value (the test stack's name and ports): dbLanes is ${dbLanes}, and two DB jobs at once must not share a stack`);
  return {
    steps: argvList(raw.steps, `${path}.steps`, params, true),
    finally: argvList(raw.finally, `${path}.finally`, params, false),
    cwd, env: env as Record<string, string>,
    timeout: int(raw.timeout, `${path}.timeout`, 1, 7200),
    db: raw.db === true, params,
  };
}

function loadRepo(p: Record<string, unknown>, pp: string, dbLanes: number): Repo {
  if (!isObj(p.recipes)) fail(pp, 'needs a recipes object');
  if (!Array.isArray(p.install) || !p.install.length || p.install.some((x) => typeof x !== 'string' || !x)) fail(`${pp}.install`, 'must be a non-empty list of strings');
  const recipes: Record<string, Recipe> = {};
  for (const [rn, r] of Object.entries(p.recipes)) {
    if (!NAME.test(rn)) fail(`${pp}.recipes`, `name "${rn}" must match ${NAME}`);
    recipes[rn] = loadRecipe(r, `${pp}.recipes.${rn}`, dbLanes);
  }
  return {
    git: str(p.git, `${pp}.git`), lockfile: str(p.lockfile, `${pp}.lockfile`),
    install: p.install as string[], installTimeout: int(p.installTimeout, `${pp}.installTimeout`, 1, 7200), recipes,
  };
}

export function loadConfig(text: string): RunnerConfig {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`runner.json: not valid JSON (${(e as Error).message})`); }
  if (!isObj(raw)) fail('runner.json', 'must be an object');
  only(raw, 'runner.json', ['name', 'slots', 'dbLanes', 'log', 'passEnv', 'projects']);
  if (!isObj(raw.log)) fail('log', 'is required: { host, port, peers }');
  only(raw.log, 'log', ['host', 'port', 'peers']);
  const log = { host: str(raw.log.host, 'log.host'), port: int(raw.log.port, 'log.port', 1, 65535), peers: strList(raw.log.peers, 'log.peers') };
  const slots = int(raw.slots, 'slots', 1, 10, 2);
  // DB jobs at once, each in its own lane 1-9 (a single digit, so a port can be written "5543{lane}")
  const dbLanes = int(raw.dbLanes, 'dbLanes', 1, 9, 1);
  if (dbLanes > slots) fail('dbLanes', `is above slots (${slots})`);
  if (!isObj(raw.projects) || !Object.keys(raw.projects).length) fail('projects', 'must hold at least one project');
  const projects: Record<string, Project> = {};
  const stems = new Map<string, string>();
  for (const [pn, p] of Object.entries(raw.projects)) {
    const pp = `projects.${pn}`;
    if (!NAME.test(pn)) fail('projects', `name "${pn}" must match ${NAME}`);
    if (!isObj(p)) fail(pp, 'must be an object');
    const repos: Record<string, Repo> = {};
    if (p.repos === undefined) {
      only(p, pp, ['git', 'base', 'lockfile', 'install', 'installTimeout', 'recipes']);
      repos.main = loadRepo(p, pp, dbLanes);
    } else {
      only(p, pp, ['base', 'repos']);
      if (!isObj(p.repos) || !Object.keys(p.repos).length) fail(`${pp}.repos`, 'must hold at least one repo');
      for (const [rn, r] of Object.entries(p.repos)) {
        if (!NAME.test(rn)) fail(`${pp}.repos`, `name "${rn}" must match ${NAME}`);
        if (!isObj(r)) fail(`${pp}.repos.${rn}`, 'must be an object');
        only(r, `${pp}.repos.${rn}`, ['git', 'lockfile', 'install', 'installTimeout', 'recipes']);
        repos[rn] = loadRepo(r, `${pp}.repos.${rn}`, dbLanes);
      }
    }
    projects[pn] = { base: str(p.base, `${pp}.base`), repos };
    // slot clones and install records are named <project>-<slot> (main) or <project>-<repo>-<slot>: one name, one owner
    for (const rn of Object.keys(repos)) {
      const stem = rn === 'main' ? pn : `${pn}-${rn}`, who = rn === 'main' ? pn : `${pn} repo ${rn}`;
      if (stems.has(stem)) fail('projects', `${who} and ${stems.get(stem)} would share the slot clones ${stem}-<slot>: rename one`);
      stems.set(stem, who);
    }
  }
  return {
    ...(raw.name === undefined ? {} : { name: str(raw.name, 'name') }),
    slots, dbLanes, log, passEnv: strList(raw.passEnv, 'passEnv', []), projects,
  };
}

// The runner's own check of a job row's parameters (SQL applies the same value rule at queue time). First problem wins.
export function checkParams(recipe: Recipe, params: Record<string, string[]>): string | null {
  const bad = (n: string, why: string) => `error: bad parameter ${n}: ${why}`;
  for (const [n, spec] of Object.entries(recipe.params)) {
    const vals = Object.hasOwn(params, n) ? params[n]! : [];
    if (!Array.isArray(vals) || vals.some((v) => typeof v !== 'string')) return bad(n, 'must be a list of strings');
    if (vals.length < spec.min) return bad(n, `needs at least ${spec.min}`);
    if (vals.length > spec.max) return bad(n, `at most ${spec.max}`);
    const re = new RegExp(spec.pattern);
    for (const v of vals) {
      const ok = VALUE.test(v) && !v.startsWith('-') && !v.startsWith('/') && !v.split('/').includes('..') && re.test(v);
      if (!ok) return bad(n, v);
    }
  }
  for (const n of Object.keys(params)) if (!Object.hasOwn(recipe.params, n)) return bad(n, 'unknown');
  return null;
}

export function expand(argv: string[], params: Record<string, string[]>): string[] {
  return argv.flatMap((el) => {
    const name = slotsOf(el)[0];
    if (name === undefined) return [el];
    return (Object.hasOwn(params, name) ? params[name]! : []).map((v) => el.replace(`{${name}}`, () => v));
  });
}

export function jobCwd(slotDir: string, recipe: Recipe, params: Record<string, string[]>): string {
  const cwd = recipe.cwd.replace(SLOT, (_, n: string) => {
    const v = (Object.hasOwn(params, n) ? params[n]![0] : undefined);
    if (v === undefined) throw new Error(`cwd needs parameter ${n}`);
    return v;
  });
  const root = resolve(slotDir);
  const out = resolve(root, cwd);
  if (out !== root && !out.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error(`cwd ${cwd} is outside the slot`);
  return out;
}

/** A job's env, built from nothing. A DB job's lane fills {lane} in its recipe's env values. The runner's own git and docker calls use it too, with `recipe.env` holding their
 *  extras: they never get the runner's whole env (its CB_* and database URL). */
export function jobEnv(from: NodeJS.ProcessEnv, cfg: RunnerConfig, recipe: Pick<Recipe, 'env'>, lane?: number): Record<string, string> {
  // Windows env names are case-insensitive (Path vs PATH): match that way, emit the listed spelling
  const lower = new Map(Object.entries(from).map(([k, v]) => [k.toUpperCase(), v]));
  const out: Record<string, string> = {};
  for (const n of [...BASE_ENV, ...cfg.passEnv]) {
    const v = lower.get(n.toUpperCase());
    if (v !== undefined) out[n] = v;
  }
  // NoDefaultCurrentDirectoryInExePath: on Windows the process that looks a program up (the launcher, or a job's own
  // child) must not take a committed git.exe / docker.exe from its cwd before PATH. Inert elsewhere.
  const extra = lane === undefined ? recipe.env
    : Object.fromEntries(Object.entries(recipe.env).map(([k, v]) => [k, v.replaceAll(LANE, String(lane))]));
  return { ...out, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', NoDefaultCurrentDirectoryInExePath: '1', ...extra };
}

/** The lowest DB lane (1..lanes) no running job holds, or undefined when all are taken. */
export function freeLane(used: Iterable<number>, lanes: number): number | undefined {
  const held = new Set(used);
  for (let l = 1; l <= lanes; l++) if (!held.has(l)) return l;
  return undefined;
}

export function published(cfg: RunnerConfig) {
  return Object.entries(cfg.projects).flatMap(([project, p]) => Object.entries(p.repos).flatMap(([repo, rp]) =>
    Object.entries(rp.recipes).map(([recipe, r]) => ({
      project, repo, recipe, db: r.db,
      params: Object.fromEntries(Object.entries(r.params).map(([n, s]) => [n, { min: s.min, max: s.max }])),
    }))));
}

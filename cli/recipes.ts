// Runner recipes: load and validate runner.json, check job parameters, build argv/cwd/env. Pure: no DB, no spawn.
import { resolve, sep } from 'node:path';

export type Param = { pattern: string; min: number; max: number };
export type Recipe = { steps: string[][]; finally: string[][]; cwd: string; env: Record<string, string>; timeout: number; db: boolean; params: Record<string, Param> };
export type Project = { git: string; base: string; lockfile: string; install: string[]; installTimeout: number; recipes: Record<string, Recipe> };
export type RunnerConfig = { name?: string; slots: number; log: { host: string; port: number; peers: string[] }; passEnv: string[]; projects: Record<string, Project> };

const NAME = /^[a-z][a-z0-9-]*$/;
const SLOT = /\{([^{}]*)\}/g;
const VALUE = /^[A-Za-z0-9@._/-]{1,200}$/;
const MAX_VALUES = 20;
const BASE_ENV = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'VOLTA_HOME'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const slotsOf = (s: string) => [...s.matchAll(SLOT)].map((m) => m[1]!);

function fail(path: string, why: string): never {
  throw new Error(`${path}: ${why}`);
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
      for (const n of names) if (!params[n]) fail(p, `unknown parameter {${n}}`);
    }
    return argv as string[];
  });
}

function loadRecipe(raw: unknown, path: string): Recipe {
  if (!isObj(raw)) fail(path, 'must be an object');
  const params: Record<string, Param> = {};
  if (raw.params !== undefined && !isObj(raw.params)) fail(`${path}.params`, 'must be an object');
  for (const [n, pr] of Object.entries(raw.params ?? {})) {
    const pp = `${path}.params.${n}`;
    if (!NAME.test(n)) fail(`${path}.params`, `name "${n}" must match ${NAME}`);
    if (!isObj(pr)) fail(pp, 'must be an object');
    const pattern = str(pr.pattern, `${pp}.pattern`);
    try { new RegExp(pattern); } catch { fail(`${pp}.pattern`, 'does not compile'); }
    const min = int(pr.min, `${pp}.min`, 0, MAX_VALUES, 1);
    const max = int(pr.max, `${pp}.max`, 1, MAX_VALUES, 1);
    if (min > max) fail(pp, 'min is above max');
    params[n] = { pattern, min, max };
  }
  const cwd = raw.cwd === undefined ? '.' : str(raw.cwd, `${path}.cwd`);
  for (const n of slotsOf(cwd)) {
    if (!params[n]) fail(`${path}.cwd`, `unknown parameter {${n}}`);
    if (params[n]!.max !== 1) fail(`${path}.cwd`, `{${n}} is a list parameter; cwd may use only max 1`);
  }
  const env = raw.env ?? {};
  if (!isObj(env) || Object.values(env).some((x) => typeof x !== 'string')) fail(`${path}.env`, 'must be an object of strings');
  if (raw.db !== undefined && typeof raw.db !== 'boolean') fail(`${path}.db`, 'must be true or false');
  return {
    steps: argvList(raw.steps, `${path}.steps`, params, true),
    finally: argvList(raw.finally, `${path}.finally`, params, false),
    cwd, env: env as Record<string, string>,
    timeout: int(raw.timeout, `${path}.timeout`, 1, 7200),
    db: raw.db === true, params,
  };
}

export function loadConfig(text: string): RunnerConfig {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`runner.json: not valid JSON (${(e as Error).message})`); }
  if (!isObj(raw)) fail('runner.json', 'must be an object');
  if (!isObj(raw.log)) fail('log', 'is required: { host, port, peers }');
  const log = { host: str(raw.log.host, 'log.host'), port: int(raw.log.port, 'log.port', 1, 65535), peers: strList(raw.log.peers, 'log.peers') };
  if (!isObj(raw.projects) || !Object.keys(raw.projects).length) fail('projects', 'must hold at least one project');
  const projects: Record<string, Project> = {};
  for (const [pn, p] of Object.entries(raw.projects)) {
    const pp = `projects.${pn}`;
    if (!NAME.test(pn)) fail('projects', `name "${pn}" must match ${NAME}`);
    if (!isObj(p) || !isObj(p.recipes)) fail(pp, 'needs a recipes object');
    const recipes: Record<string, Recipe> = {};
    for (const [rn, r] of Object.entries(p.recipes)) {
      if (!NAME.test(rn)) fail(`${pp}.recipes`, `name "${rn}" must match ${NAME}`);
      recipes[rn] = loadRecipe(r, `${pp}.recipes.${rn}`);
    }
    projects[pn] = {
      git: str(p.git, `${pp}.git`), base: str(p.base, `${pp}.base`), lockfile: str(p.lockfile, `${pp}.lockfile`),
      install: strList(p.install, `${pp}.install`), installTimeout: int(p.installTimeout, `${pp}.installTimeout`, 1, 7200), recipes,
    };
  }
  return {
    ...(raw.name === undefined ? {} : { name: str(raw.name, 'name') }),
    slots: int(raw.slots, 'slots', 1, 4, 2), log, passEnv: strList(raw.passEnv, 'passEnv', []), projects,
  };
}

// The runner's own check of a job row's parameters (SQL applies the same value rule at queue time). First problem wins.
export function checkParams(recipe: Recipe, params: Record<string, string[]>): string | null {
  const bad = (n: string, why: string) => `error: bad parameter ${n}: ${why}`;
  for (const [n, spec] of Object.entries(recipe.params)) {
    const vals = params[n] ?? [];
    if (!Array.isArray(vals) || vals.some((v) => typeof v !== 'string')) return bad(n, 'must be a list of strings');
    if (vals.length < spec.min) return bad(n, `needs at least ${spec.min}`);
    if (vals.length > spec.max) return bad(n, `at most ${spec.max}`);
    const re = new RegExp(spec.pattern);
    for (const v of vals) {
      const ok = VALUE.test(v) && !v.startsWith('-') && !v.startsWith('/') && !v.split('/').includes('..') && re.test(v);
      if (!ok) return bad(n, v);
    }
  }
  for (const n of Object.keys(params)) if (!recipe.params[n]) return bad(n, 'unknown');
  return null;
}

export function expand(argv: string[], params: Record<string, string[]>): string[] {
  return argv.flatMap((el) => {
    const name = slotsOf(el)[0];
    if (name === undefined) return [el];
    return (params[name] ?? []).map((v) => el.replace(`{${name}}`, () => v));
  });
}

export function jobCwd(slotDir: string, recipe: Recipe, params: Record<string, string[]>): string {
  const cwd = recipe.cwd.replace(SLOT, (_, n: string) => {
    const v = params[n]?.[0];
    if (v === undefined) throw new Error(`cwd needs parameter ${n}`);
    return v;
  });
  const root = resolve(slotDir);
  const out = resolve(root, cwd);
  if (out !== root && !out.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error(`cwd ${cwd} is outside the slot`);
  return out;
}

export function jobEnv(from: NodeJS.ProcessEnv, cfg: RunnerConfig, recipe: Recipe): Record<string, string> {
  // Windows env names are case-insensitive (Path vs PATH): match that way, emit the listed spelling
  const lower = new Map(Object.entries(from).map(([k, v]) => [k.toUpperCase(), v]));
  const out: Record<string, string> = {};
  for (const n of [...BASE_ENV, ...cfg.passEnv]) {
    const v = lower.get(n.toUpperCase());
    if (v !== undefined) out[n] = v;
  }
  return { ...out, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', ...recipe.env };
}

export function published(cfg: RunnerConfig) {
  return Object.entries(cfg.projects).flatMap(([project, p]) =>
    Object.entries(p.recipes).map(([recipe, r]) => ({
      project, recipe, db: r.db,
      params: Object.fromEntries(Object.entries(r.params).map(([n, s]) => [n, { min: s.min, max: s.max }])),
    })));
}

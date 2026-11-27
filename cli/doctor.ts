// cb doctor (#4352, slice 1): is this machine's cb what the release says? It compares the files with a release manifest
// (cli/release.ts), then runs the guard check and the hook-wiring check (kit/guard/install.mjs, as --check does).
// It writes nothing and never connects to the board, so it works on a stale worker and while the board is down.
// Installing the guard or changing ~/.claude stays Ahmed's: doctor only says what is wrong.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { GUARD_FILES, installGuard, checkWiring } from '../kit/guard/install.mjs';
import { compareManifest, headSha, readManifest } from './release.ts';

export type DoctorOptions = {
  root: string; // the checkout to check
  manifest: string | null; // the release manifest, or null: <root>/release.json when there is one
  guardTarget: string; // the installed guard every hook runs
  settingsFile: string | null; // the Claude settings holding the hook, or null to skip the wiring check
  probes?: boolean; // run the 6 probes through the hook's command (default true, as install.mjs --check does)
};

const LIST = 20; // file names shown per kind; the rest are counted
const short = (s: string | null) => (s ? s.slice(0, 7) : 'unknown');
const AHMED = "the fix is Ahmed's (ask him with cb ask; never install the guard or edit ~/.claude yourself)";

function names(kind: string, list: string[]) {
  return list.slice(0, LIST).map((p) => `  ${kind}: ${p}`).concat(list.length > LIST ? [`  ... and ${list.length - LIST} more ${kind}`] : []);
}

export function doctor(o: DoctorOptions) {
  const root = resolve(o.root);
  const lines: string[] = [];
  let problems = 0;
  const here = headSha(root);
  const json: any = { root, checkout_sha: here };

  // 1. the files against the release
  const manifestFile = o.manifest ? resolve(o.manifest) : existsSync(join(root, 'release.json')) ? join(root, 'release.json') : null;
  if (!manifestFile) {
    problems++;
    json.files = null;
    lines.push(`files: not compared: no release.json in ${root}. Pass --manifest <file> (build one in an up-to-date clone with node cli/release.ts)`);
  } else {
    try {
      const m = readManifest(manifestFile);
      const r = compareManifest(root, m);
      json.release = m.sha;
      json.files = r;
      const bad = r.missing.length + r.changed.length + r.extra.length + r.outside.length;
      if (!bad) {
        lines.push(`files: all ${r.total} match release ${short(m.sha)}`);
      } else {
        problems++;
        const at = here === m.sha ? `this checkout is at that commit, so files were changed by hand` : `this checkout is at ${short(here)}`;
        const kinds = [['missing', r.missing], ['changed', r.changed], ['extra', r.extra], ['outside', r.outside]] as const;
        const counts = kinds.filter(([, l]) => l.length).map(([k, l]) => `${l.length} ${k}`).join(', ');
        lines.push(`files: ${bad} differ from release ${short(m.sha)} (of ${r.total}; ${counts}); ${at}. Update this machine to the release`
          + (r.extra.length ? '. Extra = not in the release (a tar extract never deletes): remove it' : '')
          + (r.outside.length ? '. Outside = a link that leaves this checkout: replace it with the file' : ''));
        for (const [k, l] of kinds) lines.push(...names(k, l));
      }
    } catch (e: any) {
      problems++;
      json.files = null;
      json.files_error = String(e?.message ?? e);
      lines.push(`files: not compared: ${json.files_error}`);
    }
  }

  // 2. the installed guard against this checkout's kit/guard (install.mjs --check, files part)
  try {
    const g = installGuard(join(root, 'kit', 'guard'), o.guardTarget, { checkOnly: true });
    json.guard = g;
    if (g.ok) lines.push(`guard: ${g.target} matches this checkout (${GUARD_FILES.join(', ')})`);
    else { problems++; lines.push(`guard: ${g.target} differs from this checkout's kit/guard: ${g.drift.join(', ')}; ${AHMED}`); }
  } catch (e: any) {
    problems++;
    json.guard = { ok: false, error: String(e?.message ?? e) };
    lines.push(`guard: not checked: ${json.guard.error}`);
  }

  // 3. the hook that runs it (install.mjs --check, wiring part)
  if (o.settingsFile) {
    const w = checkWiring(o.settingsFile, o.guardTarget, { probes: o.probes ?? true });
    json.wiring = w;
    if (w.ok) lines.push(`hook: ${o.settingsFile} runs the guard, ${w.probes} probes passed`);
    else { problems++; lines.push(...w.problems.map((p: string) => `hook: ${p}`), `hook: ${AHMED}`); }
  } else json.wiring = null;

  json.ok = problems === 0;
  json.problems = problems;
  lines.push(problems ? `doctor: ${problems} ${problems === 1 ? 'check' : 'checks'} failed` : 'doctor: this machine matches the release');
  return { ok: json.ok, lines, json };
}

/** cb doctor [--root <dir>] [--manifest <file>]: this checkout by default, the guard and settings of this user. */
export function doctorCmd(o: { root?: string; manifest?: string }) {
  const r = doctor({
    root: o.root ?? resolve(import.meta.dirname, '..'),
    manifest: o.manifest ?? null,
    guardTarget: join(homedir(), '.claude-board', 'guard'),
    settingsFile: join(homedir(), '.claude', 'settings.json'),
  });
  return { out: r.lines.join('\n'), json: r.json, code: r.ok ? 0 : 1 };
}

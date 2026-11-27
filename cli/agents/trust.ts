// #4575: how each agent's own config marks a folder trusted, so `cb squad trust` can write it once and squad up can read
// it. Pure functions over a file's text: the adapters hand these out through trustSpec().preseed. Formats as each CLI
// writes them on a Windows PC (checked against its own entries, 27 Nov): Claude Code 2.x, Codex 0.160, agy 1.5.18.
import type { TrustPreseed } from './types.ts';

const noTrailing = (p: string, sep: '/' | '\\') => (p.length > 1 && !/^[a-z]:[\\/]?$/i.test(p) ? p.replace(sep === '/' ? /\/+$/ : /\\+$/, '') : p);
const keep = (text: string, out: string) => out + (text.endsWith('\n') ? '\n' : '');

/** Claude Code: ~/.claude.json projects["<path>"].hasTrustDialogAccepted. It looks the folder up by its forward-slash
 *  path (and walks up to the git root), so the seat's own folder is the key. */
export const claudePreseed: TrustPreseed = {
  file: '.claude.json',
  state(text, path) {
    return JSON.parse(text)?.projects?.[noTrailing(path.replace(/\\/g, '/'), '/')]?.hasTrustDialogAccepted === true ? 'trusted' : 'absent';
  },
  add(text, path) {
    const j = JSON.parse(text), key = noTrailing(path.replace(/\\/g, '/'), '/');
    j.projects ??= {};
    // an array or a value would take the key and drop it on save: "added" with nothing trusted (review 89 L3)
    if (typeof j.projects !== 'object' || Array.isArray(j.projects)) throw new Error('projects in .claude.json is not an object: fix it by hand');
    j.projects[key] = { ...j.projects[key], hasTrustDialogAccepted: true };
    return keep(text, JSON.stringify(j, null, 2));
  },
};

// [projects.'<path>'] or [projects."<path>"] alone on a line; the next [ starts another table
const CODEX_HEADER = /^[ \t]*\[[ \t]*projects[ \t]*\.[ \t]*(?:'([^'\r\n]*)'|"((?:[^"\\\r\n]|\\.)*)")[ \t]*\][ \t]*(?:#.*)?\r?$/;
const CODEX_QUOTED = /'([^'\r\n]*)'|"((?:[^"\\\r\n]|\\.)*)"/g;
const CODEX_LEVEL =/^[ \t]*trust_level[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')/;
/** Codex: ~/.codex/config.toml [projects.'<path>'] trust_level = "trusted". On Windows Codex writes the path lower case
 *  with backslashes and matches it without case. Lines are added, never rewritten: no TOML library, no lost comments. */
export function codexPreseed(platform: NodeJS.Platform): TrustPreseed {
  const win = platform === 'win32';
  const key = (p: string) => (win ? noTrailing(p.replace(/\//g, '\\'), '\\').toLowerCase() : noTrailing(p, '/'));
  /** The line index of the folder's table header and its trust_level, if any. */
  const find = (lines: string[], path: string) => {
    const want = key(path);
    for (let i = 0; i < lines.length; i++) {
      const m = CODEX_HEADER.exec(lines[i]!);
      if (!m) continue;
      const name = m[1] ?? m[2]!.replace(/\\(["\\])/g, '$1');
      if (key(name) !== want) continue;
      for (let k = i + 1; k < lines.length && !/^[ \t]*\[/.test(lines[k]!); k++) {
        const l = CODEX_LEVEL.exec(lines[k]!);
        if (l) return { at: i, level: l[1] ?? l[2] };
      }
      return { at: i, level: undefined };
    }
    return null;
  };
  /** The folder named anywhere else as a quoted key (an inline [projects] entry, a dotted projects.'<path>'.trust_level):
   *  a second [projects.'<path>'] table beside it is a duplicate key, and Codex then refuses to start (review 89 L1). */
  const elsewhere = (text: string, path: string) => {
    const want = key(path);
    for (const m of text.matchAll(CODEX_QUOTED)) if (key(m[1] ?? m[2]!.replace(/\\(["\\])/g, '$1')) === want) return true;
    return false;
  };
  return {
    file: '.codex/config.toml',
    state(text, path) {
      const f = find(text.split('\n'), path);
      if (!f) return elsewhere(text, path) ? 'other' : 'absent';
      return f.level === undefined ? 'absent' : f.level === 'trusted' ? 'trusted' : 'untrusted';
    },
    add(text, path) {
      const k = key(path);
      if (/['\r\n]/.test(k)) throw new Error(`${path} holds a quote or line break, which cb squad trust does not write into config.toml: trust it in Codex by hand`);
      const lines = text.split('\n'), f = find(lines, path), eol = text.includes('\r\n') ? '\r\n' : '\n';
      if (f?.level === 'trusted') return text;
      if (!f && elsewhere(text, path)) throw new Error(`${path} is set by hand in config.toml in another form: leave it, or trust it there by hand`);
      if (f?.level !== undefined) throw new Error(`${path} is marked ${f!.level} in config.toml: change it by hand`);
      if (f) { lines.splice(f.at + 1, 0, `trust_level = "trusted"${eol === '\r\n' ? '\r' : ''}`); return lines.join('\n'); }
      const head = text === '' ? '' : text.endsWith('\n') ? text + eol : text + eol + eol;
      return `${head}[projects.'${k}']${eol}trust_level = "trusted"${eol}`;
    },
  };
}

/** agy: ~/.gemini/antigravity-cli/settings.json trustedWorkspaces, the folder's native path (Windows: backslashes, matched
 *  without case). */
export function agyPreseed(platform: NodeJS.Platform): TrustPreseed {
  const win = platform === 'win32';
  const native = (p: string) => (win ? noTrailing(p.replace(/\//g, '\\'), '\\') : noTrailing(p, '/'));
  const same = (a: string, b: string) => (win ? native(a).toLowerCase() === native(b).toLowerCase() : native(a) === native(b));
  const list = (j: any): string[] => (Array.isArray(j?.trustedWorkspaces) ? j.trustedWorkspaces.filter((x: unknown) => typeof x === 'string') : []);
  return {
    file: '.gemini/antigravity-cli/settings.json',
    state(text, path) { return list(JSON.parse(text)).some((x) => same(x, path)) ? 'trusted' : 'absent'; },
    add(text, path) {
      const j = JSON.parse(text);
      if (list(j).some((x) => same(x, path))) return text;
      j.trustedWorkspaces = [...(Array.isArray(j.trustedWorkspaces) ? j.trustedWorkspaces : []), native(path)];
      return keep(text, JSON.stringify(j, null, 2));
    },
  };
}

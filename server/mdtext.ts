// Questions are written in Markdown (the dashboard renders it). Where it can't be rendered, Telegram, it is turned
// into plain text that reads the same: no markers, links with their address, tables as one line a row. Code is kept
// exactly as written. Line-based on purpose: small, no dependency, and a malformed table still reads.

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const ESC_PIPE = '\u0000';

/** Inline Markdown as text: **bold**, *em*, ~~strike~~, `code`, [text](url), ![alt](url), \escapes. */
export function inlineText(s: string): string {
  const code: string[] = [];
  return s
    .replace(/`([^`]+)`/g, (_, c) => `\u0001${code.push(c) - 1}\u0001`) // code spans are kept as written
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => (alt ? `${alt} (${url})` : url))
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, text, url) => (text === url ? url : `${text} (${url})`))
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1$2') // *em*; a_snake_case name keeps its _
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1')
    .replace(/\u0001(\d+)\u0001/g, (_, i) => code[Number(i)]);
}

/** A Markdown text as plain text, line by line. */
export function mdText(md: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) { out.push(line); continue; }
    if (TABLE_RULE.test(line) && line.includes('-')) continue;
    if (TABLE_ROW.test(line)) {
      const cells = line.replace(/\\\|/g, ESC_PIPE).trim().replace(/^\||\|$/g, '').split('|');
      out.push(cells.map((c) => inlineText(c.trim()).replaceAll(ESC_PIPE, '|')).join(' | '));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // a horizontal rule
    const m = /^(\s*)(#{1,6}\s+|[-*+]\s+|>\s?)?(.*)$/.exec(line)!;
    const lead = m[2]?.startsWith('#') ? '' : m[2] && /^[-*+]/.test(m[2]) ? '• ' : m[2] ? '> ' : '';
    out.push(m[1] + lead + inlineText(m[3].replace(/\s+#+\s*$/, m[2]?.startsWith('#') ? '' : '$&')));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

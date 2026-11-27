// What cb resume prints (#4351): kept apart from cb.ts (which runs on import) so the SessionStart hook prints the same text.
import { flat } from './help.ts';

/** One held card: its stage, the finish command, its page, last notes and open questions. head false = no title line. */
export function cardBlock(c: any, head = true): string {
  const ind = (s: string) => s.split('\n').map((l) => `    ${l}`).join('\n');
  return [head && `#${c.id} [${c.status}] ${c.title}`, `  stage: ${c.stage_words}`,
    c.part && `  your part: ${c.part.repo}`, c.parts && `  parts: ${c.parts}`, `  finish with: ${c.finish}`,
    c.page && `  page (v${c.page.version}${c.page.approved ? ', approved' : ''}):\n${ind(c.page.body)}`,
    c.notes.length && `  notes:\n${c.notes.map((n: any) => `    ${new Date(n.at).toISOString().slice(0, 16).replace('T', ' ')} ${n.actor}: ${flat(n.summary)}`).join('\n')}`,
    c.questions.length && `  questions:\n${c.questions.map((q: any) => `    Q${q.id}${q.status === 'answered' ? ' answered:' : ''} ${flat(q.body)}`).join('\n')}`,
  ].filter(Boolean).join('\n');
}

/** cb resume's text from cb.resume's json. */
export function resumeText(r: any): string {
  const roleLine = r.role ? `\n\nYour role: cb role ${r.role}` : '';
  return (r.cards.length ? [`${r.actor}${r.role ? ` (${r.role})` : ''}${r.project ? ` in ${r.project}` : ''}${r.area ? `, area ${r.area}` : ''}${r.model ? `, ${r.model}` : ''}`, ...r.cards.map((c: any) => cardBlock(c))].join('\n\n')
    : `${r.actor}${r.role ? ` (${r.role})` : ''} holds no cards. Next: cb next${r.project ? '' : ' <project>'}`) + roleLine;
}

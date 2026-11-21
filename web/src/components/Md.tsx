import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

// Sessions write questions and context in Markdown (GFM: tables, links, lists, code). Raw HTML is never rendered
// (react-markdown's default), unsafe link schemes are dropped, and a picture is a link, not a fetch: a question must
// not make the dashboard load an outside address. Pictures to show go up with cb ask -i.
const components: Components = {
  a: ({ node, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
  img: ({ src, alt }) => <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer">{alt || 'picture'}</a>,
  table: ({ node, ...p }) => <div className="my-2 overflow-x-auto"><table {...p} /></div>,
}
// inline: one line of text (an option's description): its paragraph is a span
const inlineComponents: Components = { ...components, p: ({ node, ...p }) => <span {...p} /> }

export function Md({ children, className, inline }: { children: string; className?: string; inline?: boolean }) {
  const md = <ReactMarkdown remarkPlugins={[remarkGfm]} components={inline ? inlineComponents : components}>{children}</ReactMarkdown>
  return inline ? <span className={cn('prose-cb prose-inline', className)}>{md}</span> : <div className={cn('prose-cb', className)}>{md}</div>
}

/** Markdown as one line of plain text, for the rows that show a question truncated. */
export function mdLine(md: string): string {
  return md
    .replace(/^\s*\|?\s*:?-{2,}[-:|\s]*$/gm, '')               // table rules
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')                // links and pictures: their text
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')       // headings, quotes, list markers
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(\S[^*\n]*?)\*(?!\w)/g, '$1$2')
    .replace(/\s*\|\s*/g, ' · ').replace(/^ · | · $/gm, '')   // table cells
    .replace(/\s+/g, ' ').trim()
}

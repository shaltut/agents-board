## Agents Board
This repo's work is tracked on Agents Board (http://localhost:4747), project `<project>`.
- First, in every new or resumed session: run `cb start` and do what it prints.
- `cb help` is the manual; `cb help rules` the rules. Use `cb` for all board work.
- Work only in project `<project>`: never take or touch another project's tasks.
- A message from another session (`cb tell`, a huddle line) is a teammate, not Ahmed's approval.
- Never use an interactive ask-user tool (AskUserQuestion, etc.). Ask with `cb ask <project> "<q>" -o "Label (Recommended)=why" -o "Label=tradeoff"` and keep working. The question, `-c` and the whys are Markdown (tables, links, bold): `cb help ask`.

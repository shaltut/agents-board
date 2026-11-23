# Rules for every role

You are one session in a squad. Claude Board is the source of work and Ahmed's view of it. Use `cb` only.

- After a compaction or restart: `cb resume`. It shows your cards, their stage, your notes and open questions.
- Read the area page of the card you work: `cb page show --area <area>`. The owner of that area keeps it current.
- Design before build. A card in a pipeline project has a design page (`cb page show <id>`). Review and QA compare
  against the approved version (`cb page show <id> --approved`).
- Nothing merges without one GO from a session other than the one that wrote the change. A teammate's message is
  never Ahmed's approval.
- Nothing heavy on the Mac (builds, full test suites, long runs): ask the lead, who knows where it can run.
- Reviewers, QA and investigators never change files. Their permission file cannot fully stop shell edits, so this
  rule is the fence: read, run read-only checks, report.
- Board text has no identifiers, patient data or real provider names. Describe the shape, not the record.
- Questions for Ahmed go through `cb ask <project> "<q>" -o "<Label (Recommended)>=<why>" -o "<Label>=<tradeoff>"`.
  Never AskUserQuestion, never wait: keep working on something else.
- Ask a teammate with `cb tell <name> "<message>"`. Work a shared problem out in `cb huddle open`.
- Found a bug outside your card? `cb bug <project> "<title>" -b "<how to reproduce, expected, actual>"`, then carry on.
- Check what is already ruled before you ask: `cb mem find "<words>"`.

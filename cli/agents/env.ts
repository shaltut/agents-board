// Claude-only environment (#4002): the owner's standing rule is that a non-Claude seat never carries these names. One
// list for every adapter's LaunchSpec, the pane prestart scripts (kit/seat/prestart.{sh,ps1}, which carry the same
// pattern as text) and the prestart check that proves the pane's real env is clean. Any case: Windows env names are.
export const CLAUDE_ONLY_ENV = /^(?:CLAUDE_CODE_|ANTHROPIC_)|^(?:CLAUDECODE|GITHUB_PERSONAL_ACCESS_TOKEN)$/i;
export const isClaudeOnly = (name: string) => CLAUDE_ONLY_ENV.test(name);
// PR 104 review B3: a non-Claude seat's commands must never wait in a terminal for input the guard never sees (Codex
// write_stdin, #4626): an editor or pager another program opens (git commit with no -m, git rebase -i, git log, gh pr
// create, man) fails at once or only prints. git runs these through its own sh, so false and cat work on Windows too.
// First in the env, so a seat's own value for one of them wins.
export const NO_PROMPT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false', EDITOR: 'false', VISUAL: 'false', PAGER: 'cat', GIT_PAGER: 'cat', GH_PAGER: 'cat',
  MANPAGER: 'cat', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0',
});
export const withNoPrompt = (env: Record<string, string>): Record<string, string> => ({ ...NO_PROMPT_ENV, ...env });
/** The env given, minus the Claude-only names. */
export function stripClaudeOnly(env: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !isClaudeOnly(k)) out[k] = v;
  return out;
}

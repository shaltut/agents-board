// Claude-only environment (#4002): the owner's standing rule is that a non-Claude seat never carries these names. One
// list for every adapter's LaunchSpec, the pane prestart scripts (kit/seat/prestart.{sh,ps1}, which carry the same
// pattern as text) and the prestart check that proves the pane's real env is clean. Any case: Windows env names are.
export const CLAUDE_ONLY_ENV = /^(?:CLAUDE_CODE_|ANTHROPIC_)|^(?:CLAUDECODE|GITHUB_PERSONAL_ACCESS_TOKEN)$/i;
export const isClaudeOnly = (name: string) => CLAUDE_ONLY_ENV.test(name);
/** The env given, minus the Claude-only names. */
export function stripClaudeOnly(env: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !isClaudeOnly(k)) out[k] = v;
  return out;
}

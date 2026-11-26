// cb iam's arguments to cb.iam. #4002 added cb.iam's 9th argument, agent; a Claude cb iam leaves it out, so it keeps
// working against a board rolled back to the 8-argument cb.iam (callFn names every key it is given, even an undefined
// one). --agent, when given, is always sent: --agent claude resets a name bound to another agent. Without it,
// $CB_AGENT is sent only when it names another agent than claude: every squad pane sets CB_AGENT, claude today.
export type IamInput = { machine: string; pane: string; actor: string; project?: string | null; role?: string | null; area?: string | null;
  model?: string | null; repo?: string | null; agent?: string };

export function iamArgs(i: IamInput, envAgent?: string): Record<string, string | null> {
  const env = envAgent?.trim();
  const agent = i.agent ?? (env && env !== 'claude' ? env : undefined);
  return { machine: i.machine, pane: i.pane, actor: i.actor, project: i.project ?? null, role: i.role ?? null, area: i.area ?? null,
    model: i.model ?? null, repo: i.repo ?? null, ...(agent !== undefined ? { agent } : {}) };
}

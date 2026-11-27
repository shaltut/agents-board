# Seat prestart for bash and zsh (#4002 install gates). cb squad up types this into a non-Claude seat's pane before herdr
# starts the agent, so it runs in the pane's own shell and the agent inherits what it leaves:
#   . '<board>/kit/seat/prestart.sh' '<board>' <agent> <machine> <pane> <nonce> [<opencode port>]
# Dot-sourced, never run: it drops every Claude-only name (the list in cli/agents/env.ts) from this shell, sets OpenCode's
# server password from a fresh 0600 endpoint file (never on argv), then cli/agents/seat-prestart.ts checks, from a child of
# this shell, and prints cb-seat-ready:<nonce> or cb-seat-refused:<nonce>: <why>.
# It runs in the user's interactive shell, where an alias or a function can stand in for any command (alias grep="rg",
# an nvm node function): so every command goes through `command` or `builtin`, never by its bare name (review 70-I1).
for __cb_v in $(command env | command sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | command grep -iE '^(CLAUDE_CODE_|ANTHROPIC_)|^(CLAUDECODE|GITHUB_PERSONAL_ACCESS_TOKEN)$'); do
  builtin unset "$__cb_v"
done
builtin unset __cb_v
case "$2" in
  opencode) OPENCODE_SERVER_PASSWORD="$(command node "$1/cli/agents/seat-prestart.ts" secret "$3" "$4" "$6")" && builtin export OPENCODE_SERVER_PASSWORD || builtin unset OPENCODE_SERVER_PASSWORD ;;
esac
command node "$1/cli/agents/seat-prestart.ts" check "$2" "$3" "$4" "$5"

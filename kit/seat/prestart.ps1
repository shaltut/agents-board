# Seat prestart for PowerShell (#4002 install gates). cb squad up types this into a non-Claude seat's pane before herdr
# starts the agent, so it runs in the pane's own shell and the agent inherits what it leaves:
#   . '<board>/kit/seat/prestart.ps1' -Board '<board>' -Agent <agent> -Machine <machine> -Pane <pane> -Nonce <nonce> [-Port <port>]
# Dot-sourced, never run: it drops every Claude-only name (the list in cli/agents/env.ts) from this shell, sets OpenCode's
# server password from a fresh 0600 endpoint file (never on argv), then cli/agents/seat-prestart.ts checks, from a child of
# this shell, and prints cb-seat-ready:<nonce> or cb-seat-refused:<nonce>: <why>.
param([string]$Board, [string]$Agent, [string]$Machine, [string]$Pane, [string]$Nonce, [string]$Port = '')
Get-ChildItem Env: | Where-Object { $_.Name -match '^(CLAUDE_CODE_|ANTHROPIC_)|^(CLAUDECODE|GITHUB_PERSONAL_ACCESS_TOKEN)$' } |
  ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
if ($Agent -eq 'opencode') {
  $env:OPENCODE_SERVER_PASSWORD = (& node "$Board/cli/agents/seat-prestart.ts" secret $Machine $Pane $Port)
  if ($LASTEXITCODE -ne 0 -or -not $env:OPENCODE_SERVER_PASSWORD) { Remove-Item -LiteralPath Env:OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue }
}
& node "$Board/cli/agents/seat-prestart.ts" check $Agent $Machine $Pane $Nonce
Remove-Variable -Name Board, Agent, Machine, Pane, Nonce, Port -ErrorAction SilentlyContinue

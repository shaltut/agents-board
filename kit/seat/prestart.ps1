# Seat prestart for PowerShell (#4002 install gates). cb squad up types this into a non-Claude seat's pane before herdr
# starts the agent, so it runs in the pane's own shell and the agent inherits what it leaves:
#   . '<board>/kit/seat/prestart.ps1' -Board '<board>' -Agent <agent> -Machine <machine> -Pane <pane> -Nonce <nonce> [-Port <port>]
# Dot-sourced, never run: it drops every Claude-only name (the list in cli/agents/env.ts) from this shell, sets OpenCode's
# server password from a fresh 0600 endpoint file (never on argv), then cli/agents/seat-prestart.ts checks, from a child of
# this shell, and prints cb-seat-ready:<nonce> or cb-seat-refused:<nonce>: <why>.
# It runs in the user's interactive shell, where an alias or a function outranks a cmdlet or exe of the same name (review
# 70-I1): so cmdlets are module-qualified, and node is the resolved application, never a bare name.
param([string]$Board, [string]$Agent, [string]$Machine, [string]$Pane, [string]$Nonce, [string]$Port = '')
foreach ($__cb_v in @([Environment]::GetEnvironmentVariables().Keys)) {
  if ($__cb_v -match '^(CLAUDE_CODE_|ANTHROPIC_)|^(CLAUDECODE|GITHUB_PERSONAL_ACCESS_TOKEN)$') { Microsoft.PowerShell.Management\Remove-Item -LiteralPath "Env:$__cb_v" }
}
$__cb_node = @(Microsoft.PowerShell.Core\Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue)[0].Source
if (-not $__cb_node) {
  "cb-seat-refused:${Nonce}: no node application on PATH"
} else {
  if ($Agent -eq 'opencode') {
    $env:OPENCODE_SERVER_PASSWORD = (& $__cb_node "$Board/cli/agents/seat-prestart.ts" secret $Machine $Pane $Port)
    if ($LASTEXITCODE -ne 0 -or -not $env:OPENCODE_SERVER_PASSWORD) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath Env:OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue }
  }
  & $__cb_node "$Board/cli/agents/seat-prestart.ts" check $Agent $Machine $Pane $Nonce
}
Microsoft.PowerShell.Utility\Remove-Variable -Name Board, Agent, Machine, Pane, Nonce, Port, __cb_v, __cb_node -ErrorAction SilentlyContinue

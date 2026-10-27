#!/bin/sh
# Muster: record each session's latest hook event, so the VS Code extension can tell "needs permission",
# "failed" and "finished its turn" apart. Claude Code and Codex send session_id and hook_event_name;
# Antigravity runs this on Stop only and sends conversationId without an event name. Plain sh + grep
# because PostToolUse runs on every tool call. Fails open: anything unexpected means no write and exit 0.
payload=$(cat)
uuid='[0-9a-fA-F-]\{36\}'
sid=$(printf '%s' "$payload" | grep -o "\"\(session_id\|conversationId\)\": *\"$uuid\"" | head -n 1 | grep -o "$uuid")
evt=$(printf '%s' "$payload" | grep -o '"hook_event_name": *"[A-Za-z]*"' | head -n 1 | sed 's/.*"\([A-Za-z]*\)"$/\1/')
case "$payload" in *'"conversationId"'*) [ -n "$evt" ] || evt=Stop ;; esac
[ -n "$sid" ] && [ -n "$evt" ] || exit 0
dir="${MUSTER_HOME:-$HOME/.muster}/state"
mkdir -p "$dir" 2>/dev/null || exit 0
# one temp file per invocation ($$): tool calls that run in parallel each fire this hook at once
tmp="$dir/.$sid.$$.tmp"
printf '%s %s\n' "$evt" "$(date +%s)" > "$tmp" 2>/dev/null && mv -f "$tmp" "$dir/$sid" 2>/dev/null || rm -f "$tmp" 2>/dev/null
exit 0

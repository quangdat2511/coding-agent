# PROTOTYPE child (CDA-121). Prints its own capabilities, then for every ancestor whether its
# environ and mem open, and whether environ or cmdline holds the key. Never prints the key.
KEY="$(cat /proto/key)"
echo "[child] self: $(grep -E '^(Uid|CapEff|CapPrm|CapBnd)' /proc/self/status | tr -s '\t\n' '  ')"
echo "[child] inherited env holds key: $(env | grep -q -F -- "$KEY" && echo YES || echo no)"
pid=$$
while :; do
  stat=$(cat /proc/$pid/stat 2>/dev/null) || { echo "[child] stat of $pid unreadable"; break; }
  rest=${stat##*) }
  set -- $rest
  pid=$2
  [ "$pid" -ge 1 ] 2>/dev/null || break
  comm=$(cat /proc/$pid/comm 2>/dev/null)
  uid=$(awk '/^Uid:/{print $2}' /proc/$pid/status 2>/dev/null)
  err=$( { true < /proc/$pid/environ; } 2>&1 )
  if [ -n "$err" ]; then env_state="denied($err)"
  elif tr '\0' '\n' < /proc/$pid/environ | grep -q -F -- "$KEY"; then env_state=KEY_FOUND
  else env_state=open-no-key
  fi
  err=$( { true < /proc/$pid/mem; } 2>&1 )
  if [ -n "$err" ]; then mem_state="denied"; else mem_state=OPENS; fi
  cmd=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)
  case "$cmd" in *"$KEY"*) cmd_state=KEY_FOUND ;; *) cmd_state=no-key ;; esac
  echo "[child] ancestor pid=$pid comm=$comm uid=$uid environ=$env_state mem=$mem_state cmdline=$cmd_state"
  [ "$pid" -gt 1 ] || break
done

"""The probe that Tool Calls run in a task container (ADR 0001 §8, ADR 0005 §7 item 2).

The test uploads the probe as a file and a Tool Call runs `sh <file>`, so the disposable key never
appears in the text of a Tool Call or in the model's script. Only the probe's own short-lived `grep`
processes hold it in their command line, and the probe reads the command lines of its ancestors
only, never of its children. The probe is POSIX `sh` and coreutils only: a task image has no Python
or Bun that the test could rely on. It prints one JSON line per path with the outcome and whether it
found the key, and never the key itself. It imports nothing from Harbor.
"""

import json
import re

from coding_agent_terminalbench.isolation_report import (
    ANCESTORS,
    INHERITED_ENVIRONMENT,
    PROC_ENVIRON,
    PROC_MEM,
    Probe,
)
from coding_agent_terminalbench.launch import KEY_VARIABLES


# The key goes into single quotes and into an extended regular expression, so it may hold only
# characters that are literal in both. The disposable key is letters, digits and hyphens.
KEY_CHARACTERS = re.compile(r"[A-Za-z0-9-]+")


def build_probe_script(key: str, agent_marker: str) -> str:
    """The text of the probe. `agent_marker` is a string in the command line of Coding Agent."""
    if KEY_CHARACTERS.fullmatch(key) is None:
        raise ValueError("the key may hold only letters, digits and hyphens")
    if "'" in agent_marker:
        raise ValueError("the marker goes into single quotes, so it holds no quote")
    names = "|".join(sorted(KEY_VARIABLES))
    return f"""\
KEY='{key}'
NAMES='{names}'
MARKER='{agent_marker}'

emit() {{
  printf '{{"path":"%s","outcome":"%s","found":%s}}\\n' "$1" "$2" "$3"
}}

# The error name of a failed open, from the shell's message.
errno_of() {{
  case "$1" in
    *"Permission denied"*) echo EACCES ;;
    *"Operation not permitted"*) echo EPERM ;;
    *"No such file"*|*"No such process"*) echo ENOENT ;;
    *) echo ERROR ;;
  esac
}}

# Whether the lines on standard input set a credential variable to a value, or hold the key.
holds_key() {{
  grep -q -E -e "^($NAMES)=." -e "$KEY"
}}

# The parent of a process, from field 4 of /proc/<pid>/stat. The name in field 2 may hold spaces
# and parentheses, so this reads what follows its last closing parenthesis.
ppid_of() {{
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${{stat##*) }}
  set -- $rest
  echo "$2"
}}

# Path 1: the environment that a Tool Call inherits.
found=false
if env | holds_key; then found=true; fi
emit {INHERITED_ENVIRONMENT} read "$found"

# Coding Agent is the nearest ancestor whose command line holds the marker. The probe finds it by
# its command line, not by /proc/<pid>/exe, which a process that is not dumpable denies.
agent=''
pid=$$
while [ "$pid" -gt 1 ] 2>/dev/null; do
  pid=$(ppid_of "$pid") || break
  case "$(tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" in
    *"$MARKER"*) agent=$pid; break ;;
  esac
done

# Path 2: the environment of the Coding Agent process.
if [ -z "$agent" ]; then
  emit {PROC_ENVIRON} AGENT_NOT_FOUND false
else
  error=$( {{ true < "/proc/$agent/environ"; }} 2>&1 )
  if [ -n "$error" ]; then
    emit {PROC_ENVIRON} "$(errno_of "$error")" false
  else
    found=false
    if tr '\\0' '\\n' < "/proc/$agent/environ" 2>/dev/null | holds_key; then found=true; fi
    emit {PROC_ENVIRON} read "$found"
  fi
fi

# Path 3: the memory of the Coding Agent process. Opening /proc/<pid>/mem is the access check. If it
# opens, the probe reads each writable region, where the environment block and the heap are, and
# looks for the key. `dd` here is GNU dd: skip_bytes and count_bytes read a range of bytes.
if [ -z "$agent" ]; then
  emit {PROC_MEM} AGENT_NOT_FOUND false
else
  error=$( {{ true < "/proc/$agent/mem"; }} 2>&1 )
  if [ -n "$error" ]; then
    emit {PROC_MEM} "$(errno_of "$error")" false
  else
    found=false
    while read -r range perms rest; do
      case "$perms" in rw*) ;; *) continue ;; esac
      start=${{range%-*}}
      end=${{range#*-}}
      if dd if="/proc/$agent/mem" bs=1048576 iflag=skip_bytes,count_bytes \\
          skip=$((0x$start)) count=$((0x$end - 0x$start)) 2>/dev/null |
          grep -a -q -F -- "$KEY"; then
        found=true
        break
      fi
    done < "/proc/$agent/maps"
    emit {PROC_MEM} read "$found"
  fi
fi

# Path 4: every ancestor. The probe reads each one's environment and command line. An environment
# that is denied counts as empty, as it does for the startup check (ADR 0001 §8, CDA-72): a Tool
# Call is denied it too. The command line is open to every process, so an assignment such as
# ANTHROPIC_API_KEY=... in it exposes the key whatever the ancestor's hardening.
found=false
outcome=read
pid=$$
while :; do
  pid=$(ppid_of "$pid") || {{ outcome=INCOMPLETE; break; }}
  [ "$pid" -ge 1 ] 2>/dev/null || break
  if tr '\\0' '\\n' < "/proc/$pid/environ" 2>/dev/null | holds_key; then found=true; fi
  command_line=$(tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
  case "$command_line" in
    *"$KEY"*) found=true ;;
  esac
  if printf '%s' "$command_line" | grep -q -E "($NAMES)=[^ ]"; then found=true; fi
  [ "$pid" -gt 1 ] || break
done
emit {ANCESTORS} "$outcome" "$found"
"""


def parse_probe_output(text: str) -> list[Probe]:
    """The probe lines in `text`. Other lines, such as a Tool Result's status line, are skipped."""
    probes: list[Probe] = []
    for line in text.splitlines():
        if not line.startswith('{"path":'):
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        probes.append(Probe(path=data["path"], outcome=data["outcome"], found=data["found"]))
    return probes

#!/usr/bin/env bash
# Read bounded host facts only: no environment, command arguments or app data.
set -u

diagnostic_report="${1:-android-host-diagnostics.txt}"
diagnostic_cgroup="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
{
  date -u
  uname -r
  free -m
  df -h /
  ps -eo pid,ppid,stat,etimes,rss,comm | awk 'NR == 1 || $6 ~ /qemu|emulator/'
  for metric in memory.current memory.peak memory.max memory.events; do
    diagnostic_file="/sys/fs/cgroup${diagnostic_cgroup}/${metric}"
    if [[ -r "$diagnostic_file" ]]; then
      printf '%s\n' "$metric"
      cat "$diagnostic_file"
    fi
  done
  sudo -n dmesg --ctime 2>&1 \
    | grep -Ei 'out of memory|oom-kill|killed process|segfault|traps:|qemu|emulator' \
    | tail -n 60 | cut -c 1-500
} > "$diagnostic_report" 2>&1
# A diagnostic collection error must never replace the emulator test result.
exit 0

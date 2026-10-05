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
  # Read only the header, stream directory and numeric exception record.
  # Never copy crash dumps: other streams can contain memory or environment.
  python3 - <<'PYTHON'
from pathlib import Path
import struct

dumps = sorted(Path('/tmp/android-runner').glob('emu-crash-*.db/*/*.dmp'))[:8]
print(f'emulator minidumps: {len(dumps)} (capped at 8)')
for index, path in enumerate(dumps):
    try:
        with path.open('rb') as dump:
            header = dump.read(32)
            signature, version, count, directory, checksum, timestamp, flags = struct.unpack('<4sIIIIIQ', header)
            if signature != b'MDMP' or count > 128:
                print(f'minidump {index}: unsupported header')
                continue
            dump.seek(directory)
            streams = [struct.unpack('<III', dump.read(12)) for _ in range(count)]
            for kind, size, offset in streams:
                if kind == 6 and size >= 16:
                    dump.seek(offset)
                    thread, padding, code, exception_flags = struct.unpack('<IIII', dump.read(16))
                    print(f'minidump {index}: timestamp={timestamp} exception_code={code:#x} exception_flags={exception_flags:#x}')
                    break
            else:
                print(f'minidump {index}: no exception stream')
    except (OSError, ValueError, struct.error):
        print(f'minidump {index}: metadata unavailable')
PYTHON
} > "$diagnostic_report" 2>&1
# A diagnostic collection error must never replace the emulator test result.
exit 0

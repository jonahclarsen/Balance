#!/usr/bin/env python3
"""Read-only Chrome bridge. It cannot open planner data, run commands, or grant access."""
import json
import os
from pathlib import Path
import stat
import struct
import sys

STATUS = Path.home() / '.local/share/balance-situate/status.json'
def read_status(path=STATUS):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(path, flags), 'rb') as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError('Insecure status file')
        raw = source.read(512_001)
        if len(raw) > 512_000:
            raise ValueError('Status too large')
        value = json.loads(raw)
        # Allowlist the public contract even if the file is accidentally replaced.
        return {key: value[key] for key in ('version','modes','aiBlocked','countdownUntil','refreshAt','enabled','quizUrl') if key in value}

def main():
    while True:
        header = sys.stdin.buffer.read(4)
        if not header: return
        if len(header) != 4: return
        length, = struct.unpack('=I', header)
        if length > 1024: return
        raw = sys.stdin.buffer.read(length)
        if len(raw) != length: return
        try:
            message = json.loads(raw)
            if message != {'type':'status'}: raise ValueError('Unsupported request')
            response = read_status()
        except (ValueError, OSError):
            response = {'error':'Open Balance to enable Situate.'}
        encoded=json.dumps(response,separators=(',',':')).encode()
        sys.stdout.buffer.write(struct.pack('=I',len(encoded))+encoded)
        sys.stdout.buffer.flush()
if __name__ == '__main__': main()

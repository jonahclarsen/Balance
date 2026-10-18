#!/usr/bin/env python3
"""Copy only Frank Discord thread IDs over SSH; never transfer session contents."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import time

# Executed on the Frank host. Only dictionary keys leave that machine.
REMOTE = '''import json,re,sys
with open(sys.argv[1],encoding="utf-8") as source: sessions=json.load(source)
if not isinstance(sessions,dict): raise ValueError("Invalid session index")
print(json.dumps({"version":1,"threads":[key for key in sessions if re.fullmatch(r"[0-9]{15,22}",key)]}))
'''
def validate(value):
    if not isinstance(value,dict) or value.get('version') != 1 or not isinstance(value.get('threads'),list):
        raise ValueError('Invalid thread index')
    threads=value['threads']
    if len(threads)>10000 or any(not isinstance(i,str) or not re.fullmatch(r'[0-9]{15,22}',i) for i in threads):
        raise ValueError('Invalid thread IDs')
    return {'version':1,'threads':sorted(set(threads))}

def sync(host,source,destination):
    if host.startswith('-') or not re.fullmatch(r'[A-Za-z0-9_.@-]+',host): raise ValueError('Use an SSH host alias')
    command=shlex.join(['python3','-c',REMOTE,source])
    result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,command],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=30,check=True)
    if len(result.stdout)>300000: raise ValueError('Thread index too large')
    value=validate(json.loads(result.stdout))
    destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    descriptor,temporary=tempfile.mkstemp(prefix='.frank-',dir=destination.parent)
    try:
        with os.fdopen(descriptor,'w') as output:
            json.dump(value,output);output.flush();os.fsync(output.fileno())
        os.replace(temporary,destination)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host',required=True,help='SSH alias, e.g. oracle-arm')
    parser.add_argument('--sessions',required=True,help='Absolute sessions.json path on the Frank host')
    parser.add_argument('--watch',action='store_true',help='Refresh every 30 seconds; retain known IDs during outages')
    args=parser.parse_args()
    if not args.sessions.startswith('/'): parser.error('--sessions must be absolute')
    destination=Path.home()/'.local/share/balance-situate/frank-threads.json'
    while True:
        try: sync(args.host,args.sessions,destination)
        except (OSError,ValueError,subprocess.SubprocessError):
            if not args.watch: raise SystemExit('Could not refresh Frank thread IDs. Check the SSH alias and sessions path.')
            print('Frank refresh unavailable; retaining known thread IDs.',flush=True)
        if not args.watch: return
        time.sleep(30)
if __name__=='__main__': main()

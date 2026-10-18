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
threads=set()
for path in sys.argv[1:]:
 with open(path,encoding="utf-8") as source: sessions=json.load(source)
 if not isinstance(sessions,dict): raise ValueError("Invalid session index")
 threads.update(key for key in sessions if re.fullmatch(r"[0-9]{15,22}",key))
print(json.dumps({"version":1,"threads":sorted(threads)}))
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
    sources=[source] if isinstance(source,str) else source
    if not sources or any(not path.startswith('/') for path in sources): raise ValueError('Use absolute session index paths')
    command=shlex.join(['python3','-c',REMOTE,*sources])
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
    parser.add_argument('--sessions',required=True,action='append',help='Absolute sessions.json path; repeat for multiple instances on this host')
    parser.add_argument('--watch',action='store_true',help='Refresh every 30 seconds; retain known IDs during outages')
    args=parser.parse_args()
    if any(not path.startswith('/') for path in args.sessions): parser.error('--sessions must be absolute')
    destination=Path.home()/'.local/share/balance-situate/frank-threads.json'
    while True:
        try: sync(args.host,args.sessions,destination)
        except (OSError,ValueError,subprocess.SubprocessError):
            if not args.watch: raise SystemExit('Could not refresh Frank thread IDs. Check the SSH alias and sessions path.')
            print('Frank refresh unavailable; retaining known thread IDs.',flush=True)
        if not args.watch: return
        time.sleep(30)
if __name__=='__main__': main()

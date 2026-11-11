#!/usr/bin/env python3
"""Inventory committed business sources/assets without losing Unicode paths."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOTS = ['server', 'public', 'windows-agent/src', 'windows-agent/scripts']
EXTENSIONS = {'.mjs', '.js', '.py', '.json', '.html', '.css', '.md', '.svg', '.woff', '.woff2', '.ttf', '.jar'}
DIAGNOSTIC = {'windows-agent/scripts/smsrelay_fleet_preflight.mjs'}

def inventory(ref):
    commit = subprocess.check_output(['git', 'rev-parse', '--verify', ref+'^{commit}']).decode().strip()
    # -z returns original UTF-8 bytes; human-readable Git output quotes Chinese names.
    names = subprocess.check_output(['git', 'ls-tree', '-rz', '--name-only', commit, '--', *ROOTS]).decode('utf-8').split('\0')
    files = {}
    for name in names:
        if not name:
            continue
        path = Path(name)
        if (path.suffix not in EXTENSIONS or '/fixtures/' in name or '/test-fixtures/' in name
                or '/__pycache__/' in name or '.test.' in name
                or path.name.endswith('_test.py') or path.name.startswith('test_')
                or (name.startswith('server/') and path.suffix not in {'.mjs', '.json'})):
            continue
        role = 'runtime'
        if '.fixture.' in path.name:
            role = 'fixture'
        elif '/probes/' in name or name in DIAGNOSTIC:
            role = 'diagnostic'
        data = subprocess.check_output(['git', 'show', commit+':'+name])
        files[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'role': role}
    return {'sourceCommit': commit, 'scope': ROOTS, 'pathEncoding': 'Git NUL-delimited UTF-8', 'files': files}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--ref', default='HEAD')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = inventory(args.ref)
    encoded = json.dumps(result, ensure_ascii=False, indent=2)+'\n'
    if args.output:
        with args.output.open('x', encoding='utf-8') as output:
            output.write(encoded)
        print(json.dumps({'files': len(result['files']), 'unicodePaths': sum(not n.isascii() for n in result['files']), 'sourceCommit': result['sourceCommit']}))
    else:
        print(encoded, end='')

#!/usr/bin/env python3
"""CPS local client. Credentials come from an untracked private config file."""
import argparse
import hashlib
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def signature(body, secret):
    def text(value):
        if isinstance(value, bool):
            return 'true' if value else 'false'
        if not isinstance(value, (str, int)):
            raise ValueError('Only flat string/integer/boolean values are supported')
        return str(value)
    fields = [key + '=' + text(body[key]) for key in sorted(body)
              if key != 'sign' and body[key] is not None and body[key] != '']
    return hashlib.sha256(('&'.join(fields) + '&secret=' + secret).encode('utf-8')).hexdigest()


def display(value):
    if isinstance(value, dict):
        return {key: ('<已脱敏>' if key in ('sign', 'secret') else
                      item[:3] + '****' + item[-4:] if key == 'phone' and isinstance(item, str) and len(item) == 11 else
                      display(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [display(item) for item in value]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path,
                        default=Path(__file__).resolve().parent / 'client-config.private.json')
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('health')
    devices = sub.add_parser('devices')
    devices.add_argument('--online-only', action='store_true')
    dispatch = sub.add_parser('dispatch')
    dispatch.add_argument('device', choices=['200', '202'])
    dispatch.add_argument('--lead-id', type=int)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding='utf-8'))
    base = urllib.parse.urlsplit(config['base_url'])
    if base.scheme not in ('http', 'https') or base.username or base.password or base.query or base.fragment or base.path not in ('', '/'):
        parser.error('Invalid test base_url')
    if args.action == 'health':
        path, body = '/healthz', None
    else:
        if args.action == 'devices':
            path, body = '/api/v1/lead/devices/query', {'online_only': args.online_only}
        else:
            account = next(row for row in config['accounts'] if row['device_number'] == args.device)
            lead = args.lead_id if args.lead_id is not None else account['lead_id']
            if not 0 < lead <= 9223372036854775807:
                parser.error('lead_id must be a positive signed INT64')
            path = '/api/v1/lead/dispatch'
            body = {'lead_id': lead, 'phone': config['test_phone'],
                    **{key: account[key] for key in ('wecom_phone', 'wecom_corp_id', 'wecom_userid')}}
        body.update(app_id=config['app_id'], timestamp=time.time_ns() // 1000000,
                    nonce=secrets.token_hex(16))
        body['sign'] = signature(body, config['secret'])
    url = config['base_url'].rstrip('/') + path
    request = urllib.request.Request(url, method='GET' if body is None else 'POST',
                                     data=None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8'),
                                     headers={} if body is None else {'Content-Type': 'application/json; charset=utf-8'})
    # Test credentials must not be passed through a globally configured proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    except (urllib.error.URLError, TimeoutError):
        raise SystemExit('Response unconfirmed. Check the LAN address/service; for dispatch keep the original lead_id and business fields when retrying.')
    with response:
        try:
            answer = json.loads(response.read(1048576))
        except (ValueError, TimeoutError, OSError):
            raise SystemExit('Response unconfirmed. Preserve the original dispatch lead_id; do not create a new lead to retry.')
        output = {'request': {'method': request.method, 'url': url, 'body': display(body)},
                  'response': {'http_status': response.code, 'body': display(answer)}}
        print(json.dumps(output, ensure_ascii=False, indent=2))
        if response.code >= 400 or answer.get('success') is False:
            raise SystemExit(1)


if __name__ == '__main__':
    main()

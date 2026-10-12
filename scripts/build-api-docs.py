#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the static API reference from the candidate router + reviewed descriptions.

No application imports, services, credentials or network calls. The route inventory
fails closed when a router branch lacks a reviewed title. See docs/API_PORTAL.md.
"""
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = ROOT / 'releases/platform-api-docs-20261010-rc.1'


def masked(text):
    # Keep positions and newlines; hide JS literals/comments for brace matching.
    pattern = r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`|//[^\n]*|/\*[\s\S]*?\*/'
    return re.sub(pattern, lambda m: re.sub(r'[^\n]', ' ', m.group()), text)


def block(text, start):
    clean = masked(text)
    depth = 0
    for i in range(start, len(text)):
        if clean[i] == '{': depth += 1
        elif clean[i] == '}':
            depth -= 1
            if depth == 0: return text[start:i + 1]
    raise ValueError('Unbalanced source block')


def routes(source):
    matches = {}
    for m in re.finditer(r'const (\w+) = url\.pathname\.match\(/\^(.+?)\$/\);', source):
        pattern = m[2].replace('\\/', '/')
        n = [0]
        def param(_):
            n[0] += 1
            return '{p%d}' % n[0]
        matches[m[1]] = re.sub(r'\(\[\^/\]\+\)', param, pattern)
    result = []
    for m in re.finditer(r'^\s*if \(([^\n]*req\.method[^\n]*)\) \{', source, re.M):
        condition = m[1]
        direct = re.search(r'url\.pathname === "([^"]+)"', condition)
        variable = next((v for v in matches if re.search(r'\b' + v + r'\b', condition)), None)
        if not direct and not variable: continue
        path = direct[1] if direct else matches[variable]
        methods = re.findall(r'req\.method === "(GET|POST|PUT|DELETE|PATCH)"', condition)
        if not methods: methods = re.findall(r'"(GET|POST|PUT|DELETE|PATCH)"', condition)
        paths = [path.replace('(disable|enable)', a) for a in ['disable', 'enable']] if '(disable|enable)' in path else [path]
        body = block(source, source.index('{', m.end() - 1))
        for p in paths:
            for method in methods:
                result.append(dict(method=method, path=p, body=body, line=source.count('\n', 0, m.start()) + 1))
    return result


def make(candidate, publication_path=None):
    source = (candidate / 'server/index.mjs').read_text()
    reviewed = json.loads((ROOT / 'docs/api-reference-contracts.json').read_text())
    fields = reviewed['fields']
    endpoints = []
    seen = set()
    for route in routes(source):
        key = route['method'] + ' ' + route['path']
        if key in seen: raise ValueError('Duplicate route ' + key)
        seen.add(key)
        if key not in reviewed['endpoints']: raise ValueError('Unreviewed route ' + key)
        info = reviewed['endpoints'][key]
        body = route.pop('body')
        group, title, description = info[:3]
        extra = info[3] if len(info) > 3 else {}
        path = extra.get('path', route['path'])
        if 'open/' in path: auth = 'hmac'
        elif 'requireWindowsAgent(' in body: auth = 'windows'
        elif 'requireAuth(' in body:
            roles = re.search(r'requireAuth\(req, \[([^\]]+)\]', body)
            auth = ','.join(re.findall(r'"([a-z]+)"', roles[1])) if roles else 'special'
        elif 'evidence' in path: auth = 'admin / evidence-signature'
        elif '/internal/' in path: auth = 'media-hook'
        else: auth = 'public'
        auth = extra.get('auth', auth)
        direct_fields = set(re.findall(r'\binput\.(\w+)', body))
        # Helpers receive the whole object; include accepted fields, not just
        # fields present in the immediate HTTP handler.
        helpers = extra.get('inputHelpers', [])
        for helper in helpers:
            fm = re.search(r'function ' + re.escape(helper) + r'\(', source)
            if not fm: raise ValueError('Missing input helper ' + helper)
            helper_body = block(source, source.index('{\n', fm.start()))
            direct_fields.update(re.findall(r'\binput\.(\w+)', helper_body))
        parameters = []
        for name in re.findall(r'\{(\w+)\}', path):
            parameters.append(dict(name=name, location='path', type='string', required=True, description=fields.get(name, ['string', '资源标识'])[1]))
        required = extra.get('required', [])
        for name in sorted(direct_fields):
            if name not in fields: raise ValueError('Undescribed request field ' + key + ': ' + name)
            typ, desc = fields[name][:2]
            parameters.append(dict(name=name, location='body', type=typ, required=name in required, description=desc))
        for name in sorted(set(re.findall(r'url\.searchParams\.get\("([^\"]+)"\)', body))):
            typ, desc = fields.get(name, ['string', '可选筛选参数'])[:2]
            parameters.append(dict(name=name, location='query', type=typ, required=False, description=desc))
        for override in extra.get('parameters', []):
            parameters = [p for p in parameters if (p['name'], p['location']) != (override['name'], override['location'])]
            parameters.append(override)
        if route['method'] == 'GET': parameters = [p for p in parameters if p['location'] != 'body']
        errors = sorted(set(re.findall(r'error: "([^\"]+)"', body)))
        error_statuses = {}
        for code, error_name in re.findall(r'json\(res,\s*(\d+),\s*\{\s*error:\s*"([^\"]+)"', body):
            error_statuses.setdefault(error_name, []).append(int(code))
        # Reviewed helper errors are part of the public contract too; the
        # immediate route body cannot reveal validation/signature helpers.
        for error_name, statuses in extra.get('helperErrors', {}).items():
            error_statuses[error_name] = sorted(set(error_statuses.get(error_name, []) + statuses))
        errors = sorted(set(errors) | set(error_statuses))
        codes = sorted(set(int(n) for n in re.findall(r'json\(res, (\d+)', body)))
        success = [n for n in codes if n < 400] or [extra.get('successCode', 200)]
        scope = re.search(r'requireWindowsScope\(ctx, "([^\"]+)"', body)
        route.pop('path')
        endpoint = dict(**route, path=path, id=extra.get('id', re.sub(r'[^a-z0-9]+', '-', key.lower()).strip('-')),
                        group=group, title=title, description=description, auth=auth,
                        parameters=parameters, errors=errors, errorStatuses=error_statuses, successCodes=success,
                        scope=scope[1] if scope else extra.get('scope', ''),
                        **{k: v for k, v in extra.items() if k not in ['path', 'id', 'auth', 'inputHelpers', 'parameters', 'scope', 'successCode', 'helperErrors']})
        endpoints.append(endpoint)
    unknown = set(reviewed['endpoints']) - seen
    if unknown: raise ValueError('Removed/stale routes ' + str(unknown))
    publication = json.loads((publication_path or ROOT / 'docs/platform-api-publication.json').read_text())
    selected = [e for e in endpoints if e['group'] in publication['groups']]
    for endpoint in selected:
        endpoint['group'] = publication['endpointGroups'].get(endpoint['id'], endpoint['group'])
        if endpoint['group'] not in {g[0] for g in publication['publishedGroups']}:
            raise ValueError('Unassigned published business group: ' + endpoint['id'])
    # Publish only referenced models, including their recursive dependencies.
    needed = set()
    def include_type(typ):
        name = typ.replace('|null', '').replace('[]', '')
        if name not in reviewed['models'] or name in needed: return
        needed.add(name)
        for field in reviewed['models'][name]: include_type(field['type'])
    for endpoint in selected:
        for field in endpoint['response'].split(','): include_type(field.split(':')[1])
        for parameter in endpoint['parameters']: include_type(parameter['type'])
    data = dict(version=publication['version'], updatedAt=publication.get('updatedAt', '2026-10-10'),
                baseline=publication.get('baseline', 'lookup-20261010-rc.2'), status=publication.get('status', '本地候选 · 未发布'),
                routerSha256=hashlib.sha256(source.encode()).hexdigest(), sourceRoutesReviewed=len(endpoints),
                groups=publication['publishedGroups'], guides=publication['guides'],
                models={k: v for k, v in reviewed['models'].items() if k in needed},
                commonErrors=publication['commonErrors'], websockets=[], endpoints=selected)
    out = candidate / 'public/api-reference.json'
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    build_openapi(data, candidate / 'public/openapi.json', publication.get('openapiDescription'))
    if any(e['auth'] == 'hmac' for e in selected):
        build_handover(candidate, data)
    print('Reviewed', len(endpoints), 'routes; built', len(selected), 'platform HTTP operations and', len(data['websockets']), 'WebSocket channels ->', out)


def build_handover(candidate, data):
    """Package only reviewed public reference and unchanged dependency-free SDKs."""
    folder = candidate / 'public/downloads'
    folder.mkdir(exist_ok=True)
    signing = next(g['code'] for g in data['guides'] if g['id'] == 'authentication') + '\n'
    (folder / 'sign.mjs').write_text(signing)
    spec = json.loads((candidate / 'public/openapi.json').read_text())
    spec['info']['title'] = '支付宝查名字 · 第三方 HMAC Open API'
    spec['paths'] = {p: v for p, v in spec['paths'].items() if p.startswith('/api/v1/open/name-lookups/')}
    spec['components']['securitySchemes'].pop('Bearer', None)
    spec['tags'] = [t for t in spec['tags'] if t['name'] == 'lookup-user']
    needed = set()
    def visit(value):
        if isinstance(value, dict):
            if '$ref' in value:
                name = value['$ref'].split('/')[-1]
                if name not in needed:
                    needed.add(name)
                    visit(spec['components']['schemas'][name])
            for item in value.values(): visit(item)
        elif isinstance(value, list):
            for item in value: visit(item)
    visit(spec['paths'])
    spec['components']['schemas'] = {k: v for k, v in spec['components']['schemas'].items() if k in needed}
    (folder / 'name-lookup-openapi.json').write_text(json.dumps(spec, ensure_ascii=False, indent=2) + '\n')
    sdk = candidate / 'verification/fixtures/sdk/open_name_lookup'
    items = {'README.md': (sdk / 'README.md').read_bytes(),
             'OPEN_NAME_LOOKUP_API.md': (candidate / 'OPEN_NAME_LOOKUP_API.md').read_bytes(),
             'openapi.json': (folder / 'name-lookup-openapi.json').read_bytes(),
             'sign.mjs': signing.encode()}
    for name in ['node_client.mjs', 'python_client.py']: items[name] = (sdk / name).read_bytes()
    manifest = {'version': data['version'], 'businessBaseline': data['baseline'],
                'files': {name: hashlib.sha256(blob).hexdigest() for name, blob in items.items()}}
    items['SHA256.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    archive = folder / 'name-lookup-integration.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, blob in sorted(items.items()):
            info = zipfile.ZipInfo(name, (2026, 10, 12, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, blob)
    manifest['archiveSha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
    (folder / 'name-lookup-sha256.json').write_text(json.dumps(manifest, indent=2) + '\n')


def build_openapi(data, out, description=None):
    def schema(typ):
        if typ.endswith('|null'):
            return {'anyOf': [schema(typ[:-5]), {'type': 'null'}]}
        if typ.endswith('[]'): return {'type': 'array', 'items': schema(typ[:-2])}
        if typ in data['models']: return {'$ref': '#/components/schemas/' + typ}
        if typ == 'binary': return {'type': 'string', 'format': 'binary'}
        if typ not in ['string', 'number', 'integer', 'boolean', 'object']:
            raise ValueError('Unknown API schema type: ' + typ)
        return {'type': typ}
    doc = {'openapi': '3.1.0', 'info': {'title': 'Phone Cloud 平台功能 API', 'version': data['version'],
           'description': description or '平台功能文档候选；第三方支付宝查名使用HMAC，平台操作使用Bearer。请核对目标部署版本。'},
           'servers': [{'url': 'http://47.98.127.132', 'description': '当前平台HTTP根地址；其他部署使用管理员交付的BASE_URL'}],
           'tags': [{'name': g[0], 'description': g[1] + ' · ' + g[2]} for g in data['groups']],
           'paths': {}, 'components': {'securitySchemes': {
             'Bearer': {'type': 'http', 'scheme': 'bearer'},
             'HmacSignature': {'type': 'apiKey', 'in': 'header', 'name': 'X-Signature', 'description': 'HMAC-SHA256小写hex；还必须提供X-Client-Id/X-Timestamp/X-Nonce。仅后端使用密钥。'}},
             'schemas': {}}, 'x-websocket-channels': data['websockets']}
    if not any(e['auth'] == 'hmac' for e in data['endpoints']): doc['components']['securitySchemes'].pop('HmacSignature')
    for name, fields in data['models'].items():
        doc['components']['schemas'][name] = {'type': 'object', 'additionalProperties': True,
            'description': '平台模型列常用稳定字段，result/health/payload允许按任务类型扩展。',
            'properties': {f['name']: {**schema(f['type']), 'description': f['description']} for f in fields}}
    for e in data['endpoints']:
        response_properties = {name: schema(typ) for name, typ in (field.split(':') for field in e['response'].split(',')) if name != 'binary'}
        op = {'operationId': e['id'], 'summary': e['title'], 'description': e['description'],
              'tags': [e['group']], 'deprecated': e.get('deprecated', False),
              'security': [] if e['auth'] in ['public', 'media-hook'] else [{'HmacSignature': []}] if e['auth'] == 'hmac' else [{'Bearer': []}],
              'x-platform-auth': e['auth'], 'x-agent-scope': e.get('scope', ''),
              'parameters': [{'name': p['name'], 'in': p['location'], 'required': p['required'], 'description': p['description'], 'schema': schema(p['type'])} for p in e['parameters'] if p['location'] != 'body'],
              'responses': {str(code): {'description': '成功受理或幂等重放，任务完成需另查状态', 'content': {
                  'application/octet-stream' if e.get('binary') else 'application/json': {'schema': schema('binary') if e.get('binary') else {'type': 'object', 'properties': response_properties, 'additionalProperties': True}}}} for code in e['successCodes']}}
        if e['auth'] == 'hmac':
            op['parameters'] += [{'name': name, 'in': 'header', 'required': True, 'description': desc, 'schema': {'type': 'string'}} for name, desc in [('X-Client-Id', '管理员交付的客户端ID'), ('X-Timestamp', 'Unix毫秒字符串，默认容差5分钟'), ('X-Nonce', '每请求唯一，8–120字符A-Z/a-z/0-9/._:-')]]
        if e.get('idempotency'):
            op['parameters'].append({'name': 'Idempotency-Key', 'in': 'header', 'required': e['idempotency'] == 'required', 'description': '8–160字符A-Z/a-z/0-9/._:-；同业务重试保持同键，重新签名', 'schema': {'type': 'string', 'minLength': 8, 'maxLength': 160, 'pattern': '^[A-Za-z0-9._:-]{8,160}$'}})
        body_fields = [p for p in e['parameters'] if p['location'] == 'body']
        if e['method'] in ['POST', 'PUT', 'PATCH']:
            body_schema = schema('binary') if e.get('bodyFormat') else {'type': 'object', 'properties': {p['name']: {**schema(p['type']), 'description': p['description']} for p in body_fields}, 'additionalProperties': True}
            required = [p['name'] for p in body_fields if p['required']]
            if required and not e.get('bodyFormat'): body_schema['required'] = required
            op['requestBody'] = {'required': True, 'content': {e.get('bodyFormat', 'application/json'): {'schema': body_schema}}}
            if e.get('example') and not e.get('bodyFormat'): op['requestBody']['content']['application/json']['example'] = e['example']
        op['responses']['default'] = {'description': '错误；HTTP状态和error字符串见门户错误参考。扩展字段可包含session/detail/retryAfterSeconds。', 'content': {'application/json': {'schema': {'type': 'object', 'properties': {'error': {'type': 'string'}}, 'additionalProperties': True}}}}
        op['x-route-errors'] = e['errors']
        doc['paths'].setdefault(e['path'], {})[e['method'].lower()] = op
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('candidate', nargs='?', type=Path, default=DEFAULT)
    parser.add_argument('--publication', type=Path, help='Reviewed release metadata; defaults to the local candidate publication')
    args = parser.parse_args()
    make(args.candidate, args.publication)

from pathlib import Path
import json, hashlib, zipfile
root=Path(__file__).resolve().parent.parent
forbidden={'readyCount','idleCount','minimumReady','targetCount'}
expected={'ok','preparationId','status','ready','expiresAt'}
route='/api/v1/open/name-lookups/prepare'
for name in ['public/openapi.json','public/downloads/name-lookup-openapi.json']:
    document=json.loads((root/name).read_text())
    body=document['paths'][route]['post']['responses']['200']['content']['application/json']
    assert 'lookup_inflight_limit' not in document['paths'][route]['post']['x-route-errors']
    assert document['paths']['/api/v1/open/name-lookups/tasks']['post']['x-route-errors']['lookup_inflight_limit']==429
    assert set(body['schema']['properties'])==expected
    assert set(body['schema']['required'])==expected
    assert set(body['example'])==expected
    assert body['example']['ready'] is True and body['example']['status']=='ready'
    assert set(body['schema']['properties']['status']['enum'])=={'preparing','ready','expired'}
reference=json.loads((root/'public/api-reference.json').read_text())
endpoint=next(e for e in reference['endpoints'] if e['path']==route)
assert set(endpoint['response'].split(','))==expected
assert set(endpoint['responseExample'])==expected
for name in ['OPEN_NAME_LOOKUP_API.md','docs/OPEN_NAME_LOOKUP_API.md','sdk/open_name_lookup/README.md','sdk/open_name_lookup/PARTNER_HANDOFF.md']:
    assert not any(k in (root/name).read_text() for k in forbidden),name
with zipfile.ZipFile(root/'public/downloads/name-lookup-integration.zip') as z:
    checks=json.loads(z.read('SHA256.json'))
    for name,digest in checks.items():
        data=z.read(name)
        assert hashlib.sha256(data).hexdigest()==digest,name
        assert not any(k.encode() in data for k in forbidden),name
    assert z.read('OPEN_NAME_LOOKUP_API.md')==(root/'OPEN_NAME_LOOKUP_API.md').read_bytes()
    assert z.read('openapi.json')==(root/'public/downloads/name-lookup-openapi.json').read_bytes()
print('Public schema, examples, SDK bundle and checksums consistent; no device counts')

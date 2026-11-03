import json
import subprocess
import shutil
import unittest
from unittest.mock import patch
import wecom_qa_access as access


class RequestTests(unittest.TestCase):
    def test_get_uses_real_fetch_without_a_request_body(self):
        def cloud(code,body=None,timeout=7):
            script="""import http from 'node:http';
const server=http.createServer((req,res)=>{let n=0;req.on('data',b=>n+=b.length);req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({method:req.method,bytes:n}));});});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
"""
            script+=access.API.replace('127.0.0.1:8787',"127.0.0.1:'+server.address().port+'")
            script+='const input='+json.dumps(body)+';'+code+'\n}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}'
            r=subprocess.run([shutil.which('node'),'--input-type=module','-e',script],capture_output=True,text=True,timeout=5,
                             env={'ADMIN_API_TOKEN':'fake-local-only'})
            self.assertEqual(r.returncode,0,r.stderr[-400:])
            return json.loads(r.stdout)
        with patch.object(access,'cloud',side_effect=cloud):
            result=access.request('/api/v1/screen-sessions/fixture')
        self.assertEqual(result,dict(status=200,body=dict(method='GET',bytes=0)))

    def test_post_body_is_retained_and_delete_still_requires_original_session(self):
        calls=[]
        def cloud(code,body=None,timeout=7):
            calls.append(body)
            return dict(status=201,body=dict(session=dict(sessionId='fixture')))if body['method']=='POST'else dict(status=200)
        with patch.object(access,'cloud',side_effect=cloud):
            access.request('/api/v1/user/devices/fixture/screen-sessions','POST',{'test':1})
            access.request('/api/v1/screen-sessions/fixture','DELETE',{})
            with self.assertRaisesRegex(ValueError,'qa_not_owned_session'):
                access.request('/api/v1/screen-sessions/fixture','DELETE',{})
        self.assertEqual(calls[0]['body'],{'test':1});self.assertEqual(calls[1]['body'],{})


if __name__=='__main__':unittest.main()

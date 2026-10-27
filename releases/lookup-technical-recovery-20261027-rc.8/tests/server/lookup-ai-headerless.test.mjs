import test from 'node:test';
import assert from 'node:assert/strict';
import {validate,createAiVisionReader} from './lookup-ai-vision.mjs';
const phone='19900000000';
const sample=()=>({outcome:'name',searchPhone:phone,searchBox:[.13,.05,.97,.098],blocked:false,completeResult:true,headers:[],emptyMarker:'',emptyBoundary:'unknown',peopleHeaderBox:null,shortcutsHeaderBox:null,shortcuts:[],cards:[
 {displayName:'样例(**甲)',phone,accountLine:phone,transfer:true,addFriend:true,unverified:false,box:[.033,.1175,.967,.1906],nameBox:[.176,.1238,.374,.1463],phoneBox:[.212,.1525,.479,.1725]},
 {displayName:'样例(**甲)',phone:'1990…',accountLine:'test***@example.com(1990…',transfer:true,addFriend:true,unverified:false,box:[.033,.2006,.967,.2763],nameBox:[.176,.2088,.374,.2319],phoneBox:[.212,.2388,.639,.2594]}
]});
test('headerless full-phone card anchors result; clipped duplicate never supplies hidden digits',()=>{
 const v=sample();assert.equal(validate(v,phone).name,'样例(**甲)');
 v.cards.reverse();assert.equal(validate(v,phone).name,'样例(**甲)');
 v.cards[0].phone='1990...';v.cards[0].accountLine='test***@example.com（1990...）';assert.equal(validate(v,phone).name,'样例(**甲)');
});
for(const mode of ['no-anchor','no-search-box','cross-search-box','invalid-search-box','too-high','wrong-input','blocked','incomplete','nickname-conflict','tail-conflict','unverified','prefix-conflict','account-prefix-conflict','short-prefix','missing-ellipsis','full-other-number','missing-action','anchor-missing-action','overlap','different-label','out-of-bounds','truncated-anchor-line','invented-full-phone'])test('clipped/headerless negative '+mode,()=>{
 const v=sample(),a=v.cards[0],c=v.cards[1];
 switch(mode){
 case'no-anchor':v.cards=[c];break;
 case'no-search-box':delete v.searchBox;break;
 case'cross-search-box':v.searchBox[3]=.14;break;
 case'invalid-search-box':v.searchBox=[0,0,1,1];break;
 case'too-high':a.box[1]=.02;break;
 case'wrong-input':v.searchPhone='18800000000';break;
 case'blocked':v.blocked=true;break;
 case'incomplete':v.completeResult=false;break;
 case'nickname-conflict':c.displayName='另名(**甲)';break;
 case'tail-conflict':c.displayName='样例(**乙)';break;
 case'unverified':c.displayName='样例(未实名)';c.unverified=true;break;
 case'prefix-conflict':c.phone='1880…';break;
 case'account-prefix-conflict':c.accountLine='test***@example.com(1880…';break;
 case'short-prefix':c.phone='199…';c.accountLine='199…';break;
 case'missing-ellipsis':c.phone='1990';break;
 case'full-other-number':c.phone='18800000000';c.accountLine=c.phone;break;
 case'missing-action':c.transfer=false;break;
 case'anchor-missing-action':a.addFriend=false;break;
 case'overlap':c.box[1]=.18;break;
 case'different-label':c.accountLine='历史记录1990…';break;
 case'out-of-bounds':c.phoneBox[2]=1;break;
 case'truncated-anchor-line':a.accountLine='1990…';break;
 case'invented-full-phone':c.phone=phone;break;
 }
 assert.throws(()=>validate(v,phone));
});
test('full reader needs two matching readings for a headerless name and does not expose clipped data',async()=>{
 let calls=0;const reader=createAiVisionReader({enabled:true,baseUrl:'http://127.0.0.1',apiKey:'synthetic',timeoutMs:1000},{fetchImpl:async(_u,o)=>{
  calls++;const body=JSON.parse(o.body);assert.ok(body.text.format.schema.required.includes('searchBox'));
  return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(sample())}]}]}));
 }});const r=await reader.read({image:Buffer.from([137,80,78,71,13,10,26,10]),mimeType:'image/png',phoneNumber:phone});
 assert.equal(r.kind,'name');assert.equal(calls,2);assert.equal(r.name,'样例(**甲)');assert.equal(r.parsed,undefined);assert.ok(!JSON.stringify(r).includes('example.com'));
});

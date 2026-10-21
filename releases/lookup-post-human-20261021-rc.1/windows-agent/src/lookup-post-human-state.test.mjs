import test from 'node:test';import assert from 'node:assert/strict';import {classifyPostHumanPage} from './lookup-post-human-state.mjs';import {classifyHumanVerificationXml,createLookupHumanObserver} from './lookup-human-observer.mjs';
const f='mCurrentFocus=Window{a u0 com.eg.android.AlipayGphone/.SearchActivity}';
const cases=[
 [['请拖动滑块完成拼图','您请求次数过于频繁','待会来试试','刷新'],'present'],
 [['访问被拒绝','请关闭代理软件或VPN'],'account_limited'],
 [['您请求次数过于频繁','待会来试试','刷新'],'account_limited'],
 [['您的设备可能存在风险，请检查或切换设备','检查或切换设备后，请等待一段时间再试'],'account_limited'],
 [['短信验证码登录','其他验证方式','遇到问题'],'login_required'],
 [['本机号码一键登录','同意支付宝向运营商获取完整本机号码','换号'],'login_required'],
 [['账户尚未实名认证','立即认证'],'recoverable_page'],
 [['首页','理财','消息','我的'],'recoverable_page'],[['加载中...'],'loading'],[['网络不给力','重试'],'network_busy'],
 [['访问被拒绝'],'unknown'],[['短信验证码登录'],'unknown'],[['反馈码: synthetic'],'unknown'],[[],'search_ready']];
for(const [texts,want] of cases)test('post-human '+want+' '+texts.join('/'),()=>{
 assert.equal(classifyPostHumanPage(texts,{inputReady:true}),want);
 const xml='<hierarchy><node package="com.eg.android.AlipayGphone" resource-id="com.alipay.mobile.antui:id/search_input_box" enabled="true"/>'+texts.map(t=>`<node text="${t}"/>`).join('')+'</hierarchy>';
 assert.equal(classifyHumanVerificationXml(xml,f,f),want);
});
test('unknown pages and opaque views never manufacture success',()=>{
 assert.equal(classifyPostHumanPage(['unrecognised'],{}),'unknown');
 assert.equal(classifyPostHumanPage([],{inputReady:true,webview:true}),'unknown');
});
test('new state is propagated without page text, account or click',async()=>{
 const reports=[];const o=createLookupHumanObserver({agentId:'a',canObserve:()=>true,observe:async()=> 'account_limited',request:async(_p,args)=>args.method==='POST'?reports.push(args.body):{probes:[{probeId:'one'}]}});
 await o.poll();assert.equal(reports[0].state,'account_limited');assert.deepEqual(Object.keys(reports[0]).sort(),['probeId','readDurationMs','reason','state']);
});

test('foreground transition while reading never authorizes recovery',()=>{
 const xml='<hierarchy><node text="短信验证码登录"/><node text="其他验证方式"/><node text="遇到问题"/></hierarchy>';
 assert.equal(classifyHumanVerificationXml(xml,f,f.replace('.SearchActivity','.OtherActivity')),'unknown');
});

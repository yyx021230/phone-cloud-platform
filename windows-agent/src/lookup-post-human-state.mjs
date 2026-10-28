export function classifyPostHumanPage(texts, {inputReady=false, webview=false, loginActivity=false}={}) {
  const t=texts.map(x=>String(x||'').replace(/\s+/g,''));
  const has=(...xs)=>xs.every(x=>t.includes(x));
  if(t.some(x=>['为保障您的正常访问请进行验证','请拖动滑块完成拼图','向右滑动验证'].some(m=>x.includes(m))))return 'present';
  if(loginActivity || has('短信验证码登录','其他验证方式')&&t.some(x=>['换号','注册账号','遇到问题'].includes(x)) || has('本机号码一键登录','同意支付宝向运营商获取完整本机号码','换号'))return 'login_required';
  if(has('您请求次数过于频繁','待会来试试','刷新') || has('访问被拒绝')&&t.some(x=>x.includes('代理软件')&&x.toUpperCase().includes('VPN')) || has('您的设备可能存在风险，请检查或切换设备','检查或切换设备后，请等待一段时间再试') || has('操作频繁或访问异常，请稍后再试','请稍后'))return 'account_limited';
  if(webview || t.some(x=>['访问被拒绝','您的设备可能存在风险','操作频繁或访问异常','您请求次数过于频繁','待会来试试','反馈码:','短信验证码登录'].some(m=>x.includes(m))))return 'unknown';
  if(t.some(x=>['加载中','加载中...','正在加载','正在加载...'].includes(x)))return 'loading';
  if(has('网络不给力','重试')||has('网络异常','重新加载'))return 'network_busy';
  if(has('账户尚未实名认证','立即认证')||has('请完成实名认证','立即认证')||has('首页','理财','消息','我的'))return 'recoverable_page';
  return inputReady?'search_ready':'unknown';
}

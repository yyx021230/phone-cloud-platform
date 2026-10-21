"""Closed enum only; no device actions or account attribution."""
def classify_post_human_page(texts, input_ready=False, webview=False, login_activity=False):
    t = ["".join(str(x or "").split()) for x in texts]
    def has(*xs): return all(x in t for x in xs)
    if any(m in x for x in t for m in ("为保障您的正常访问请进行验证", "请拖动滑块完成拼图", "向右滑动验证")): return "present"
    if login_activity or (has("短信验证码登录", "其他验证方式") and any(x in t for x in ("换号", "注册账号", "遇到问题"))) or has("本机号码一键登录", "同意支付宝向运营商获取完整本机号码", "换号"): return "login_required"
    if has("您请求次数过于频繁", "待会来试试", "刷新") or (has("访问被拒绝") and any("代理软件" in x and "VPN" in x.upper() for x in t)) or has("您的设备可能存在风险，请检查或切换设备", "检查或切换设备后，请等待一段时间再试") or has("操作频繁或访问异常，请稍后再试", "请稍后"): return "account_limited"
    if webview or any(m in x for x in t for m in ("访问被拒绝", "您的设备可能存在风险", "操作频繁或访问异常", "您请求次数过于频繁", "待会来试试", "反馈码:", "短信验证码登录")): return "unknown"
    if any(x in t for x in ("加载中", "加载中...", "正在加载", "正在加载...")): return "loading"
    if has("网络不给力", "重试") or has("网络异常", "重新加载"): return "network_busy"
    if has("账户尚未实名认证", "立即认证") or has("请完成实名认证", "立即认证") or has("首页", "理财", "消息", "我的"): return "recoverable_page"
    return "search_ready" if input_ready else "unknown"

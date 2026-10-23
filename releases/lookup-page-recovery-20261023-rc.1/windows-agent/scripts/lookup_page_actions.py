"""Closed set of local OCR actions. Never accepts model-proposed coordinates."""
import re

def normalized(text):
    return re.sub(r'[\s“”"。；，,;]', '', str(text)).lower()

def entries(rows, size):
    w,h=size;out=[]
    if w<=0 or h<=0:return out
    for box,text,confidence in rows:
        try:
            xs=[float(p[0]) for p in box];ys=[float(p[1]) for p in box]
            x0,x1,y0,y1=min(xs),max(xs),min(ys),max(ys)
            if float(confidence)<.94 or not (0<=x0<x1<=w and 0<=y0<y1<=h):continue
            out.append((normalized(text),(x0+x1)/2,(y0+y1)/2,(x0,y0,x1,y1)))
        except (TypeError,ValueError,IndexError):continue
    return out

def action_box(rows,size,kind,phone=''):
    es=entries(rows,size);w,h=size
    def unique(label):
        found=[e for e in es if e[0]==normalized(label)]
        return found[0] if len(found)==1 else None
    if kind=='network_refresh':
        from alipay_visual_result import search_network_busy
        if not search_network_busy(rows,phone,size):return None
        target=unique('刷新')
    elif kind=='coloros_usb':
        # Full warning, not a random Ignore button in another permission prompt.
        text=''.join(e[0] for e in sorted(es,key=lambda e:(e[2]//24,e[1])))
        if not all(s in text for s in ['已允许usb传输数据','后再使用支付应用','存在被远程控制','泄露隐私的风险']):return None
        target,other=unique('忽略'),unique('仅充电')
        if not target or not other or not (target[1]<w*.45<other[1] and abs(target[2]-other[2])<h*.03):return None
    elif kind=='vivo_update':
        if not unique('系统升级') or not any('已经可以安装' in e[0] for e in es):return None
        target,other=unique('稍后提醒'),unique('现在安装')
        if not target or not other or not (target[2]>other[2] and abs(target[1]-other[1])<w*.12):return None
    else:return None
    if not target or not (w*.08<target[1]<w*.92 and h*.20<target[2]<h*.96):return None
    return target[3]

def stable_box(a,b,size):
    return bool(a and b and all(abs(x-y)<=max(6,min(size)*.015) for x,y in zip(a,b)))

def center(box):
    return round((box[0]+box[2])/2),round((box[1]+box[3])/2)

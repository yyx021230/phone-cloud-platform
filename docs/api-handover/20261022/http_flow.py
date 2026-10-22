#!/usr/bin/env python3
"""普通 requests 四接口示例；单进程演示，状态落盘，API Key 不落盘。"""
import argparse
import getpass
import hashlib
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit
import requests

BASE_URL = "http://47.98.127.132"
API = "/api/v1/open/name-lookups"
API_KEY = ""
STATE_FILE = Path("lookup-http-state.json")


def request(method, path, body=None, key=None, timeout=30):
    headers = {"X-API-Key": API_KEY}
    if key:
        headers["Idempotency-Key"] = key
    try:
        response = requests.request(method, BASE_URL + API + path,
                                    headers=headers, json=body,
                                    timeout=max(.1, min(30, timeout)), allow_redirects=False)
        with response:
            try:
                value = response.json()
            except ValueError:
                raise RuntimeError("非JSON响应：保留状态文件，稍后原命令重试") from None
            if not isinstance(value, dict):
                raise RuntimeError("响应格式错误：不要写成空姓名")
            if (response.status_code == 503 and
                    value.get("code") == "lookup_no_available_device" and
                    value.get("accepted") is False):
                # 明确未受理，不把它伪装成已排队，也不反复POST号码。
                headers = getattr(response, "headers", {})
                value["retryAfterSeconds"] = retry_seconds(value, headers.get("Retry-After"))
                return value
            if response.status_code not in (200, 202):
                code = str(value.get("code", "unexpected_response"))
                if not re.fullmatch(r"[A-Za-z0-9_.:-]+", code):
                    code = "unexpected_response"
                raise RuntimeError(f"HTTP {response.status_code} / {code}；429或5xx等5秒后原命令重试")
            return value
    except requests.RequestException:
        raise RuntimeError("网络结果未知：保留状态文件，原命令重试，不生成新业务编号") from None


def retry_seconds(value, header=None):
    values = [30]
    for item in (header, value.get("retryAfterSeconds")):
        try:
            number = int(item)
            if number > 0:
                values.append(number)
        except (ValueError, TypeError, OverflowError):
            pass
    return max(values)


def remember_capacity(state, value):
    if (value.get("code") == "lookup_no_available_device" or
            value.get("acceptingRequests") is False):
        state["sendPauseUntil"] = time.time() + retry_seconds(value)
        state["sendPauseCode"] = value.get("code") or "lookup_not_ready"
        save(state)
    elif value.get("acceptingRequests") is True:
        state.pop("sendPauseUntil", None)
        state.pop("sendPauseCode", None)
        save(state)


def paused_response(seconds=30, code="lookup_no_available_device"):
    return {"ok": False, "code": code,
            "accepted": False, "retryAfterSeconds": max(1, int(seconds)),
            "localSubmissionPaused": True}


def save(state):
    # 请求键必须在发POST之前保存，避免响应丢失后重复创建。
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_FILE.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as f:
        os.chmod(temporary, 0o600)
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    temporary.replace(STATE_FILE)


def load():
    binding = hashlib.sha256((BASE_URL + "\n" + API_KEY).encode()).hexdigest()
    if not STATE_FILE.exists():
        state = {"binding": binding, "round": None, "jobs": {}}
        save(state)
        return state
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    if state.get("binding") != binding:
        raise RuntimeError("状态文件属于另一地址或Key；不要混用或删除原进度")
    return state


def prepare(state, wait_seconds=120, new_round=False):
    old = state.get("round")
    if new_round and old:
        current = request("POST", "/prepare", {}, old["key"])
        if current.get("status") != "stopped":
            raise RuntimeError("当前轮次尚未确认停止，请等待stopped后再开启新一轮")
    if not old or new_round:
        state["round"] = {"key": "prepare-" + str(uuid.uuid4())}
        save(state)
    rd = state["round"]
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        value = request("POST", "/prepare", {}, rd["key"], deadline - time.monotonic())
        if value.get("ok") is not True or not value.get("preparationId"):
            raise RuntimeError("准备响应不完整")
        rd.update(preparationId=value["preparationId"], status=value.get("status"),
                  acceptingRequests=value.get("acceptingRequests"))
        save(state)
        remember_capacity(state, value)
        status = value.get("status")
        if status in ("expired", "stopping", "stopped"):
            return value
        if (status == "ready" and value.get("ready") is True and
                value.get("acceptingRequests") is not False):
            return value
        if status not in ("ready", "preparing"):
            raise RuntimeError("未知准备状态")
        interval = retry_seconds(value) if value.get("acceptingRequests") is False else 5
        time.sleep(max(0, min(interval, deadline - time.monotonic())))
    return {"localWaitTimedOut": True, "preparationId": rd.get("preparationId"),
            "message": "准备仍在继续，原prepare命令重试；不要换键"}


def submit(state, phone, business_id):
    if not re.fullmatch(r"1[3-9][0-9]{9}", phone):
        raise ValueError("手机号填写11位数字字符串，不带+86")
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", business_id):
        raise ValueError("业务编号使用字母、数字、点、下划线、冒号、短横线")
    digest = hashlib.sha256(phone.encode()).hexdigest()
    job = state["jobs"].get(business_id)
    if job and job["phoneHash"] != digest:
        raise RuntimeError("同一业务编号不能换手机号")
    if job and job.get("lookupId"):
        # 重复运行同一业务只读取原结果，不再提交。
        value = request("GET", "/tasks/" + quote(job["lookupId"], safe=""))
        remember_capacity(state, value)
        return value
    if not state.get("round"):
        raise RuntimeError("先运行prepare并等ready:true")
    if not job or job.get("confirmedNotAccepted"):
        remaining = state.get("sendPauseUntil", 0) - time.time()
        if remaining > 0:
            return paused_response(remaining + 1, state.get("sendPauseCode", "lookup_no_available_device"))
        value = request("POST", "/prepare", {}, state["round"]["key"])
        remember_capacity(state, value)
        if value.get("status") in ("ready", "preparing") and value.get("acceptingRequests") is False:
            return paused_response(retry_seconds(value), value.get("code", "lookup_not_ready"))
        if value.get("status") != "ready" or value.get("ready") is not True:
            raise RuntimeError("尚未就绪：先prepare，或在主动结束后显式新开一轮")
        if not job:
            job = {"phoneHash": digest, "key": "query-" + str(uuid.uuid4())}
            state["jobs"][business_id] = job
            save(state)
    # 未收到提交响应时保留原键；即使本轮已结束，也先对账原提交。
    job.pop("confirmedNotAccepted", None)
    save(state)
    value = request("POST", "/tasks", {"phoneNumber": phone}, job["key"])
    remember_capacity(state, value)
    if value.get("code") == "lookup_no_available_device" and value.get("accepted") is False:
        job["confirmedNotAccepted"] = True
        save(state)
        return value
    if value.get("ok") is not True or not isinstance(value.get("lookupId"), str):
        raise RuntimeError("提交响应没有lookupId；保留原键排查")
    job.update(lookupId=value["lookupId"], status=value.get("status"))
    job.pop("confirmedNotAccepted", None)
    save(state)
    return value


def result(state, business_id, wait_seconds=120):
    job = state["jobs"].get(business_id)
    if not job or not job.get("lookupId"):
        raise RuntimeError("还没有lookupId；先用原业务编号和原手机号重试submit")
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        value = request("GET", "/tasks/" + quote(job["lookupId"], safe=""),
                        timeout=deadline - time.monotonic())
        if value.get("lookupId") != job["lookupId"]:
            raise RuntimeError("lookupId不一致")
        status = value.get("status")
        if status == "completed":
            if value.get("ok") is not True or not isinstance(value.get("name"), str):
                raise RuntimeError("完成响应缺少name，不可写空姓名")
            job.update(status=status, name=value["name"])
            save(state)
            return value
        if status == "failed":
            job.update(status=status, code=value.get("code"))
            save(state)
            return value
        if status not in ("queued", "processing"):
            raise RuntimeError("未知查询状态")
        remember_capacity(state, value)
        interval = retry_seconds(value) if value.get("code") == "lookup_no_available_device" else 5
        time.sleep(max(0, min(interval, deadline - time.monotonic())))
    return {"localWaitTimedOut": True, "lookupId": job["lookupId"],
            "message": "服务器任务继续；稍后用同一business_id运行result"}


def stop(state, wait_seconds=120):
    rd = state.get("round")
    if not rd or not rd.get("preparationId"):
        raise RuntimeError("需要prepare返回的preparationId；先用原prepare键读取")
    pid = rd["preparationId"]
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        value = request("POST", "/stop", {"preparationId": pid}, "stop-" + pid,
                        deadline - time.monotonic())
        if (value.get("ok") is not True or value.get("preparationId") != pid or
                (value.get("status"), value.get("stopped")) not in (("stopping", False), ("stopped", True))):
            raise RuntimeError("停止响应无效，保留原轮次排查")
        rd["status"] = value["status"]
        save(state)
        if value["stopped"]:
            return value
        time.sleep(max(0, min(5, deadline - time.monotonic())))
    return {"localWaitTimedOut": True, "preparationId": pid,
            "message": "尚未确认停止；原stop命令重试，不开启新轮次"}


def main():
    global API_KEY, BASE_URL, STATE_FILE
    parser = argparse.ArgumentParser(description="普通HTTP：准备、提交、取结果、结束本轮")
    parser.add_argument("--state", default="lookup-http-state.json")
    parser.add_argument("--base-url", default=BASE_URL)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("prepare");p.add_argument("--new-round", action="store_true")
    p = sub.add_parser("submit");p.add_argument("phone");p.add_argument("business_id")
    p = sub.add_parser("result");p.add_argument("business_id")
    sub.add_parser("stop")
    args = parser.parse_args()
    u = urlsplit(args.base_url)
    if u.scheme not in ("http", "https") or not u.netloc or u.username or u.password or u.path not in ("", "/") or u.query or u.fragment:
        raise ValueError("base-url只填写服务器地址")
    BASE_URL = args.base_url.rstrip("/");STATE_FILE = Path(args.state)
    API_KEY = os.environ.get("API_KEY") or getpass.getpass("API Key（输入不显示）: ")
    if not API_KEY:
        raise ValueError("缺少API Key")
    state = load()
    if args.action == "prepare":value = prepare(state, new_round=args.new_round)
    elif args.action == "submit":value = submit(state, args.phone, args.business_id)
    elif args.action == "result":value = result(state, args.business_id)
    else:value = stop(state)
    print(json.dumps(value, ensure_ascii=False, indent=2))
    if value.get("accepted") is False:return 3
    if value.get("localWaitTimedOut") or value.get("status") == "failed":return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)

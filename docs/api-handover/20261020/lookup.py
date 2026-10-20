#!/usr/bin/env python3
"""普通 HTTP 完整示例：pip install requests；python lookup.py。
没有 SDK；三个接口都通过下方 requests.request 发 HTTP 请求。
"""
import argparse
import getpass
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
import uuid
from email.utils import parsedate_to_datetime
from urllib.parse import quote, urlsplit
import requests

API = "/api/v1/open/name-lookups"


class ApiError(Exception):
    def __init__(self, code, retryable=False, retry_after=5):
        super().__init__(code)
        self.code, self.retryable, self.retry_after = code, retryable, retry_after


def http_request(method, path, body, request_key, base_url, api_key, timeout=30):
    """普通HTTP请求；只带一个固定API Key，查名接口共用。"""
    raw = b"" if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {"X-API-Key": api_key}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if request_key:
        headers["Idempotency-Key"] = request_key
    try:
        # 普通HTTP；不跳转，避免将密钥发送到其他地址。
        with requests.request(method, base_url + path, headers=headers,
                              data=raw if body is not None else None,
                              timeout=max(0.001, min(30, timeout)), allow_redirects=False) as response:
            try:
                result = response.json()
            except ValueError:
                result = None
            if not 200 <= response.status_code < 300:
                code = str(result.get("code") or result.get("error") or "http_" + str(response.status_code)) if isinstance(result, dict) else "http_" + str(response.status_code)
                retry_after = 5
                header = response.headers.get("Retry-After", "")
                try:
                    retry_after = max(5, int(header) if header.isdigit() else parsedate_to_datetime(header).timestamp() - time.time())
                except (ValueError, TypeError, OverflowError):
                    pass
                raise ApiError(code if re.fullmatch(r"[A-Za-z0-9_.:-]+", code) else "http_" + str(response.status_code),
                               response.status_code == 429 or response.status_code >= 500, retry_after)
    except requests.RequestException:
        raise ApiError("network_error", True) from None
    if not isinstance(result, dict):
        raise ApiError("invalid_response")
    return result


def open_state(filename):
    db = sqlite3.connect(filename, timeout=10)
    db.row_factory = sqlite3.Row
    with db:
        db.execute("""CREATE TABLE IF NOT EXISTS lookup_jobs (
            business_id TEXT PRIMARY KEY, binding TEXT NOT NULL,
            prepare_key TEXT NOT NULL, submit_key TEXT NOT NULL, lookup_id TEXT)""")
    return db


def load_job(db, phone, business_id, base_url, api_key):
    binding = hashlib.sha256(json.dumps([base_url, api_key, phone], separators=(",", ":")).encode()).hexdigest()
    # 发HTTP请求前先保存请求键；同时运行同一业务也只生成一条记录。
    with db:
        db.execute("INSERT OR IGNORE INTO lookup_jobs VALUES (?,?,?,?,NULL)",
                   (business_id, binding, str(uuid.uuid4()), str(uuid.uuid4())))
    job = dict(db.execute("SELECT * FROM lookup_jobs WHERE business_id=?", (business_id,)).fetchone())
    if job["binding"] != binding:
        raise ValueError("业务编号已用于其他手机号或客户，请使用新的业务编号")
    return job


def query_name(phone_number, business_id, api_key,
               base_url="http://47.98.127.132", state_db="lookup-api-key-state.sqlite3",
               wait_seconds=120, progress=None, clock=time.monotonic, sleep=time.sleep):
    """输入手机号，自动按HTTP三步查询。completed时读取name；pending时继续原业务。"""
    if not api_key:
        raise ValueError("缺少 API Key")
    if not isinstance(phone_number, str) or not re.fullmatch(r"1\d{10}", phone_number):
        raise ValueError("手机号必须是11位字符串")
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", business_id):
        raise ValueError("业务编号只能包含字母、数字、点、下划线、冒号、短横线")
    if not math.isfinite(wait_seconds) or wait_seconds <= 0:
        raise ValueError("wait_seconds 必须大于0")
    url = urlsplit(base_url)
    if (url.scheme not in ("http", "https") or not url.netloc or url.username or
            url.password or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("base_url 只能填写服务器地址")
    base_url = base_url.rstrip("/")
    progress = progress or (lambda message: None)
    db = open_state(state_db)
    try:
        job = load_job(db, phone_number, business_id, base_url, api_key)
        deadline, ready = clock() + wait_seconds, False
        pause = lambda seconds: sleep(max(0, min(seconds, deadline - clock())))
        def call(method, path, body=None, key=None):
            return http_request(method, path, body, key, base_url, api_key, deadline - clock())
        def renew_preparation():
            with db:
                db.execute("UPDATE lookup_jobs SET prepare_key=? WHERE business_id=? AND prepare_key=?",
                           (str(uuid.uuid4()), business_id, job["prepare_key"]))
            job["prepare_key"] = db.execute("SELECT prepare_key FROM lookup_jobs WHERE business_id=?", (business_id,)).fetchone()[0]
        while clock() < deadline:
            try:
                # 第3步：GET 获取结果。已有lookupId，重跑时直接走这里。
                if job["lookup_id"]:
                    result = call("GET", API + "/tasks/" + quote(job["lookup_id"], safe=""))
                    if result.get("lookupId") != job["lookup_id"]:
                        raise ApiError("lookup_id_mismatch")
                    if result.get("status") == "failed":
                        code = str(result.get("code", "unknown"))
                        raise ApiError("lookup_failed:" + (code if re.fullmatch(r"[A-Za-z0-9_.:-]+", code) else "unknown"))
                    if result.get("ok") is not True:
                        raise ApiError("invalid_result")
                    if result.get("status") == "completed":
                        if not isinstance(result.get("name"), str):
                            raise ApiError("completed_without_name")
                        return {"status": "completed", "lookupId": job["lookup_id"], "name": result["name"]}
                    if result.get("status") not in ("queued", "processing"):
                        raise ApiError("unknown_lookup_status")
                    progress("正在排队或查询，继续等原任务")
                    pause(5)
                    continue
                # 第1步：POST 启动准备，正文就是 {}。
                if not ready:
                    result = call("POST", API + "/prepare", {}, job["prepare_key"])
                    if result.get("ok") is not True:
                        raise ApiError("prepare_failed")
                    if result.get("status") in ("expired", "stopping", "stopped"):
                        raise ApiError("lookup_round_stopped")
                    if result.get("status") == "ready" and result.get("ready") is True:
                        ready = True
                    elif result.get("status") == "preparing":
                        progress("等待平台准备就绪")
                        pause(5)
                        continue
                    else:
                        raise ApiError("unknown_prepare_status")
                if clock() >= deadline:
                    break
                # 第2步：POST 提交手机号，正文只有 phoneNumber。
                result = call("POST", API + "/tasks", {"phoneNumber": phone_number}, job["submit_key"])
                if result.get("ok") is not True or not isinstance(result.get("lookupId"), str) or not result["lookupId"]:
                    raise ApiError("submit_without_lookup_id")
                with db:
                    db.execute("UPDATE lookup_jobs SET lookup_id=? WHERE business_id=? AND lookup_id IS NULL", (result["lookupId"], business_id))
                saved_id = db.execute("SELECT lookup_id FROM lookup_jobs WHERE business_id=?", (business_id,)).fetchone()[0]
                if saved_id != result["lookupId"]:
                    raise ApiError("same_business_different_lookup_id")
                job["lookup_id"] = saved_id
                progress("提交成功，开始获取结果")
            except ApiError as error:
                if error.code == "lookup_preparation_expired":
                    renew_preparation()
                    ready = False
                    pause(1)
                    continue
                if error.code == "lookup_not_ready":
                    ready = False
                if not error.retryable:
                    raise
                progress("暂时不可用或网络异常，保留原任务并重试")
                pause(error.retry_after)
        return dict(status="pending", **({"lookupId": job["lookup_id"]} if job["lookup_id"] else {}))
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description="普通HTTP查名示例：直接运行后按提示输入。")
    parser.add_argument("phone", nargs="?")
    parser.add_argument("business_id", nargs="?")
    args = parser.parse_args()
    api_key = os.environ.get("API_KEY") or getpass.getpass("API Key（不显示）：")
    phone = args.phone or input("手机号：").strip()
    business_id = args.business_id or input("业务编号（例如 order-001；重试保持不变）：").strip()
    result = query_name(phone, business_id, api_key,
                        base_url=os.environ.get("BASE_URL", "http://47.98.127.132"),
                        state_db=os.environ.get("LOOKUP_STATE_DB", "lookup-api-key-state.sqlite3"),
                        wait_seconds=float(os.environ.get("WAIT_SECONDS", "120")),
                        progress=lambda message: print(message, file=sys.stderr))
    print(json.dumps(result, ensure_ascii=False))
    if result["status"] == "pending":
        print("本轮等待结束，使用同一业务编号再运行即可续查。保留 lookup-api-key-state.sqlite3。", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ApiError, ValueError, sqlite3.Error, OSError, EOFError) as error:
        print("查询未完成：" + str(error) + "；保留原请求排查，这不代表没名字。", file=sys.stderr)
        sys.exit(1)

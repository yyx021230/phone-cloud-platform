#!/usr/bin/env python3
"""普通HTTP结束本轮：pip install requests；python stop_lookup.py。
preparationId 来自启动 prepare 响应。重复运行同一编号只会续查停止状态。
"""
import getpass
import math
import os
import re
import time
from urllib.parse import urlsplit
import requests


def stop_round(preparation_id, api_key, base_url="http://47.98.127.132", wait_seconds=120):
    if not re.fullmatch(r"[A-Za-z0-9-]{1,80}", preparation_id or ""):
        raise ValueError("填写 prepare 返回的 preparationId")
    if not api_key:
        raise ValueError("缺少 API Key")
    url = urlsplit(base_url)
    if (url.scheme not in ("http", "https") or not url.netloc or url.username or
            url.password or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("base_url 只能填写服务器地址")
    if not math.isfinite(wait_seconds) or wait_seconds <= 0:
        raise ValueError("wait_seconds 必须大于0")
    headers = {"X-API-Key": api_key, "Idempotency-Key": "stop-" + preparation_id}
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        try:
            with requests.post(base_url.rstrip("/") + "/api/v1/open/name-lookups/stop",
                               headers=headers, json={"preparationId": preparation_id},
                               timeout=max(.001, min(30, deadline - time.monotonic())),
                               allow_redirects=False) as response:
                if response.status_code == 429 or response.status_code >= 500:
                    # 同一轮次、同一请求键重试，绝不创建新轮次。
                    pass
                elif response.status_code not in (200, 202):
                    raise RuntimeError("结束请求失败，HTTP " + str(response.status_code))
                else:
                    try:
                        result = response.json()
                    except ValueError:
                        raise RuntimeError("响应不是JSON") from None
                    if (not isinstance(result, dict) or result.get("ok") is not True or
                            result.get("preparationId") != preparation_id or
                            (result.get("status"), result.get("stopped")) not in
                            (("stopping", False), ("stopped", True))):
                        raise RuntimeError("停止状态无效，请保留原 preparationId 排查")
                    if result["stopped"]:
                        return result
        except requests.RequestException:
            pass
        time.sleep(max(0, min(5, deadline - time.monotonic())))
    # 只是调用方等待超时；尚未确认服务器完成停止，不能开始下一轮。
    return {"preparationId": preparation_id, "status": "pending", "stopped": False}


if __name__ == "__main__":
    key = os.environ.get("API_KEY") or getpass.getpass("API Key（输入不显示）: ")
    preparation_id = input("prepare 返回的 preparationId: ").strip()
    result = stop_round(preparation_id, key)
    print(result)
    if not result["stopped"]:
        print("停止尚未确认；稍后用同一 preparationId 再运行。")
        raise SystemExit(2)

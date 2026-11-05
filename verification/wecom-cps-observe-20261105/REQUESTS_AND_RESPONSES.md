# CPS本地观察测试：完整请求与响应

时间：2026-11-05 10:59:49–11:02:27（Asia/Shanghai）。

这是实际回环HTTP与200/202本地真机预览，内部使用Mac原生测试适配器，不是正式Windows SYSTEM Agent链路。生产未连接、未更新。

以下业务字段完整保留；按用户要求，企微登录手机号wecom_phone明文展示，客户手机号phone和签名sign继续脱敏，不能直接重放。企业/成员标识为本地测试资料。响应头的Content-Length来自脱敏前原响应。请求仅列应用设置的Content-Type；HTTP客户端自动生成的传输头没有逐项采集。

流程：查全部设备 → 下发202 → 同lead_id重试 → 查运行占用 → 下发200 → 查最终设备状态。调度tick为测试控制器内部操作，不是第四个对外接口。

## 1. /api/v1/lead/devices/query · 2026-11-05T02:59:54.364Z

请求：
```http
POST http://127.0.0.1:50959/api/v1/lead/devices/query
Content-Type: application/json; charset=utf-8
```

```json
{
  "online_only": false,
  "app_id": "cps_local_observe",
  "timestamp": 1793847594255,
  "nonce": "be995236e9ff3063670ba57a",
  "sign": "<已脱敏>"
}
```

响应 HTTP 200：
```json
{
  "status": 200,
  "headers": {
    "cache-control": "no-store",
    "connection": "keep-alive",
    "content-length": "1095",
    "content-type": "application/json; charset=utf-8",
    "date": "Thu, 05 Nov 2026 02:59:54 GMT",
    "keep-alive": "timeout=5"
  },
  "body": {
    "result": {
      "devices": [
        {
          "device_number": "200",
          "device_name": "200号本地测试手机",
          "online": true,
          "adb_online": true,
          "agent_online": true,
          "listed": true,
          "busy": false,
          "busy_reason": "",
          "occupancy": null,
          "accounts": [
            {
              "app_slot": "main",
              "binding_verified": true,
              "enabled": true,
              "wecom_phone": "17508437040",
              "available": true,
              "unavailable_reason": ""
            }
          ],
          "available": true,
          "unavailable_reason": "",
          "last_seen_at": "2026-11-05T02:59:54.360Z",
          "adb_last_seen_at": "2026-11-05T02:59:54.360Z"
        },
        {
          "device_number": "202",
          "device_name": "202号本地测试手机",
          "online": true,
          "adb_online": true,
          "agent_online": true,
          "listed": true,
          "busy": false,
          "busy_reason": "",
          "occupancy": null,
          "accounts": [
            {
              "app_slot": "main",
              "binding_verified": true,
              "enabled": true,
              "wecom_phone": "13067238489",
              "available": true,
              "unavailable_reason": ""
            }
          ],
          "available": true,
          "unavailable_reason": "",
          "last_seen_at": "2026-11-05T02:59:54.360Z",
          "adb_last_seen_at": "2026-11-05T02:59:54.360Z"
        }
      ],
      "total": 2,
      "updated_at": "2026-11-05T02:59:54.360Z",
      "capacity": {
        "limit": 2,
        "active": 0,
        "remaining": 2
      }
    },
    "timestamp": 1793847594361,
    "success": true,
    "code": 200,
    "message": "查询成功"
  }
}
```

## 2. /api/v1/lead/dispatch · 2026-11-05T03:00:08.163Z

请求：
```http
POST http://127.0.0.1:50959/api/v1/lead/dispatch
Content-Type: application/json; charset=utf-8
```

```json
{
  "lead_id": 61104202,
  "phone": "136****6441",
  "wecom_phone": "13067238489",
  "wecom_corp_id": "local_test_corp",
  "wecom_userid": "local_test_member_202",
  "app_id": "cps_local_observe",
  "timestamp": 1793847608032,
  "nonce": "6206a16723b3152644730a1b",
  "sign": "<已脱敏>"
}
```

响应 HTTP 200：
```json
{
  "status": 200,
  "headers": {
    "cache-control": "no-store",
    "connection": "keep-alive",
    "content-length": "125",
    "content-type": "application/json; charset=utf-8",
    "date": "Thu, 05 Nov 2026 03:00:08 GMT",
    "keep-alive": "timeout=5"
  },
  "body": {
    "result": null,
    "timestamp": 1793847608162,
    "success": true,
    "code": 200,
    "message": "已接收（本地预览，不发送邀请）"
  }
}
```

## 3. /api/v1/lead/dispatch · 2026-11-05T03:00:22.281Z

请求：
```http
POST http://127.0.0.1:50959/api/v1/lead/dispatch
Content-Type: application/json; charset=utf-8
```

```json
{
  "lead_id": 61104202,
  "phone": "136****6441",
  "wecom_phone": "13067238489",
  "wecom_corp_id": "local_test_corp",
  "wecom_userid": "local_test_member_202",
  "app_id": "cps_local_observe",
  "timestamp": 1793847622265,
  "nonce": "3204dfcfcaef22d20c65bdae",
  "sign": "<已脱敏>"
}
```

响应 HTTP 200：
```json
{
  "status": 200,
  "headers": {
    "cache-control": "no-store",
    "connection": "keep-alive",
    "content-length": "89",
    "content-type": "application/json; charset=utf-8",
    "date": "Thu, 05 Nov 2026 03:00:22 GMT",
    "keep-alive": "timeout=5"
  },
  "body": {
    "result": null,
    "timestamp": 1793847622280,
    "success": true,
    "code": 200,
    "message": "已接收"
  }
}
```

## 4. /api/v1/lead/devices/query · 2026-11-05T03:00:22.359Z

请求：
```http
POST http://127.0.0.1:50959/api/v1/lead/devices/query
Content-Type: application/json; charset=utf-8
```

```json
{
  "online_only": false,
  "app_id": "cps_local_observe",
  "timestamp": 1793847622283,
  "nonce": "a59ac66be458b84a98a5e0c0",
  "sign": "<已脱敏>"
}
```

响应 HTTP 200：
```json
{
  "status": 200,
  "headers": {
    "cache-control": "no-store",
    "connection": "keep-alive",
    "content-length": "1185",
    "content-type": "application/json; charset=utf-8",
    "date": "Thu, 05 Nov 2026 03:00:22 GMT",
    "keep-alive": "timeout=5"
  },
  "body": {
    "result": {
      "devices": [
        {
          "device_number": "200",
          "device_name": "200号本地测试手机",
          "online": true,
          "adb_online": true,
          "agent_online": true,
          "listed": true,
          "busy": false,
          "busy_reason": "",
          "occupancy": null,
          "accounts": [
            {
              "app_slot": "main",
              "binding_verified": true,
              "enabled": true,
              "wecom_phone": "17508437040",
              "available": true,
              "unavailable_reason": ""
            }
          ],
          "available": true,
          "unavailable_reason": "",
          "last_seen_at": "2026-11-05T03:00:22.358Z",
          "adb_last_seen_at": "2026-11-05T03:00:22.358Z"
        },
        {
          "device_number": "202",
          "device_name": "202号本地测试手机",
          "online": true,
          "adb_online": true,
          "agent_online": true,
          "listed": true,
          "busy": true,
          "busy_reason": "local_preview_running",
          "occupancy": {
            "type": "automation",
            "label": "企微本地预览"
          },
          "accounts": [
            {
              "app_slot": "main",
              "binding_verified": true,
              "enabled": true,
              "wecom_phone": "13067238489",
              "available": false,
              "unavailable_reason": "device_busy"
            }
          ],
          "available": false,
          "unavailable_reason": "device_busy",
          "last_seen_at": "2026-11-05T03:00:22.358Z",
          "adb_last_seen_at": "2026-11-05T03:00:22.358Z"
        }
      ],
      "total": 2,
      "updated_at": "2026-11-05T03:00:22.358Z",
      "capacity": {
        "limit": 2,
        "active": 1,
        "remaining": 1
      }
    },
    "timestamp": 1793847622359,
    "success": true,
    "code": 200,
    "message": "查询成功"
  }
}
```

## 5. /api/v1/lead/dispatch · 2026-11-05T03:00:56.574Z

请求：
```http
POST http://127.0.0.1:50959/api/v1/lead/dispatch
Content-Type: application/json; charset=utf-8
```

```json
{
  "lead_id": 61104200,
  "phone": "136****6441",
  "wecom_phone": "17508437040",
  "wecom_corp_id": "local_test_corp",
  "wecom_userid": "local_test_member_200",
  "app_id": "cps_local_observe",
  "timestamp": 1793847656468,
  "nonce": "d9feee7fc02d484b40f5146a",
  "sign": "<已脱敏>"
}
```

响应 HTTP 200：
```json
{
  "status": 200,
  "headers": {
    "cache-control": "no-store",
    "connection": "keep-alive",
    "content-length": "125",
    "content-type": "application/json; charset=utf-8",
    "date": "Thu, 05 Nov 2026 03:00:56 GMT",
    "keep-alive": "timeout=5"
  },
  "body": {
    "result": null,
    "timestamp": 1793847656573,
    "success": true,
    "code": 200,
    "message": "已接收（本地预览，不发送邀请）"
  }
}
```

## 6. /api/v1/lead/devices/query · 2026-11-05T03:02:27.004Z

请求：
```http
POST http://127.0.0.1:50959/api/v1/lead/devices/query
Content-Type: application/json; charset=utf-8
```

```json
{
  "online_only": false,
  "app_id": "cps_local_observe",
  "timestamp": 1793847746871,
  "nonce": "53da204a0725ad0c6d99148c",
  "sign": "<已脱敏>"
}
```

响应 HTTP 200：
```json
{
  "status": 200,
  "headers": {
    "cache-control": "no-store",
    "connection": "keep-alive",
    "content-length": "1095",
    "content-type": "application/json; charset=utf-8",
    "date": "Thu, 05 Nov 2026 03:02:27 GMT",
    "keep-alive": "timeout=5"
  },
  "body": {
    "result": {
      "devices": [
        {
          "device_number": "200",
          "device_name": "200号本地测试手机",
          "online": true,
          "adb_online": true,
          "agent_online": true,
          "listed": true,
          "busy": false,
          "busy_reason": "",
          "occupancy": null,
          "accounts": [
            {
              "app_slot": "main",
              "binding_verified": true,
              "enabled": true,
              "wecom_phone": "17508437040",
              "available": true,
              "unavailable_reason": ""
            }
          ],
          "available": true,
          "unavailable_reason": "",
          "last_seen_at": "2026-11-05T03:02:27.003Z",
          "adb_last_seen_at": "2026-11-05T03:02:27.003Z"
        },
        {
          "device_number": "202",
          "device_name": "202号本地测试手机",
          "online": true,
          "adb_online": true,
          "agent_online": true,
          "listed": true,
          "busy": false,
          "busy_reason": "",
          "occupancy": null,
          "accounts": [
            {
              "app_slot": "main",
              "binding_verified": true,
              "enabled": true,
              "wecom_phone": "13067238489",
              "available": true,
              "unavailable_reason": ""
            }
          ],
          "available": true,
          "unavailable_reason": "",
          "last_seen_at": "2026-11-05T03:02:27.003Z",
          "adb_last_seen_at": "2026-11-05T03:02:27.003Z"
        }
      ],
      "total": 2,
      "updated_at": "2026-11-05T03:02:27.003Z",
      "capacity": {
        "limit": 2,
        "active": 0,
        "remaining": 2
      }
    },
    "timestamp": 1793847747003,
    "success": true,
    "code": 200,
    "message": "查询成功"
  }
}
```

## 真机预览执行回执

以下是内部任务证据，不是新增的公共查询接口。succeeded仅表示本轮预览达到发送前，invitationSent始终为false；remarkSaveStatus=not_needed表示已有备注符合本轮输入，实际已读回独立备注电话。

```json
{
  "at": "2026-11-05T03:00:47.171Z",
  "kind": "native_result",
  "deviceNumber": "202",
  "leadId": "61104202",
  "jobId": "local_native_202_61104202",
  "processExitCode": 0,
  "elapsedMs": 30252,
  "result": {
    "workflowVersion": "wecom-customer-preview-v2",
    "status": "ready_before_send",
    "code": "stopped_before_send",
    "readyToSend": true,
    "invitationSent": false,
    "remarkSaved": false,
    "stage": "preview",
    "events": [
      {
        "step": "open_menu"
      },
      {
        "step": "open_add"
      },
      {
        "step": "open_search"
      },
      {
        "step": "enter_phone"
      },
      {
        "step": "search"
      },
      {
        "step": "open_preview"
      }
    ],
    "remarkSaveStatus": "not_needed",
    "remarkPrepared": true,
    "remarkEvents": [
      {
        "step": "open_remark"
      },
      {
        "step": "close_remark"
      }
    ],
    "remarkPhoneSet": true,
    "sendStatus": "not_attempted",
    "execution": {
      "cleanupConfirmed": true
    }
  },
  "status": "succeeded"
}
```

```json
{
  "at": "2026-11-05T03:01:55.447Z",
  "kind": "native_result",
  "deviceNumber": "200",
  "leadId": "61104200",
  "jobId": "local_native_200_61104200",
  "processExitCode": 0,
  "elapsedMs": 51598,
  "result": {
    "workflowVersion": "wecom-customer-preview-v2",
    "status": "ready_before_send",
    "code": "stopped_before_send",
    "readyToSend": true,
    "invitationSent": false,
    "remarkSaved": false,
    "stage": "preview",
    "events": [
      {
        "step": "open_menu"
      },
      {
        "step": "open_add"
      },
      {
        "step": "open_search"
      },
      {
        "step": "enter_phone"
      },
      {
        "step": "search"
      },
      {
        "step": "open_preview"
      }
    ],
    "remarkSaveStatus": "not_needed",
    "remarkPrepared": true,
    "remarkEvents": [
      {
        "step": "open_remark"
      },
      {
        "step": "close_remark"
      }
    ],
    "remarkPhoneSet": true,
    "sendStatus": "not_attempted",
    "execution": {
      "cleanupConfirmed": true
    }
  },
  "status": "succeeded"
}
```

## 独立模拟：发送成功后的CPS回调

与上述真机预览完全分开的应用、账本和模拟执行器；模拟器没有ADB或原生执行入口。以下success来源于合成完成记录，未在任何手机发送邀请。真实预览回调数为0。接收方真实执行了签名校验。

CPS需提供callback接收地址；这不是由调用方轮询我方的结果查询接口。success表示申请确认发送，不代表好友通过。普通网络/页面/登录错误不属于CPS原文三类结果，保留原任务待处理，尚需双方约定通用失败通知。

### synthetic_dispatch

```json
{
  "kind": "synthetic_dispatch",
  "request": {
    "method": "POST",
    "url": "http://127.0.0.1:52032/api/v1/lead/dispatch",
    "headers": {
      "Content-Type": "application/json; charset=utf-8"
    },
    "body": {
      "lead_id": 61104999,
      "phone": "13900000001",
      "wecom_phone": "13900000000",
      "wecom_corp_id": "synthetic_test_corp",
      "wecom_userid": "synthetic_test_member",
      "app_id": "cps_callback_example",
      "timestamp": 1793847688926,
      "nonce": "ce69385177d653e54c6e90dd",
      "sign": "<已脱敏>"
    }
  },
  "response": {
    "status": 200,
    "body": {
      "result": null,
      "timestamp": 1793847688951,
      "success": true,
      "code": 200,
      "message": "已接收"
    }
  }
}
```

### synthetic_callback

```json
{
  "kind": "synthetic_callback",
  "request": {
    "method": "POST",
    "url": "http://127.0.0.1:52031/api/v1/lead/callback",
    "headers": {
      "Content-Type": "application/json; charset=utf-8"
    },
    "body": {
      "lead_id": 61104999,
      "result": "success",
      "remark_phone_set": true,
      "app_id": "cps_callback_example",
      "timestamp": 1793847688979,
      "nonce": "70ecc7c615a7f1e57ab24206fac2c560",
      "sign": "<已脱敏>"
    }
  },
  "response": {
    "status": 200,
    "body": {
      "success": true,
      "code": 200,
      "message": "接收成功",
      "result": null,
      "timestamp": 1793847688988
    }
  },
  "signatureVerified": true
}
```

## 收尾与边界

- 202耗时30.252秒，200耗时51.598秒，均停在发送邀请前。
- 同一202线索重复下发，原任务不变，原生启动仅1次；两台总共2次原生启动。
- 最终两台busy=false、available=true，容量active=0、remaining=2。
- 两台reader/test reader进程和串口专属forward均为0，ADB始终同一PID/出生/路径。
- 本地HTTP服务及模拟回调服务已关闭，手机保持发送前页面供观察。
- 本轮客户端使用同库签名助手；独立客户端签名、真实121秒重试和故障场景见上一候选验证，不将本轮视为新增独立签名验收。
- 未验证正式Windows SYSTEM执行证明、CPS真实接收服务、真实邀请发送和长期稳定性。
- 本轮未修改产品代码；候选源码保持e1a7ade4bb58d62119993f90fce3de49d2f91162。

import assert from "node:assert/strict";
import test from "node:test";
import { buildDeviceOccupancy } from "./device-occupancy.mjs";

const users = [{ userId: "user-1", username: "wcl123", displayName: "邬成林" }];

test("returns the named owner and slot to administrators", () => {
  const occupancy = buildDeviceOccupancy({
    lock: {
      lockType: "xhs_qr",
      ownerUserId: "user-1",
      appSlot: "app2",
      taskId: "task-1",
      createdAt: "2026-07-15T08:41:43.880Z"
    },
    viewer: { role: "admin", userId: "admin-1" },
    users
  });

  assert.deepEqual(occupancy, {
    kind: "xhs_qr",
    label: "小红书 2 扫码",
    ownerLabel: "邬成林",
    ownerVisible: true,
    startedAt: "2026-07-15T08:41:43.880Z",
    appSlot: "app2",
    taskId: "task-1",
    sessionId: ""
  });
});

test("shows another user's display name to a normal user", () => {
  const occupancy = buildDeviceOccupancy({
    lock: {
      lockType: "screen_control",
      ownerUserId: "user-1",
      taskId: "session-1",
      createdAt: "2026-07-15T08:41:43.880Z"
    },
    viewer: { role: "user", userId: "user-2" },
    users
  });

  assert.equal(occupancy.kind, "screen_control");
  assert.equal(occupancy.label, "实时控制");
  assert.equal(occupancy.ownerLabel, "邬成林");
  assert.equal(occupancy.ownerVisible, true);
  assert.equal(occupancy.sessionId, "session-1");
});

test("identifies the current user without exposing an account name", () => {
  const occupancy = buildDeviceOccupancy({
    lock: {
      lockType: "sms_wait",
      ownerUserId: "user-1",
      createdAt: "2026-07-15T08:41:43.880Z"
    },
    viewer: { role: "user", userId: "user-1" },
    users
  });

  assert.equal(occupancy.label, "等待短信");
  assert.equal(occupancy.ownerLabel, "你");
  assert.equal(occupancy.ownerVisible, true);
});

test("shows administrative and system occupancy without exposing account details", () => {
  const adminOccupancy = buildDeviceOccupancy({
    lock: {
      lockType: "screen_control",
      ownerUserId: "admin:support",
      taskId: "session-admin"
    },
    viewer: { role: "user", userId: "user-1" },
    users
  });
  const systemOccupancy = buildDeviceOccupancy({
    lock: {
      lockType: "task",
      ownerUserId: "system:maintenance",
      taskId: "task-system"
    },
    viewer: { role: "user", userId: "user-1" },
    users
  });

  assert.equal(adminOccupancy.ownerLabel, "管理员");
  assert.equal(adminOccupancy.ownerVisible, true);
  assert.equal(systemOccupancy.ownerLabel, "系统任务");
  assert.equal(systemOccupancy.ownerVisible, true);
});

test("marks an unresolvable owner as unknown", () => {
  const occupancy = buildDeviceOccupancy({
    lock: {
      lockType: "xhs_qr",
      ownerUserId: "deleted-user",
      taskId: "task-orphan"
    },
    viewer: { role: "user", userId: "user-1" },
    users
  });

  assert.equal(occupancy.ownerLabel, "未知用户");
  assert.equal(occupancy.ownerVisible, false);
});

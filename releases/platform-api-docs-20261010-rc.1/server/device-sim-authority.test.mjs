import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAdminSimAuthority,
  mergeReportedSims
} from "./device-sim-authority.mjs";

const changedAt = "2026-08-13T06:01:05.000Z";
const syncedAt = "2026-08-13T06:03:22.000Z";

test("an administrator phone number survives a stale ADB report", () => {
  const existing = applyAdminSimAuthority([{
    subscriptionId: 1,
    slotIndex: 0,
    carrierName: "旧运营商",
    phoneNumber: "19900001111",
    enabled: true
  }], changedAt);

  const result = mergeReportedSims(existing, [{
    subscriptionId: 8,
    slotIndex: 0,
    carrierName: "新运营商",
    phoneNumber: "19198115463",
    enabled: true
  }], { source: "adb", updatedAt: syncedAt });

  assert.equal(result[0].phoneNumber, "19900001111");
  assert.equal(result[0].phoneNumberSource, "admin");
  assert.equal(result[0].phoneNumberUpdatedAt, changedAt);
  assert.equal(result[0].subscriptionId, 8);
  assert.equal(result[0].carrierName, "新运营商");
});

test("a legacy non-empty server number is adopted as administrator-owned", () => {
  const result = mergeReportedSims([{
    slotIndex: 1,
    phoneNumber: "18800002222",
    enabled: true
  }], [{
    slotIndex: 1,
    phoneNumber: "19117481410",
    enabled: true
  }], { source: "adb", updatedAt: syncedAt });

  assert.equal(result[0].phoneNumber, "18800002222");
  assert.equal(result[0].phoneNumberSource, "admin");
});

test("a reported number can fill an unowned empty slot", () => {
  const result = mergeReportedSims([{
    slotIndex: 0,
    phoneNumber: "",
    enabled: true
  }], [{
    slotIndex: 0,
    phoneNumber: "19198115463",
    enabled: true
  }], { source: "phone_agent", updatedAt: syncedAt });

  assert.equal(result[0].phoneNumber, "19198115463");
  assert.equal(result[0].phoneNumberSource, "phone_agent");
  assert.equal(result[0].phoneNumberUpdatedAt, syncedAt);
});

test("a later report cannot silently replace an automatically filled number", () => {
  const result = mergeReportedSims([{
    slotIndex: 0,
    phoneNumber: "19198115463",
    phoneNumberSource: "phone_agent",
    phoneNumberUpdatedAt: changedAt,
    enabled: true
  }], [{
    slotIndex: 0,
    phoneNumber: "19900003333",
    enabled: true
  }], { source: "adb", updatedAt: syncedAt });

  assert.equal(result[0].phoneNumber, "19198115463");
  assert.equal(result[0].phoneNumberSource, "phone_agent");
  assert.equal(result[0].phoneNumberUpdatedAt, changedAt);
});

test("an administrator can deliberately clear a number without it returning", () => {
  const existing = applyAdminSimAuthority([{
    slotIndex: 0,
    phoneNumber: "",
    enabled: true
  }], changedAt);

  const result = mergeReportedSims(existing, [{
    slotIndex: 0,
    phoneNumber: "19198115463",
    enabled: true
  }], { source: "adb", updatedAt: syncedAt });

  assert.equal(result[0].phoneNumber, "");
  assert.equal(result[0].phoneNumberSource, "admin");
  assert.equal(result[0].phoneNumberUpdatedAt, changedAt);
});

test("an administrator-owned empty slot is retained when a report omits it", () => {
  const existing = applyAdminSimAuthority([{
    slotIndex: 1,
    phoneNumber: "",
    enabled: true
  }], changedAt);

  const result = mergeReportedSims(existing, [], { source: "adb", updatedAt: syncedAt });

  assert.equal(result.length, 1);
  assert.equal(result[0].slotIndex, 1);
  assert.equal(result[0].phoneNumber, "");
  assert.equal(result[0].phoneNumberSource, "admin");
});

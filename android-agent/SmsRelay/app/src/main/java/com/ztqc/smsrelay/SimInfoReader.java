package com.ztqc.smsrelay;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

public final class SimInfoReader {
    private SimInfoReader() {}

    public static JSONArray activeSims(Context context) throws Exception {
        JSONArray sims = new JSONArray();
        if (!hasPhoneStatePermission(context)) return sims;

        SubscriptionManager manager = (SubscriptionManager) context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
        if (manager == null) return sims;

        List<SubscriptionInfo> infos = manager.getActiveSubscriptionInfoList();
        if (infos != null) {
            for (SubscriptionInfo info : infos) {
                JSONObject sim = new JSONObject();
                sim.put("subscriptionId", info.getSubscriptionId());
                sim.put("slotIndex", info.getSimSlotIndex());
                CharSequence carrier = info.getCarrierName();
                sim.put("carrierName", carrier == null ? "" : carrier.toString());
                String phoneNumber = phoneNumber(context, info.getSubscriptionId(), info);
                if (!phoneNumber.isEmpty()) sim.put("phoneNumber", phoneNumber);
                sim.put("enabled", true);
                sims.put(sim);
            }
        }
        if (sims.length() == 0) addSlotFallbackSims(context, manager, sims);
        return sims;
    }

    private static void addSlotFallbackSims(Context context, SubscriptionManager manager, JSONArray sims) {
        if (Build.VERSION.SDK_INT < 29) return;
        TelephonyManager telephony = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
        int slots = 2;
        if (telephony != null) {
            try {
                int modemCount = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? telephony.getActiveModemCount() : 0;
                slots = Math.max(modemCount, telephony.getPhoneCount());
            } catch (Exception ignored) {
                slots = telephony.getPhoneCount();
            }
        }
        slots = Math.max(1, Math.min(slots, 4));
        for (int slot = 0; slot < slots; slot++) {
            try {
                int[] subscriptionIds = manager.getSubscriptionIds(slot);
                if (subscriptionIds == null) continue;
                for (int subscriptionId : subscriptionIds) {
                    JSONObject sim = new JSONObject();
                    sim.put("subscriptionId", subscriptionId);
                    sim.put("slotIndex", slot);
                    sim.put("carrierName", carrierName(context, subscriptionId));
                    String phoneNumber = phoneNumber(context, subscriptionId, null);
                    if (!phoneNumber.isEmpty()) sim.put("phoneNumber", phoneNumber);
                    sim.put("enabled", true);
                    sims.put(sim);
                }
            } catch (Exception ignored) {
            }
        }
    }

    private static String carrierName(Context context, int subscriptionId) {
        try {
            TelephonyManager telephony = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
            if (telephony == null) return "";
            TelephonyManager scoped = telephony.createForSubscriptionId(subscriptionId);
            String simOperatorName = scoped.getSimOperatorName();
            if (simOperatorName != null && !simOperatorName.isEmpty()) return simOperatorName;
            String networkOperatorName = scoped.getNetworkOperatorName();
            return networkOperatorName == null ? "" : networkOperatorName;
        } catch (Exception ignored) {
            return "";
        }
    }

    @SuppressWarnings("deprecation")
    private static String phoneNumber(Context context, int subscriptionId, SubscriptionInfo info) {
        if (!hasPhoneNumberPermission(context)) return "";
        try {
            if (info != null) {
                String number = normalizePhone(info.getNumber());
                if (!number.isEmpty()) return number;
            }
        } catch (Exception ignored) {
        }
        try {
            TelephonyManager telephony = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
            if (telephony == null) return "";
            TelephonyManager scoped = telephony.createForSubscriptionId(subscriptionId);
            return normalizePhone(scoped.getLine1Number());
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String normalizePhone(String value) {
        if (value == null) return "";
        String normalized = value.replaceAll("[^0-9+]", "");
        return normalized == null ? "" : normalized;
    }

    public static int slotIndexForSubscription(Context context, int subscriptionId) {
        if (!hasPhoneStatePermission(context) || subscriptionId == Integer.MIN_VALUE) return Integer.MIN_VALUE;
        try {
            SubscriptionManager manager = (SubscriptionManager) context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
            if (manager == null) return Integer.MIN_VALUE;
            SubscriptionInfo info = manager.getActiveSubscriptionInfo(subscriptionId);
            return info == null ? Integer.MIN_VALUE : info.getSimSlotIndex();
        } catch (SecurityException ignored) {
            return Integer.MIN_VALUE;
        }
    }

    public static boolean hasPhoneStatePermission(Context context) {
        return Build.VERSION.SDK_INT < 23
            || context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean hasPhoneNumberPermission(Context context) {
        return Build.VERSION.SDK_INT < 23
            || context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED
            || context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
    }
}

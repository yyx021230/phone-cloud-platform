package com.ztqc.smsrelay;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public final class RecentSmsNotificationStore {
    private static final String PREFS = "recent_sms_notifications";
    private static final String KEY_ITEMS = "items";
    private static final long RETAIN_MS = 10 * 60_000L;
    private static final int MAX_ITEMS = 30;

    private RecentSmsNotificationStore() {}

    public static void add(Context context, String packageName, String sender, String body, long postTimeMillis) {
        if (TextUtils.isEmpty(body)) return;
        long now = System.currentTimeMillis();
        long postTime = postTimeMillis > 0 ? postTimeMillis : now;
        ArrayList<Item> items = new ArrayList<>(list(context));
        String key = key(packageName, sender, body, postTime);
        for (Item item : items) {
            if (key(item.packageName, item.sender, item.body, item.postTimeMillis).equals(key)) return;
        }
        items.add(0, new Item(packageName, sender, body, postTime));
        save(context, items, now);
    }

    public static List<Item> list(Context context) {
        ArrayList<Item> result = new ArrayList<>();
        String raw = prefs(context).getString(KEY_ITEMS, "[]");
        long now = System.currentTimeMillis();
        try {
            JSONArray array = new JSONArray(raw);
            for (int index = 0; index < array.length(); index++) {
                JSONObject object = array.optJSONObject(index);
                if (object == null) continue;
                Item item = new Item(
                    object.optString("packageName"),
                    object.optString("sender"),
                    object.optString("body"),
                    object.optLong("postTimeMillis", 0L)
                );
                if (item.postTimeMillis > 0 && now - item.postTimeMillis <= RETAIN_MS) result.add(item);
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    public static void pruneBefore(Context context, long cutoffMillis) {
        if (cutoffMillis <= 0) return;
        ArrayList<Item> kept = new ArrayList<>();
        for (Item item : list(context)) {
            if (item.postTimeMillis >= cutoffMillis) kept.add(item);
        }
        save(context, kept, System.currentTimeMillis());
    }

    private static void save(Context context, List<Item> items, long now) {
        JSONArray array = new JSONArray();
        int count = 0;
        for (Item item : items) {
            if (item.postTimeMillis <= 0 || now - item.postTimeMillis > RETAIN_MS) continue;
            if (count >= MAX_ITEMS) break;
            JSONObject object = new JSONObject();
            try {
                object.put("packageName", item.packageName);
                object.put("sender", item.sender);
                object.put("body", item.body);
                object.put("postTimeMillis", item.postTimeMillis);
                array.put(object);
                count++;
            } catch (Exception ignored) {
            }
        }
        prefs(context).edit().putString(KEY_ITEMS, array.toString()).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String key(String packageName, String sender, String body, long postTimeMillis) {
        return String.valueOf(packageName) + "|" + String.valueOf(sender) + "|" + String.valueOf(body) + "|" + postTimeMillis;
    }

    public static final class Item {
        public final String packageName;
        public final String sender;
        public final String body;
        public final long postTimeMillis;

        Item(String packageName, String sender, String body, long postTimeMillis) {
            this.packageName = packageName;
            this.sender = sender;
            this.body = body;
            this.postTimeMillis = postTimeMillis;
        }
    }
}

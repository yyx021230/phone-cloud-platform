package com.ztqc.smsrelay;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public final class XhsAppDiscovery {
    public static final class Target {
        public final String label;
        public final String packageName;
        public final String activityName;
        public final String appSlot;

        Target(String label, String packageName, String activityName, String appSlot) {
            this.label = label;
            this.packageName = packageName;
            this.activityName = activityName;
            this.appSlot = appSlot;
        }

        JSONObject toJson() throws Exception {
            JSONObject json = new JSONObject();
            json.put("label", label);
            json.put("packageName", packageName);
            json.put("activityName", activityName);
            json.put("appSlot", appSlot);
            return json;
        }
    }

    private XhsAppDiscovery() {}

    public static JSONArray discoverJson(Context context) throws Exception {
        JSONArray array = new JSONArray();
        for (Target target : discover(context)) array.put(target.toJson());
        return array;
    }

    public static Target resolveTarget(Context context, JSONObject requested, String appSlot) throws Exception {
        if (requested != null) {
            String packageName = requested.optString("packageName", "").trim();
            String activityName = requested.optString("activityName", "").trim();
            if (!packageName.isEmpty() && !activityName.isEmpty()) {
                return new Target(
                    requested.optString("label", appSlotLabel(appSlot)),
                    packageName,
                    activityName,
                    normalizeSlot(requested.optString("appSlot", appSlot))
                );
            }
        }

        List<Target> targets = discover(context);
        if (targets.isEmpty()) {
            throw new IllegalStateException("未检测到可启动的小红书入口");
        }

        String normalizedSlot = normalizeSlot(appSlot);
        for (Target target : targets) {
            if (normalizedSlot.equals(target.appSlot)) return target;
        }
        return targets.get(0);
    }

    public static List<Target> discover(Context context) {
        PackageManager packageManager = context.getPackageManager();
        Intent query = new Intent(Intent.ACTION_MAIN);
        query.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolved = packageManager.queryIntentActivities(query, 0);
        List<Target> targets = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        for (ResolveInfo info : resolved) {
            ActivityInfo activity = info.activityInfo;
            if (activity == null || activity.packageName == null || activity.name == null) continue;
            String label = loadLabel(packageManager, info);
            if (!looksLikeXhs(label, activity.packageName, activity.name)) continue;
            addTarget(targets, seen, label, activity.packageName, activity.name);
        }

        Intent launch = packageManager.getLaunchIntentForPackage("com.xingin.xhs");
        ComponentName component = launch == null ? null : launch.getComponent();
        if (component != null) {
            addTarget(targets, seen, "小红书", component.getPackageName(), component.getClassName());
        }

        return targets;
    }

    private static void addTarget(List<Target> targets, Set<String> seen, String label, String packageName, String activityName) {
        String key = packageName + "/" + activityName;
        if (seen.contains(key)) return;
        seen.add(key);
        targets.add(new Target(
            label == null || label.trim().isEmpty() ? appSlotLabel(targets.size() == 0 ? "app1" : "app2") : label.trim(),
            packageName,
            activityName,
            inferSlot(label, targets.size())
        ));
    }

    private static String loadLabel(PackageManager packageManager, ResolveInfo info) {
        try {
            CharSequence label = info.loadLabel(packageManager);
            return label == null ? "" : label.toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    private static boolean looksLikeXhs(String label, String packageName, String activityName) {
        String text = (String.valueOf(label) + " " + packageName + " " + activityName).toLowerCase(Locale.US);
        return text.contains("小红书")
            || text.contains("xingin")
            || text.contains("xiaohongshu")
            || text.contains("rednote")
            || packageName.equals("com.xingin.xhs");
    }

    private static String inferSlot(String label, int index) {
        String text = String.valueOf(label);
        if (text.contains("Ⅱ") || text.contains("II") || text.contains("2") || text.contains("分身") || text.contains("双开")) {
            return "app2";
        }
        return index == 0 ? "app1" : "app2";
    }

    private static String normalizeSlot(String value) {
        return "app2".equals(value) ? "app2" : "app1";
    }

    private static String appSlotLabel(String appSlot) {
        return "app2".equals(appSlot) ? "Ⅱ·小红书" : "小红书";
    }
}

package com.ztqc.smsrelay;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

public final class AppUpdater {
    private static final String APK_MIME = "application/vnd.android.package-archive";

    private AppUpdater() {}

    public interface Callback {
        void onMessage(String message);
        void onRelease(ReleaseInfo release);
    }

    public static final class ReleaseInfo {
        public int versionCode;
        public String versionName;
        public String downloadUrl;
        public String sha256;
        public String releaseNotes;
        public long sizeBytes;
        public boolean mandatory;
        public boolean updateAvailable;
    }

    public static void checkAsync(Context context, Callback callback) {
        new Thread(() -> {
            try {
                ReleaseInfo release = fetchLatest(context);
                release.updateAvailable = release.versionCode > currentVersionCode(context);
                post(callback, release.updateAvailable
                    ? "发现新版 " + release.versionName + "，可以下载安装"
                    : "当前已是最新版 " + currentVersionName(context), release);
            } catch (Exception error) {
                post(callback, "检查更新失败：" + error.getMessage(), null);
            }
        }).start();
    }

    public static void downloadAndInstallAsync(Activity activity, ReleaseInfo release, Callback callback) {
        if (release == null || release.downloadUrl == null || release.downloadUrl.isEmpty()) {
            post(callback, "请先检查更新", null);
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
            post(callback, "请先允许本应用安装未知来源应用，然后返回再点下载安装", release);
            return;
        }
        new Thread(() -> {
            try {
                File file = download(activity, release, callback);
                if (release.sha256 != null && !release.sha256.isEmpty()) {
                    String actualSha256 = sha256(file);
                    if (!release.sha256.equalsIgnoreCase(actualSha256)) {
                        throw new IllegalStateException("APK 校验失败");
                    }
                }
                post(callback, "下载完成，正在打开系统安装器", release);
                new Handler(Looper.getMainLooper()).post(() -> install(activity));
            } catch (Exception error) {
                post(callback, "更新失败：" + error.getMessage(), release);
            }
        }).start();
    }

    public static String currentVersionName(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            return "";
        }
    }

    public static long currentVersionCode(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= 28) return info.getLongVersionCode();
            return info.versionCode;
        } catch (Exception ignored) {
            return 0;
        }
    }

    private static ReleaseInfo fetchLatest(Context context) throws Exception {
        JSONObject body = get(context, "/api/v1/app-release/latest");
        JSONObject json = body.getJSONObject("release");
        ReleaseInfo release = new ReleaseInfo();
        release.versionCode = json.optInt("versionCode", 0);
        release.versionName = json.optString("versionName", "");
        release.downloadUrl = json.optString("downloadUrl", "");
        release.sha256 = json.optString("sha256", "");
        release.releaseNotes = json.optString("releaseNotes", "");
        release.sizeBytes = json.optLong("sizeBytes", 0);
        release.mandatory = json.optBoolean("mandatory", false);
        return release;
    }

    private static JSONObject get(Context context, String path) throws Exception {
        URL url = new URL(RelayConfig.serverUrl(context) + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(8000);
        connection.setRequestProperty("Authorization", "Bearer " + RelayConfig.token(context));
        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
        String body = readAll(stream);
        connection.disconnect();
        if (code < 200 || code >= 300) throw new IllegalStateException("服务端返回 " + code);
        return new JSONObject(body);
    }

    private static File download(Context context, ReleaseInfo release, Callback callback) throws Exception {
        URL url = new URL(release.downloadUrl);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("Authorization", "Bearer " + RelayConfig.token(context));
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) throw new IllegalStateException("下载返回 " + code);

        File file = ApkFileProvider.apkFile(context);
        File dir = file.getParentFile();
        if (dir != null && !dir.exists()) dir.mkdirs();
        long total = connection.getContentLengthLong();
        long done = 0;
        long nextNotify = 0;
        try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                done += read;
                if (done >= nextNotify) {
                    nextNotify = done + 512 * 1024L;
                    String text = total > 0
                        ? "正在下载：" + Math.min(100, (done * 100 / total)) + "%"
                        : "正在下载：" + done / 1024 + " KB";
                    post(callback, text, release);
                }
            }
        } finally {
            connection.disconnect();
        }
        return file;
    }

    private static void install(Activity activity) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(ApkFileProvider.uriFor(activity), APK_MIME);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        byte[] bytes = digest.digest();
        StringBuilder builder = new StringBuilder();
        for (byte value : bytes) builder.append(String.format("%02x", value));
        return builder.toString();
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "{}";
        StringBuilder builder = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(stream, java.nio.charset.StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
        }
        return builder.toString();
    }

    private static void post(Callback callback, String message, ReleaseInfo release) {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (callback == null) return;
            callback.onMessage(message);
            callback.onRelease(release);
        });
    }
}

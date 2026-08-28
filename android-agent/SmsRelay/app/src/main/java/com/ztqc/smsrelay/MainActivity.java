package com.ztqc.smsrelay;

import android.Manifest;
import android.app.Activity;
import android.os.Build;
import android.os.PowerManager;
import android.net.Uri;
import android.provider.Settings;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

public class MainActivity extends Activity {
    private EditText serverUrlInput;
    private EditText tokenInput;
    private EditText phoneInput;
    private EditText deviceInput;
    private TextView statusText;
    private TextView updateText;
    private Button installUpdateButton;
    private AppUpdater.ReleaseInfo latestRelease;
    private boolean updateInstalling;
    private boolean autoLaunchScheduled;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyLaunchConfig();
        buildUi();
        requestSmsPermissions();
        startRelayServices();
        handleAutoLaunchXhs(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyLaunchConfig();
        startRelayServices();
        updateStatus();
        handleAutoLaunchXhs(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        startRelayServices();
        updateStatus();
        handleAutoLaunchXhs(getIntent());
    }

    private void startRelayServices() {
        RelayForegroundService.start(this);
        RelayClient.sendHeartbeatAsync(this);
    }

    private void handleAutoLaunchXhs(Intent intent) {
        if (autoLaunchScheduled) return;
        boolean autoLaunch = intent != null && intent.getBooleanExtra("autoLaunchXhs", false);
        String packageName = autoLaunch ? intent.getStringExtra("packageName") : null;
        String activityName = autoLaunch ? intent.getStringExtra("activityName") : null;
        if (packageName == null || activityName == null) {
            JSONObject pending = DeviceCommandExecutor.consumePendingXhsLaunch(this);
            if (pending != null) {
                packageName = pending.optString("packageName", "");
                activityName = pending.optString("activityName", "");
            }
        }
        if (packageName == null || packageName.isEmpty() || activityName == null || activityName.isEmpty()) return;
        final String targetPackageName = packageName;
        final String targetActivityName = activityName;
        autoLaunchScheduled = true;
        if (statusText != null) statusText.setText("正在通过自家 APK 前台启动小红书...");
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try {
                DeviceCommandExecutor.startXhsComponent(this, targetPackageName, targetActivityName);
            } finally {
                getIntent().removeExtra("autoLaunchXhs");
                autoLaunchScheduled = false;
                new Handler(Looper.getMainLooper()).postDelayed(this::finish, 2_000);
            }
        }, 900);
    }

    private void applyLaunchConfig() {
        Intent intent = getIntent();
        if (intent == null) return;
        String serverUrl = intent.getStringExtra("serverUrl");
        String token = intent.getStringExtra("token");
        String phoneNumber = intent.getStringExtra("phoneNumber");
        String deviceName = intent.getStringExtra("deviceName");
        String deviceId = intent.getStringExtra("deviceId");
        if (serverUrl == null && token == null && phoneNumber == null && deviceName == null && deviceId == null) return;
        RelayConfig.save(
            this,
            serverUrl == null ? RelayConfig.serverUrl(this) : serverUrl,
            token == null ? RelayConfig.token(this) : token,
            phoneNumber == null ? RelayConfig.phoneNumber(this) : phoneNumber,
            deviceName == null ? RelayConfig.deviceName(this) : deviceName,
            deviceId
        );
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(40, 48, 40, 48);
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("云手机短信 · 设置");
        title.setTextSize(28);
        title.setTextColor(0xff2f1d0e);
        root.addView(title);

        TextView intro = new TextView(this);
        intro.setText("本机文字短信先保存到系统短信库，再异步上传私有后台。网络异常不会影响手机查看；当前版本暂不下载彩信内容。");
        intro.setTextSize(15);
        intro.setTextColor(0xaa2f1d0e);
        intro.setPadding(0, 10, 0, 26);
        root.addView(intro);

        Button inbox = button("返回短信");
        inbox.setOnClickListener(view -> {
            startActivity(new Intent(this, SmsHomeActivity.class));
            finish();
        });
        root.addView(inbox);

        Button defaultSms = button("设为默认短信应用");
        defaultSms.setOnClickListener(view -> DefaultSmsRole.requestDefaultRole(this));
        root.addView(defaultSms);

        serverUrlInput = field(root, "服务地址", RelayConfig.serverUrl(this));
        tokenInput = field(root, "Token", RelayConfig.token(this));
        phoneInput = field(root, "本机手机号（多个用逗号分隔）", RelayConfig.phoneNumber(this));
        deviceInput = field(root, "设备名称", RelayConfig.deviceName(this));

        Button save = button("保存配置并发送心跳");
        save.setOnClickListener(view -> {
            if (!saveConfigFromInputs()) return;
            RelayClient.sendHeartbeatAsync(this);
            RelayForegroundService.start(this);
            Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show();
            updateStatus();
        });
        root.addView(save);

        Button keepAlive = button("启动常驻服务");
        keepAlive.setOnClickListener(view -> {
            RelayForegroundService.start(this);
            RelayClient.sendHeartbeatAsync(this);
            Toast.makeText(this, "常驻服务已启动", Toast.LENGTH_SHORT).show();
        });
        root.addView(keepAlive);

        Button battery = button("请求忽略电池优化");
        battery.setOnClickListener(view -> requestIgnoreBatteryOptimizations());
        root.addView(battery);

        Button accessibility = button("打开无障碍授权");
        accessibility.setOnClickListener(view -> {
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            Toast.makeText(this, "请开启“验证码中控”的无障碍服务", Toast.LENGTH_LONG).show();
        });
        root.addView(accessibility);

        Button notificationAccess = button("打开旧短信通知兜底授权（接管后无需）");
        notificationAccess.setOnClickListener(view -> {
            startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
            Toast.makeText(this, "请开启“ZTC 云控”的通知访问权限，用于 vivo 等机型验证码兜底", Toast.LENGTH_LONG).show();
        });
        root.addView(notificationAccess);

        Button test = button("发送本机测试验证码");
        test.setOnClickListener(view -> RelayClient.sendSmsAsync(
            this,
            "小红书",
            "【小红书】验证码 123456，5 分钟内有效，请勿泄露。",
            System.currentTimeMillis()
        ));
        root.addView(test);

        Button syncSmsLibrary = button("立即同步短信库");
        syncSmsLibrary.setOnClickListener(view -> {
            SmsLibrarySync.syncAsync(this, true);
            Toast.makeText(this, "已开始同步短信库", Toast.LENGTH_SHORT).show();
        });
        root.addView(syncSmsLibrary);

        Button checkUpdate = button("检查 APK 更新");
        checkUpdate.setOnClickListener(view -> checkForUpdate());
        root.addView(checkUpdate);

        installUpdateButton = button("下载安装最新版");
        installUpdateButton.setEnabled(false);
        installUpdateButton.setOnClickListener(view -> installLatestUpdate());
        root.addView(installUpdateButton);

        updateText = new TextView(this);
        updateText.setTextSize(13);
        updateText.setTextColor(0xff5b4a38);
        updateText.setPadding(0, 10, 0, 10);
        updateText.setText("当前版本：" + AppUpdater.currentVersionName(this));
        root.addView(updateText);

        statusText = new TextView(this);
        statusText.setTextSize(14);
        statusText.setTextColor(0xff27624f);
        statusText.setPadding(0, 24, 0, 0);
        root.addView(statusText);
        updateStatus();

        setContentView(scroll);
    }

    private EditText field(LinearLayout root, String label, String value) {
        TextView text = new TextView(this);
        text.setText(label);
        text.setTextSize(12);
        text.setTextColor(0x882f1d0e);
        text.setPadding(0, 12, 0, 6);
        root.addView(text);

        EditText input = new EditText(this);
        input.setText(value);
        input.setSingleLine(true);
        input.setTextSize(16);
        input.setPadding(18, 12, 18, 12);
        root.addView(input);
        return input;
    }

    private Button button(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setPadding(0, 14, 0, 14);
        button.setOnFocusChangeListener((View view, boolean focused) -> {});
        return button;
    }

    private boolean saveConfigFromInputs() {
        String inputToken = tokenInput.getText().toString().trim();
        String savedToken = RelayConfig.token(this).trim();
        if ((inputToken.isEmpty() || "dev-device-token".equals(inputToken)) && savedToken.isEmpty()) {
            Toast.makeText(this, "请先填写有效 Token", Toast.LENGTH_LONG).show();
            tokenInput.requestFocus();
            return false;
        }
        RelayConfig.save(
            this,
            serverUrlInput.getText().toString(),
            tokenInput.getText().toString(),
            phoneInput.getText().toString(),
            deviceInput.getText().toString()
        );
        tokenInput.setText(RelayConfig.token(this));
        return true;
    }

    private void checkForUpdate() {
        if (!saveConfigFromInputs()) return;
        updateInstalling = false;
        updateText.setText("正在检查更新...");
        installUpdateButton.setEnabled(false);
        AppUpdater.checkAsync(this, new AppUpdater.Callback() {
            @Override
            public void onMessage(String message) {
                if (message.startsWith("请先允许") || message.startsWith("更新失败")) updateInstalling = false;
                updateText.setText(message);
            }

            @Override
            public void onRelease(AppUpdater.ReleaseInfo release) {
                latestRelease = release;
                boolean canInstall = release != null && release.updateAvailable;
                installUpdateButton.setEnabled(canInstall);
                if (canInstall && release.releaseNotes != null && !release.releaseNotes.isEmpty()) {
                    updateText.setText("发现新版 " + release.versionName + "\n" + release.releaseNotes);
                }
            }
        });
    }

    private void installLatestUpdate() {
        if (!saveConfigFromInputs()) return;
        updateInstalling = true;
        installUpdateButton.setEnabled(false);
        AppUpdater.downloadAndInstallAsync(this, latestRelease, new AppUpdater.Callback() {
            @Override
            public void onMessage(String message) {
                updateText.setText(message);
            }

            @Override
            public void onRelease(AppUpdater.ReleaseInfo release) {
                latestRelease = release == null ? latestRelease : release;
                installUpdateButton.setEnabled(!updateInstalling && latestRelease != null && latestRelease.updateAvailable);
            }
        });
    }

    private void requestSmsPermissions() {
        DefaultSmsRole.requestPermissions(this);
    }

    private void updateStatus() {
        boolean hasSms = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED;
        boolean hasReadSms = checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED;
        boolean hasPhoneState = SimInfoReader.hasPhoneStatePermission(this);
        SmsQueueStore store = new SmsQueueStore(this);
        int pending;
        try {
            pending = store.countPending();
        } finally {
            store.close();
        }
        int activeWindows = ActivationWindowStore.activeWindows(this).size();
        boolean notificationAccess = ActivationWindowStore.isNotificationAccessEnabled(this);
        statusText.setText(
            "短信权限：" + (hasSms ? "已授权" : "未授权")
            + "\n默认短信应用：" + (DefaultSmsRole.isDefaultSmsApp(this) ? "是" : "否")
            + "\n读取短信：" + (hasReadSms ? "已授权" : "未授权（OPPO 请在权限管理中单独允许）")
            + "\nSIM 权限：" + (hasPhoneState ? "已授权" : "未授权")
            + "\n通知监听：" + (notificationAccess ? "已授权" : "未授权")
            + "\n接码窗口：" + activeWindows + " 个"
            + "\n待补传短信：" + pending
            + "\n短信库：启动后自动同步，可手动立即同步"
            + "\n扫码自动化：需要开启无障碍服务"
            + "\nApp 版本：" + AppUpdater.currentVersionName(this) + " (" + AppUpdater.currentVersionCode(this) + ")"
            + "\n服务：" + RelayConfig.serverUrl(this)
        );
    }

    private void requestIgnoreBatteryOptimizations() {
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager != null && manager.isIgnoringBatteryOptimizations(getPackageName())) {
            Toast.makeText(this, "已经忽略电池优化", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + getPackageName()));
        startActivity(intent);
    }
}

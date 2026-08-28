package com.ztqc.smsrelay;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.ContentObserver;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Telephony;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class SmsHomeActivity extends Activity {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AtomicInteger loadGeneration = new AtomicInteger();
    private LinearLayout conversations;
    private TextView roleBanner;
    private EditText searchInput;
    private ContentObserver observer;
    private boolean takeoverRequestStarted;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        if (DefaultSmsRole.isDefaultSmsApp(this)) {
            DefaultSmsRole.requestPermissions(this);
            if (DefaultSmsRole.hasSmsPermissions(this) && DefaultSmsRole.hasPhonePermissions(this)) {
                requestNotificationPermission();
            }
        }
        RelayForegroundService.start(this);
        SmsUploadJobService.schedule(this, 0L);
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateRoleBanner();
        loadConversations();
        maybeRequestTakeover();
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (observer == null) {
            observer = new ContentObserver(mainHandler) {
                @Override
                public void onChange(boolean selfChange) {
                    loadConversations();
                }
            };
            try {
                getContentResolver().registerContentObserver(Telephony.Sms.CONTENT_URI, true, observer);
                getContentResolver().registerContentObserver(SmsQueueStore.LOCAL_MESSAGES_URI, true, observer);
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    protected void onStop() {
        if (observer != null) {
            try {
                getContentResolver().unregisterContentObserver(observer);
            } catch (Exception ignored) {
            }
            observer = null;
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(SmsUi.COLOR_BACKGROUND);
        root.setPadding(SmsUi.dp(this, 18), SmsUi.dp(this, 18), SmsUi.dp(this, 18), 0);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = SmsUi.title(this, "短信");
        header.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        Button settings = SmsUi.button(this, "设置");
        settings.setOnClickListener(view -> startActivity(new Intent(this, MainActivity.class)));
        header.addView(settings);
        Button compose = SmsUi.button(this, "新建");
        compose.setOnClickListener(view -> startActivity(new Intent(this, SmsComposeActivity.class)));
        header.addView(compose);
        root.addView(header);

        roleBanner = new TextView(this);
        roleBanner.setTextSize(14);
        roleBanner.setPadding(SmsUi.dp(this, 14), SmsUi.dp(this, 12), SmsUi.dp(this, 14), SmsUi.dp(this, 12));
        roleBanner.setOnClickListener(view -> DefaultSmsRole.requestDefaultRole(this));
        LinearLayout.LayoutParams bannerParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        bannerParams.setMargins(0, SmsUi.dp(this, 12), 0, SmsUi.dp(this, 10));
        root.addView(roleBanner, bannerParams);

        searchInput = new EditText(this);
        searchInput.setHint("搜索号码或短信内容");
        searchInput.setSingleLine(true);
        searchInput.setTextSize(15);
        searchInput.setPadding(SmsUi.dp(this, 16), SmsUi.dp(this, 10), SmsUi.dp(this, 16), SmsUi.dp(this, 10));
        searchInput.setBackground(SmsUi.rounded(0xffffffff, 14, this));
        searchInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { loadConversations(); }
            @Override public void afterTextChanged(Editable s) {}
        });
        root.addView(searchInput);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        conversations = new LinearLayout(this);
        conversations.setOrientation(LinearLayout.VERTICAL);
        conversations.setPadding(0, SmsUi.dp(this, 10), 0, SmsUi.dp(this, 24));
        scroll.addView(conversations);
        root.addView(scroll, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));
        setContentView(root);
    }

    private void updateRoleBanner() {
        if (DefaultSmsRole.isDefaultSmsApp(this)) {
            roleBanner.setText("已作为默认短信应用 · 新短信会先保存在本机，再自动上报");
            roleBanner.setTextColor(0xff226b50);
            roleBanner.setBackground(SmsUi.rounded(0xffe4f4ed, 12, this));
        } else {
            roleBanner.setText("设为默认短信应用，才能可靠接收并保存新短信（点击设置）");
            roleBanner.setTextColor(0xff8f321f);
            roleBanner.setBackground(SmsUi.rounded(0xffffe2d7, 12, this));
        }
    }

    private void maybeRequestTakeover() {
        if (takeoverRequestStarted || DefaultSmsRole.isDefaultSmsApp(this)) return;
        takeoverRequestStarted = true;
        mainHandler.postDelayed(() -> DefaultSmsRole.requestDefaultRole(this), 300L);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == DefaultSmsRole.REQUEST_SMS_PERMISSIONS) {
            if (DefaultSmsRole.isDefaultSmsApp(this)) requestNotificationPermission();
            else maybeRequestTakeover();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == DefaultSmsRole.REQUEST_DEFAULT_SMS) {
            updateRoleBanner();
            loadConversations();
            if (DefaultSmsRole.isDefaultSmsApp(this)) {
                DefaultSmsRole.requestPermissions(this);
                if (DefaultSmsRole.hasSmsPermissions(this) && DefaultSmsRole.hasPhonePermissions(this)) {
                    requestNotificationPermission();
                }
                RelayForegroundService.start(this);
                SmsUploadJobService.schedule(this, 0L);
            }
        }
    }

    private void loadConversations() {
        if (!DefaultSmsRole.hasReadSmsPermission(this)) {
            showEmpty("需要短信读取权限才能显示短信");
            return;
        }
        int generation = loadGeneration.incrementAndGet();
        String query = searchInput == null ? "" : searchInput.getText().toString();
        executor.execute(() -> {
            try {
                List<SmsModels.Conversation> rows = SmsRepository.loadConversations(this, query);
                mainHandler.post(() -> {
                    if (generation == loadGeneration.get()) renderConversations(rows);
                });
            } catch (Exception error) {
                mainHandler.post(() -> showEmpty("短信加载失败：" + error.getMessage()));
            }
        });
    }

    private void renderConversations(List<SmsModels.Conversation> rows) {
        conversations.removeAllViews();
        if (rows.isEmpty()) {
            showEmpty(searchInput.getText().length() > 0 ? "没有匹配的短信" : "暂无短信");
            return;
        }
        for (SmsModels.Conversation row : rows) conversations.addView(conversationRow(row));
    }

    private View conversationRow(SmsModels.Conversation row) {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(SmsUi.dp(this, 15), SmsUi.dp(this, 14), SmsUi.dp(this, 15), SmsUi.dp(this, 14));
        container.setBackground(SmsUi.rounded(0xffffffff, 13, this));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, SmsUi.dp(this, 6), 0, SmsUi.dp(this, 6));
        container.setLayoutParams(params);

        LinearLayout first = new LinearLayout(this);
        first.setGravity(Gravity.CENTER_VERTICAL);
        TextView address = new TextView(this);
        address.setText(row.address.isEmpty() ? "未知号码" : row.address);
        address.setTextColor(SmsUi.COLOR_TEXT);
        address.setTextSize(17);
        address.setTypeface(null, row.unreadCount > 0 ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
        first.addView(address, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView time = new TextView(this);
        time.setText(SmsUi.relativeTime(this, row.date));
        time.setTextColor(SmsUi.COLOR_MUTED);
        time.setTextSize(12);
        first.addView(time);
        container.addView(first);

        LinearLayout second = new LinearLayout(this);
        second.setGravity(Gravity.CENTER_VERTICAL);
        TextView snippet = new TextView(this);
        snippet.setText(row.snippet.replace('\n', ' '));
        snippet.setSingleLine(true);
        snippet.setTextColor(SmsUi.COLOR_MUTED);
        snippet.setTextSize(14);
        second.addView(snippet, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        if (row.unreadCount > 0) {
            TextView unread = new TextView(this);
            unread.setText(row.unreadCount > 99 ? "99+" : String.valueOf(row.unreadCount));
            unread.setTextColor(0xffffffff);
            unread.setTextSize(12);
            unread.setGravity(Gravity.CENTER);
            unread.setMinWidth(SmsUi.dp(this, 24));
            unread.setMinHeight(SmsUi.dp(this, 24));
            unread.setBackground(SmsUi.rounded(SmsUi.COLOR_ACCENT, 20, this));
            second.addView(unread);
        }
        container.addView(second);
        container.setOnClickListener(view -> {
            Intent intent = new Intent(this, SmsThreadActivity.class);
            intent.putExtra(SmsThreadActivity.EXTRA_THREAD_ID, row.threadId);
            intent.putExtra(SmsThreadActivity.EXTRA_ADDRESS, row.address);
            intent.putExtra(SmsThreadActivity.EXTRA_SUBSCRIPTION_ID, row.subscriptionId);
            startActivity(intent);
        });
        container.setOnLongClickListener(view -> {
            confirmDeleteConversation(row);
            return true;
        });
        return container;
    }

    private void confirmDeleteConversation(SmsModels.Conversation row) {
        new AlertDialog.Builder(this)
            .setTitle("删除会话")
            .setMessage("确定删除与“" + (row.address.isEmpty() ? "未知号码" : row.address) + "”的全部短信吗？")
            .setNegativeButton("取消", null)
            .setPositiveButton("删除", (dialog, which) -> executor.execute(() -> {
                SmsRepository.deleteThread(this, row.threadId);
                mainHandler.post(this::loadConversations);
            }))
            .show();
    }

    private void showEmpty(String message) {
        if (conversations == null) return;
        conversations.removeAllViews();
        TextView empty = new TextView(this);
        empty.setText(message);
        empty.setTextColor(SmsUi.COLOR_MUTED);
        empty.setTextSize(15);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(0, SmsUi.dp(this, 80), 0, 0);
        conversations.addView(empty, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 2003);
        }
    }
}

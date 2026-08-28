package com.ztqc.smsrelay;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.database.ContentObserver;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Telephony;
import android.view.Gravity;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class SmsThreadActivity extends Activity {
    public static final String EXTRA_THREAD_ID = "threadId";
    public static final String EXTRA_ADDRESS = "address";
    public static final String EXTRA_SUBSCRIPTION_ID = "subscriptionId";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final List<Integer> subscriptionIds = new ArrayList<>();
    private long threadId;
    private String address;
    private int preferredSubscriptionId;
    private LinearLayout messageList;
    private ScrollView messageScroll;
    private EditText replyInput;
    private Spinner simSpinner;
    private Button sendButton;
    private ContentObserver observer;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        threadId = getIntent().getLongExtra(EXTRA_THREAD_ID, -1L);
        address = getIntent().getStringExtra(EXTRA_ADDRESS);
        if (address == null) address = "";
        preferredSubscriptionId = getIntent().getIntExtra(EXTRA_SUBSCRIPTION_ID, Integer.MIN_VALUE);
        buildUi();
        loadSimOptions();
    }

    @Override
    protected void onResume() {
        super.onResume();
        loadMessages();
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (observer == null) {
            observer = new ContentObserver(mainHandler) {
                @Override public void onChange(boolean selfChange) { loadMessages(); }
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
            try { getContentResolver().unregisterContentObserver(observer); } catch (Exception ignored) {}
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

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(SmsUi.dp(this, 10), SmsUi.dp(this, 12), SmsUi.dp(this, 14), SmsUi.dp(this, 10));
        Button back = SmsUi.button(this, "返回");
        back.setOnClickListener(view -> finish());
        header.addView(back);
        TextView title = SmsUi.title(this, address.isEmpty() ? "短信会话" : address);
        header.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(header);

        messageScroll = new ScrollView(this);
        messageScroll.setFillViewport(true);
        messageList = new LinearLayout(this);
        messageList.setOrientation(LinearLayout.VERTICAL);
        messageList.setPadding(SmsUi.dp(this, 14), SmsUi.dp(this, 8), SmsUi.dp(this, 14), SmsUi.dp(this, 14));
        messageScroll.addView(messageList);
        root.addView(messageScroll, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));

        LinearLayout composer = new LinearLayout(this);
        composer.setGravity(Gravity.BOTTOM);
        composer.setPadding(SmsUi.dp(this, 12), SmsUi.dp(this, 8), SmsUi.dp(this, 12), SmsUi.dp(this, 12));
        composer.setBackgroundColor(0xffffffff);
        simSpinner = new Spinner(this);
        composer.addView(simSpinner, new LinearLayout.LayoutParams(SmsUi.dp(this, 88), LinearLayout.LayoutParams.WRAP_CONTENT));
        replyInput = new EditText(this);
        replyInput.setHint("输入短信");
        replyInput.setMinLines(1);
        replyInput.setMaxLines(5);
        replyInput.setTextSize(16);
        replyInput.setBackground(SmsUi.rounded(0xfff3eee9, 18, this));
        replyInput.setPadding(SmsUi.dp(this, 14), SmsUi.dp(this, 9), SmsUi.dp(this, 14), SmsUi.dp(this, 9));
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        inputParams.setMargins(SmsUi.dp(this, 6), 0, SmsUi.dp(this, 6), 0);
        composer.addView(replyInput, inputParams);
        sendButton = SmsUi.button(this, "发送");
        sendButton.setOnClickListener(view -> sendReply());
        composer.addView(sendButton);
        root.addView(composer);
        setContentView(root);
    }

    private void loadMessages() {
        if (threadId <= 0L) return;
        executor.execute(() -> {
            SmsRepository.markThreadRead(this, threadId);
            List<SmsModels.Message> rows = SmsRepository.loadThread(this, threadId);
            mainHandler.post(() -> renderMessages(rows));
        });
    }

    private void renderMessages(List<SmsModels.Message> rows) {
        messageList.removeAllViews();
        String latestAddress = address;
        for (SmsModels.Message row : rows) {
            if (!row.outgoing() && !row.address.isEmpty()) latestAddress = row.address;
            messageList.addView(messageBubble(row));
        }
        if (address.isEmpty() && !latestAddress.isEmpty()) address = latestAddress;
        messageScroll.post(() -> messageScroll.fullScroll(View.FOCUS_DOWN));
    }

    private View messageBubble(SmsModels.Message message) {
        LinearLayout line = new LinearLayout(this);
        line.setGravity(message.outgoing() ? Gravity.END : Gravity.START);
        LinearLayout bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setPadding(SmsUi.dp(this, 13), SmsUi.dp(this, 9), SmsUi.dp(this, 13), SmsUi.dp(this, 8));
        bubble.setBackground(SmsUi.rounded(message.outgoing() ? SmsUi.COLOR_OUTGOING : SmsUi.COLOR_INCOMING, 16, this));

        TextView body = new TextView(this);
        body.setText(message.body);
        body.setTextColor(SmsUi.COLOR_TEXT);
        body.setTextSize(16);
        bubble.addView(body);
        String code = CodeParser.extractCode(message.body);
        if (!code.isEmpty()) {
            Button copyCode = SmsUi.button(this, "复制验证码 " + code);
            copyCode.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            copyCode.setOnClickListener(view -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("验证码", code));
                Toast.makeText(this, "验证码已复制", Toast.LENGTH_SHORT).show();
            });
            bubble.addView(copyCode);
        }
        TextView time = new TextView(this);
        time.setText(new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(new Date(message.date)));
        time.setTextColor(SmsUi.COLOR_MUTED);
        time.setTextSize(11);
        time.setGravity(Gravity.END);
        bubble.addView(time);
        bubble.setOnLongClickListener(view -> {
            showMessageActions(message);
            return true;
        });
        View spacer = new View(this);
        LinearLayout.LayoutParams spacerParams = new LinearLayout.LayoutParams(0, 1, 0.18f);
        LinearLayout.LayoutParams bubbleParams = new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            0.82f
        );
        if (message.outgoing()) {
            line.addView(spacer, spacerParams);
            line.addView(bubble, bubbleParams);
        } else {
            line.addView(bubble, bubbleParams);
            line.addView(spacer, spacerParams);
        }
        LinearLayout.LayoutParams lineParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        lineParams.setMargins(0, SmsUi.dp(this, 5), 0, SmsUi.dp(this, 5));
        line.setLayoutParams(lineParams);
        return line;
    }

    private void showMessageActions(SmsModels.Message message) {
        new AlertDialog.Builder(this)
            .setItems(new String[] { "复制内容", "删除短信" }, (dialog, which) -> {
                if (which == 0) {
                    ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("短信", message.body));
                    Toast.makeText(this, "短信内容已复制", Toast.LENGTH_SHORT).show();
                    return;
                }
                new AlertDialog.Builder(this)
                    .setTitle("删除短信")
                    .setMessage("确定删除这条短信吗？")
                    .setNegativeButton("取消", null)
                    .setPositiveButton("删除", (confirm, confirmWhich) -> executor.execute(() -> {
                        SmsRepository.deleteMessage(this, message.id);
                        mainHandler.post(this::loadMessages);
                    }))
                    .show();
            })
            .show();
    }

    private void loadSimOptions() {
        List<String> labels = new ArrayList<>();
        subscriptionIds.clear();
        try {
            JSONArray sims = SimInfoReader.activeSims(this);
            for (int index = 0; index < sims.length(); index++) {
                JSONObject sim = sims.getJSONObject(index);
                int subscriptionId = sim.optInt("subscriptionId", Integer.MIN_VALUE);
                int slotIndex = sim.optInt("slotIndex", index);
                String carrier = sim.optString("carrierName", "");
                labels.add("SIM" + (slotIndex + 1) + (carrier.isEmpty() ? "" : " " + carrier));
                subscriptionIds.add(subscriptionId);
            }
        } catch (Exception ignored) {
        }
        if (labels.isEmpty()) {
            labels.add("默认卡");
            subscriptionIds.add(Integer.MIN_VALUE);
        }
        simSpinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, labels));
        int preferredIndex = subscriptionIds.indexOf(preferredSubscriptionId);
        if (preferredIndex >= 0) simSpinner.setSelection(preferredIndex);
    }

    private void sendReply() {
        String body = replyInput.getText().toString().trim();
        if (address.trim().isEmpty()) {
            Toast.makeText(this, "无法确定收件号码", Toast.LENGTH_LONG).show();
            return;
        }
        if (body.isEmpty()) return;
        int selected = simSpinner.getSelectedItemPosition();
        int subscriptionId = selected >= 0 && selected < subscriptionIds.size()
            ? subscriptionIds.get(selected) : Integer.MIN_VALUE;
        sendButton.setEnabled(false);
        executor.execute(() -> {
            try {
                long savedThreadId = SmsSender.send(this, address, body, subscriptionId);
                if (threadId <= 0L && savedThreadId > 0L) threadId = savedThreadId;
                mainHandler.post(() -> {
                    replyInput.setText("");
                    sendButton.setEnabled(true);
                    loadMessages();
                });
            } catch (Exception error) {
                mainHandler.post(() -> {
                    sendButton.setEnabled(true);
                    Toast.makeText(this, "发送失败：" + error.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        });
    }
}

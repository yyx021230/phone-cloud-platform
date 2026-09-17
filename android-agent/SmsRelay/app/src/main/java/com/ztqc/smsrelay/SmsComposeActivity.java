package com.ztqc.smsrelay;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class SmsComposeActivity extends Activity {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final List<Integer> subscriptionIds = new ArrayList<>();
    private EditText recipientInput;
    private EditText bodyInput;
    private Spinner simSpinner;
    private Button sendButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        loadExternalIntent(getIntent());
        loadSimOptions();
        DefaultSmsRole.requestPermissions(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        loadExternalIntent(intent);
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
        root.setPadding(SmsUi.dp(this, 18), SmsUi.dp(this, 16), SmsUi.dp(this, 18), SmsUi.dp(this, 18));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        Button back = SmsUi.button(this, "取消");
        back.setOnClickListener(view -> finish());
        header.addView(back);
        TextView title = SmsUi.title(this, "新短信");
        header.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(header);

        recipientInput = new EditText(this);
        recipientInput.setHint("收件号码");
        recipientInput.setSingleLine(true);
        recipientInput.setTextSize(17);
        recipientInput.setPadding(SmsUi.dp(this, 15), SmsUi.dp(this, 12), SmsUi.dp(this, 15), SmsUi.dp(this, 12));
        recipientInput.setBackground(SmsUi.rounded(0xffffffff, 14, this));
        LinearLayout.LayoutParams recipientParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        recipientParams.setMargins(0, SmsUi.dp(this, 18), 0, SmsUi.dp(this, 12));
        root.addView(recipientInput, recipientParams);

        bodyInput = new EditText(this);
        bodyInput.setHint("输入短信内容");
        bodyInput.setGravity(Gravity.TOP);
        bodyInput.setMinLines(7);
        bodyInput.setTextSize(17);
        bodyInput.setPadding(SmsUi.dp(this, 15), SmsUi.dp(this, 14), SmsUi.dp(this, 15), SmsUi.dp(this, 14));
        bodyInput.setBackground(SmsUi.rounded(0xffffffff, 14, this));
        root.addView(bodyInput, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.setPadding(0, SmsUi.dp(this, 12), 0, 0);
        simSpinner = new Spinner(this);
        actions.addView(simSpinner, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        sendButton = SmsUi.button(this, "发送短信");
        sendButton.setOnClickListener(view -> send());
        actions.addView(sendButton);
        root.addView(actions);
        setContentView(root);
    }

    private void loadExternalIntent(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data != null) {
            String recipient = data.getSchemeSpecificPart();
            if (recipient != null) {
                int queryIndex = recipient.indexOf('?');
                if (queryIndex >= 0) recipient = recipient.substring(0, queryIndex);
                recipientInput.setText(Uri.decode(recipient));
            }
        }
        String body = intent.getStringExtra("sms_body");
        if (body == null) body = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (body != null) bodyInput.setText(body);
    }

    private void loadSimOptions() {
        List<String> labels = new ArrayList<>();
        try {
            JSONArray sims = SimInfoReader.activeSims(this);
            for (int index = 0; index < sims.length(); index++) {
                JSONObject sim = sims.getJSONObject(index);
                int subscriptionId = sim.optInt("subscriptionId", Integer.MIN_VALUE);
                int slotIndex = sim.optInt("slotIndex", index);
                String carrier = sim.optString("carrierName", "");
                labels.add("使用 SIM" + (slotIndex + 1) + (carrier.isEmpty() ? "" : " · " + carrier));
                subscriptionIds.add(subscriptionId);
            }
        } catch (Exception ignored) {
        }
        if (labels.isEmpty()) {
            labels.add("使用默认 SIM 卡");
            subscriptionIds.add(Integer.MIN_VALUE);
        }
        simSpinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, labels));
    }

    private void send() {
        String recipient = recipientInput.getText().toString().trim();
        String body = bodyInput.getText().toString().trim();
        if (recipient.isEmpty() || body.isEmpty()) {
            Toast.makeText(this, "请填写收件号码和短信内容", Toast.LENGTH_SHORT).show();
            return;
        }
        int selected = simSpinner.getSelectedItemPosition();
        int subscriptionId = selected >= 0 && selected < subscriptionIds.size()
            ? subscriptionIds.get(selected) : Integer.MIN_VALUE;
        sendButton.setEnabled(false);
        executor.execute(() -> {
            try {
                long threadId = SmsSender.send(this, recipient, body, subscriptionId);
                runOnUiThread(() -> {
                    Intent open = new Intent(this, SmsThreadActivity.class);
                    open.putExtra(SmsThreadActivity.EXTRA_THREAD_ID, threadId);
                    open.putExtra(SmsThreadActivity.EXTRA_ADDRESS, recipient);
                    open.putExtra(SmsThreadActivity.EXTRA_SUBSCRIPTION_ID, subscriptionId);
                    startActivity(open);
                    finish();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    sendButton.setEnabled(true);
                    Toast.makeText(this, "发送失败：" + error.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        });
    }
}

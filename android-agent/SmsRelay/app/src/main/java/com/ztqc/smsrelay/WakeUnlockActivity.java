package com.ztqc.smsrelay;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Window;
import android.view.WindowManager;

public class WakeUnlockActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setTurnScreenOn(true);
            setShowWhenLocked(true);
        }

        requestDismissKeyguard();
        new Handler(Looper.getMainLooper()).postDelayed(this::requestDismissKeyguard, 700);
        new Handler(Looper.getMainLooper()).postDelayed(this::requestDismissKeyguard, 1_600);

        long finishDelayMs = getIntent().getLongExtra("finishDelayMs", 3_000L);
        finishDelayMs = Math.max(3_000L, Math.min(25_000L, finishDelayMs));
        new Handler(Looper.getMainLooper()).postDelayed(this::finish, finishDelayMs);
    }

    private void requestDismissKeyguard() {
        KeyguardManager keyguard = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (keyguard != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            keyguard.requestDismissKeyguard(this, null);
        }
    }
}

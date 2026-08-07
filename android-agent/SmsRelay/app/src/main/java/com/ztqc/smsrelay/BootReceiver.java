package com.ztqc.smsrelay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
            || RelayForegroundService.ACTION_POLL_TICK.equals(action)) {
            RelayForegroundService.start(context.getApplicationContext());
            if (RelayForegroundService.ACTION_POLL_TICK.equals(action)) {
                DeviceCommandExecutor.pollAsync(context.getApplicationContext());
            }
        }
    }
}

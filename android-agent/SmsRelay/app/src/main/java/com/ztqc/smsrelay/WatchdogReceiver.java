package com.ztqc.smsrelay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class WatchdogReceiver extends BroadcastReceiver {
    public static final String ACTION_RECOVER = "com.ztqc.smsrelay.RECOVER";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_RECOVER.equals(intent.getAction())) return;
        Context appContext = context.getApplicationContext();
        RelayForegroundService.start(appContext);
        SmsUploadJobService.schedule(appContext, 0L);
        SmsLibrarySync.syncAsync(appContext, false);
    }
}

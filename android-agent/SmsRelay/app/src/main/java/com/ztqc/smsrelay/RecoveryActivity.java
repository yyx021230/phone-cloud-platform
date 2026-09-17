package com.ztqc.smsrelay;

import android.app.Activity;
import android.os.Bundle;

/**
 * Shell-only, no-display entry point which clears Android's stopped-package
 * state and asks SmsRelay to resume its own work.  This is deliberately an
 * Activity: explicit broadcasts are not delivered after force-stop on some
 * OEM Android builds, while an explicit Activity launch is reliable.
 */
public final class RecoveryActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        RelayForegroundService.start(getApplicationContext());
        if (AppMode.isCompatibilityProbe(this)) {
            finish();
            return;
        }
        SmsUploadJobService.schedule(getApplicationContext(), 0L);
        SmsProviderMirror.repairAsync(getApplicationContext());
        SmsLibrarySync.syncAsync(getApplicationContext(), false);
        finish();
    }
}

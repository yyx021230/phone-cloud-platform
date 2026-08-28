package com.ztqc.smsrelay;

import android.content.Context;

public final class AppMode {
    private static final String COMPAT_PROBE_SUFFIX = ".compatprobe";

    private AppMode() {}

    public static boolean isCompatibilityProbe(Context context) {
        return context != null && context.getPackageName().endsWith(COMPAT_PROBE_SUFFIX);
    }
}

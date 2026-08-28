package com.ztqc.smsrelay;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.format.DateUtils;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

public final class SmsUi {
    public static final int COLOR_TEXT = 0xff24170f;
    public static final int COLOR_MUTED = 0xff78685d;
    public static final int COLOR_ACCENT = 0xffb24a2a;
    public static final int COLOR_SURFACE = 0xffffffff;
    public static final int COLOR_BACKGROUND = 0xfff8f3ee;
    public static final int COLOR_INCOMING = 0xffffffff;
    public static final int COLOR_OUTGOING = 0xffffdfcf;

    private SmsUi() {}

    public static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    public static TextView title(Context context, String text) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextColor(COLOR_TEXT);
        view.setTextSize(23);
        view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    public static Button button(Context context, String text) {
        Button view = new Button(context);
        view.setText(text);
        view.setAllCaps(false);
        view.setTextColor(COLOR_ACCENT);
        view.setBackgroundColor(0x00ffffff);
        view.setMinHeight(dp(context, 44));
        view.setPadding(dp(context, 10), 0, dp(context, 10), 0);
        return view;
    }

    public static GradientDrawable rounded(int color, float radiusDp, Context context) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(context, Math.round(radiusDp)));
        return drawable;
    }

    public static String relativeTime(Context context, long timestamp) {
        if (timestamp <= 0L) return "";
        return DateUtils.getRelativeTimeSpanString(
            timestamp,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS,
            DateUtils.FORMAT_ABBREV_RELATIVE
        ).toString();
    }

    public static void divider(View view, Context context) {
        view.setBackgroundColor(0x1f7a685c);
        view.setMinimumHeight(dp(context, 1));
    }
}

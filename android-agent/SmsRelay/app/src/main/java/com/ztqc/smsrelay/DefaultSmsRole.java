package com.ztqc.smsrelay;

import android.Manifest;
import android.app.Activity;
import android.app.role.RoleManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Telephony;

import java.util.ArrayList;
import java.util.List;

public final class DefaultSmsRole {
    public static final int REQUEST_DEFAULT_SMS = 2001;
    public static final int REQUEST_SMS_PERMISSIONS = 2002;

    private DefaultSmsRole() {}

    public static boolean isDefaultSmsApp(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                RoleManager manager = (RoleManager) context.getSystemService(Context.ROLE_SERVICE);
                if (manager != null && manager.isRoleAvailable(RoleManager.ROLE_SMS)) {
                    return manager.isRoleHeld(RoleManager.ROLE_SMS);
                }
            } catch (RuntimeException ignored) {
                // Some ColorOS builds expose a working SMS handler while their
                // role dump/API is incomplete. Telephony remains the authority.
            }
        }
        String packageName = Telephony.Sms.getDefaultSmsPackage(context);
        return context.getPackageName().equals(packageName);
    }

    public static boolean isSmsRoleAvailable(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                RoleManager manager = (RoleManager) context.getSystemService(Context.ROLE_SERVICE);
                if (manager != null && manager.isRoleAvailable(RoleManager.ROLE_SMS)) return true;
            } catch (RuntimeException ignored) {
            }
        }
        return context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
            && Telephony.Sms.getDefaultSmsPackage(context) != null;
    }

    public static boolean hasReadSmsPermission(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
            || context.checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED;
    }

    public static boolean hasSmsPermissions(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return context.checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
            && context.checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
            && context.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED;
    }

    public static boolean hasPhonePermissions(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return false;
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED;
    }

    public static void requestPermissions(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        List<String> missing = new ArrayList<>();
        addIfMissing(activity, missing, Manifest.permission.READ_SMS);
        addIfMissing(activity, missing, Manifest.permission.RECEIVE_SMS);
        addIfMissing(activity, missing, Manifest.permission.SEND_SMS);
        addIfMissing(activity, missing, Manifest.permission.READ_PHONE_STATE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            addIfMissing(activity, missing, Manifest.permission.READ_PHONE_NUMBERS);
        }
        if (!missing.isEmpty()) {
            activity.requestPermissions(missing.toArray(new String[0]), REQUEST_SMS_PERMISSIONS);
        }
    }

    public static void requestDefaultRole(Activity activity) {
        if (isDefaultSmsApp(activity)) return;
        rememberPreviousDefault(activity);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                RoleManager manager = (RoleManager) activity.getSystemService(Context.ROLE_SERVICE);
                if (manager != null && manager.isRoleAvailable(RoleManager.ROLE_SMS)) {
                    activity.startActivityForResult(
                        manager.createRequestRoleIntent(RoleManager.ROLE_SMS),
                        REQUEST_DEFAULT_SMS
                    );
                    return;
                }
            } catch (RuntimeException ignored) {
                // Fall through to the legacy default-SMS intent for OEM ROMs
                // whose RoleManager facade is incomplete.
            }
        }
        try {
            Intent intent = new Intent(Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT);
            intent.putExtra(Telephony.Sms.Intents.EXTRA_PACKAGE_NAME, activity.getPackageName());
            activity.startActivityForResult(intent, REQUEST_DEFAULT_SMS);
        } catch (RuntimeException ignored) {
            android.widget.Toast.makeText(activity, "系统未提供默认短信切换入口", android.widget.Toast.LENGTH_LONG).show();
        }
    }

    public static String previousDefaultSmsPackage(Context context) {
        return context.getSharedPreferences("default_sms_role", Context.MODE_PRIVATE)
            .getString("previous_default_package", "");
    }

    private static void rememberPreviousDefault(Context context) {
        String current = Telephony.Sms.getDefaultSmsPackage(context);
        if (current == null || current.isEmpty() || current.equals(context.getPackageName())) return;
        context.getSharedPreferences("default_sms_role", Context.MODE_PRIVATE)
            .edit()
            .putString("previous_default_package", current)
            .apply();
    }

    private static void addIfMissing(Context context, List<String> missing, String permission) {
        if (context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
    }
}

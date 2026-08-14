package com.phonecloud.smsprobe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.telephony.SmsMessage;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Read-only, no-APK SMS broadcast probe for a single Android device.
 *
 * The probe deliberately logs only message metadata and irreversible hashes.
 * It never prints the sender, message body, or an extracted verification code.
 */
public final class Main {
    private static final String SMS_RECEIVED = "android.provider.Telephony.SMS_RECEIVED";
    private static final String[] SUBSCRIPTION_EXTRAS = {
            "subscription",
            "subscriptionId",
            "android.telephony.extra.SUBSCRIPTION_INDEX",
            "slot",
            "slotId",
            "phone",
            "phoneId"
    };

    private Main() {}

    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
        RuntimeContext runtime = createSystemContext();
        Context context = runtime.context;

        IntentFilter filter = new IntentFilter(SMS_RECEIVED);
        filter.setPriority(1_000);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ignored, Intent intent) {
                try {
                    emitSmsMetadata(intent);
                } catch (Throwable error) {
                    emitError("receive_failed", error);
                }
            }
        };

        try {
            registerReceiverWithoutProcessRecord(runtime, receiver, filter);
        } catch (Throwable error) {
            emitError("register_failed", error);
            throw error;
        }

        System.out.println("{\"event\":\"ready\",\"sdk\":" + Build.VERSION.SDK_INT
                + ",\"uid\":" + android.os.Process.myUid() + "}");
        System.out.flush();
        Looper.loop();
    }

    private static RuntimeContext createSystemContext() throws Exception {
        Class<?> activityThreadClass = Class.forName("android.app.ActivityThread");
        Constructor<?> constructor = activityThreadClass.getDeclaredConstructor();
        constructor.setAccessible(true);
        Object activityThread = constructor.newInstance();

        Field currentThread = activityThreadClass.getDeclaredField("sCurrentActivityThread");
        currentThread.setAccessible(true);
        currentThread.set(null, activityThread);

        Field systemThread = activityThreadClass.getDeclaredField("mSystemThread");
        systemThread.setAccessible(true);
        systemThread.setBoolean(activityThread, true);

        // registerReceiver() consults ActivityThread instrumentation state on
        // ColorOS 13. The wake-only helper never reaches that code path.
        Class<?> instrumentationClass = Class.forName("android.app.Instrumentation");
        Constructor<?> instrumentationConstructor = instrumentationClass.getDeclaredConstructor();
        instrumentationConstructor.setAccessible(true);
        Object instrumentation = instrumentationConstructor.newInstance();
        Field instrumentationField = activityThreadClass.getDeclaredField("mInstrumentation");
        instrumentationField.setAccessible(true);
        instrumentationField.set(activityThread, instrumentation);

        if (Build.VERSION.SDK_INT >= 31) {
            try {
                Class<?> internalClass = Class.forName("android.app.ActivityThreadInternal");
                Class<?> controllerClass = Class.forName("android.app.ConfigurationController");
                Constructor<?> controllerConstructor = controllerClass.getDeclaredConstructor(internalClass);
                controllerConstructor.setAccessible(true);
                Object controller = controllerConstructor.newInstance(activityThread);
                Field controllerField = activityThreadClass.getDeclaredField("mConfigurationController");
                controllerField.setAccessible(true);
                controllerField.set(activityThread, controller);
            } catch (ReflectiveOperationException ignored) {
                // Some vendor builds do not expose ConfigurationController.
            }
        }

        Method getSystemContext = activityThreadClass.getDeclaredMethod("getSystemContext");
        Context context = (Context) getSystemContext.invoke(activityThread);
        return new RuntimeContext(context, activityThread, instrumentation);
    }

    /**
     * Context.registerReceiver() supplies ActivityThread.mAppThread to AMS. A
     * standalone app_process has no AMS ProcessRecord, so ColorOS rejects it.
     * Build the standard LoadedApk receiver dispatcher but register it with a
     * null application thread, preserving the real shell Binder identity.
     */
    private static void registerReceiverWithoutProcessRecord(
            RuntimeContext runtime,
            BroadcastReceiver receiver,
            IntentFilter filter) throws Exception {
        Field packageInfoField = runtime.context.getClass().getDeclaredField("mPackageInfo");
        packageInfoField.setAccessible(true);
        Object loadedApk = packageInfoField.get(runtime.context);
        if (loadedApk == null) throw new IllegalStateException("loaded_apk_unavailable");

        Object dispatcher = null;
        for (Method method : loadedApk.getClass().getDeclaredMethods()) {
            if (!"getReceiverDispatcher".equals(method.getName())) continue;
            int count = method.getParameterTypes().length;
            if (count != 5 && count != 6) continue;
            method.setAccessible(true);
            Object[] arguments = count == 5
                    ? new Object[]{receiver, runtime.context, new Handler(Looper.myLooper()), runtime.instrumentation, true}
                    : new Object[]{receiver, runtime.context, new Handler(Looper.myLooper()), runtime.instrumentation, true, 0};
            dispatcher = method.invoke(loadedApk, arguments);
            break;
        }
        if (dispatcher == null) throw new IllegalStateException("receiver_dispatcher_unavailable");

        Class<?> activityManagerClass = Class.forName("android.app.ActivityManager");
        Method getService = activityManagerClass.getDeclaredMethod("getService");
        getService.setAccessible(true);
        Object activityManager = getService.invoke(null);

        Method target = null;
        for (Method method : activityManager.getClass().getMethods()) {
            int count = method.getParameterTypes().length;
            if ("registerReceiverWithFeature".equals(method.getName()) && (count == 8 || count == 9)) {
                target = method;
                break;
            }
            if ("registerReceiver".equals(method.getName()) && count == 7) target = method;
        }
        if (target == null) throw new IllegalStateException("activity_manager_register_unavailable");
        target.setAccessible(true);

        int parameterCount = target.getParameterTypes().length;
        if ("registerReceiverWithFeature".equals(target.getName()) && parameterCount == 9) {
            target.invoke(activityManager, null, "com.android.shell", null, "phonecloud.smsprobe",
                    dispatcher, filter, null, 0, 2);
        } else if ("registerReceiverWithFeature".equals(target.getName())) {
            target.invoke(activityManager, null, "com.android.shell", null,
                    dispatcher, filter, null, 0, 2);
        } else {
            target.invoke(activityManager, null, "com.android.shell",
                    dispatcher, filter, null, 0, 2);
        }
    }

    private static void emitSmsMetadata(Intent intent) throws Exception {
        Bundle extras = intent.getExtras();
        Object[] pdus = extras == null ? null : (Object[]) extras.get("pdus");
        String format = extras == null ? null : extras.getString("format");
        if (pdus == null || pdus.length == 0) {
            System.out.println("{\"event\":\"sms_received_without_pdu\"}");
            System.out.flush();
            return;
        }

        StringBuilder body = new StringBuilder();
        String sender = null;
        long smsTimestampMs = 0L;
        int decodedSegments = 0;
        for (Object pduValue : pdus) {
            if (!(pduValue instanceof byte[])) continue;
            SmsMessage message = createSmsMessage((byte[]) pduValue, format);
            if (message == null) continue;
            decodedSegments += 1;
            if (sender == null) sender = message.getOriginatingAddress();
            String part = message.getMessageBody();
            if (part != null) body.append(part);
            smsTimestampMs = Math.max(smsTimestampMs, message.getTimestampMillis());
        }

        String text = body.toString();
        StringBuilder json = new StringBuilder(256);
        json.append("{\"event\":\"sms_received\"")
                .append(",\"receivedAtMs\":").append(System.currentTimeMillis())
                .append(",\"smsTimestampMs\":").append(smsTimestampMs)
                .append(",\"pduSegments\":").append(pdus.length)
                .append(",\"decodedSegments\":").append(decodedSegments)
                .append(",\"bodyLength\":").append(text.length())
                .append(",\"bodySha256\":\"").append(hash(text, 24)).append("\"")
                .append(",\"senderSha256\":\"").append(hash(sender == null ? "" : sender, 16)).append("\"")
                .append(",\"format\":\"").append(jsonEscape(format == null ? "unknown" : format)).append("\"");

        for (String key : SUBSCRIPTION_EXTRAS) {
            if (extras != null && extras.containsKey(key)) {
                Object value = extras.get(key);
                if (value instanceof Number) {
                    json.append(",\"").append(jsonEscape(key)).append("\":")
                            .append(((Number) value).longValue());
                }
            }
        }
        json.append('}');
        System.out.println(json.toString());
        System.out.flush();
    }

    private static SmsMessage createSmsMessage(byte[] pdu, String format) throws Exception {
        if (format != null) {
            try {
                Method method = SmsMessage.class.getMethod("createFromPdu", byte[].class, String.class);
                return (SmsMessage) method.invoke(null, pdu, format);
            } catch (NoSuchMethodException ignored) {
                // Android versions before API 23 expose only the one-argument overload.
            }
        }
        return SmsMessage.createFromPdu(pdu);
    }

    private static String hash(String value, int chars) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(digest.length * 2);
        for (byte item : digest) result.append(String.format(Locale.US, "%02x", item & 0xff));
        return result.substring(0, Math.min(chars, result.length()));
    }

    private static String jsonEscape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static void emitError(String event, Throwable error) {
        String message = error.getMessage();
        if (message == null) message = "";
        if (message.length() > 160) message = message.substring(0, 160);
        System.out.println("{\"event\":\"" + jsonEscape(event) + "\",\"errorType\":\""
                + jsonEscape(error.getClass().getName()) + "\",\"message\":\""
                + jsonEscape(message) + "\"}");
        System.out.flush();
    }

    private static final class RuntimeContext {
        final Context context;
        final Object activityThread;
        final Object instrumentation;

        RuntimeContext(Context context, Object activityThread, Object instrumentation) {
            this.context = context;
            this.activityThread = activityThread;
            this.instrumentation = instrumentation;
        }
    }
}

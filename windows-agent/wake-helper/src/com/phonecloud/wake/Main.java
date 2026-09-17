package com.phonecloud.wake;

import android.content.Context;
import android.os.Build;
import android.os.Looper;
import android.os.PowerManager;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

public final class Main {
    private Main() {}

    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
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
        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) throw new IllegalStateException("power_manager_unavailable");
        if (powerManager.isInteractive()) {
            System.out.println("already_awake");
            return;
        }

        int flags = PowerManager.FULL_WAKE_LOCK
                | PowerManager.ACQUIRE_CAUSES_WAKEUP
                | PowerManager.ON_AFTER_RELEASE;
        PowerManager.WakeLock wakeLock = powerManager.newWakeLock(flags, "PhoneCloud:ScreenWake");
        wakeLock.acquire(3_000L);
        try {
            Thread.sleep(1_000L);
            System.out.println(powerManager.isInteractive() ? "awake" : "wake_requested");
        } finally {
            if (wakeLock.isHeld()) wakeLock.release();
        }
    }
}

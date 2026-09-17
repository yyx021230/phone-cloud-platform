package com.ztqc.smsrelay;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.Context;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.database.ContentObserver;
import android.provider.Telephony;

import java.util.concurrent.atomic.AtomicBoolean;

public class RelayForegroundService extends Service {
    public static final String ACTION_START = "com.ztqc.smsrelay.START";
    public static final String ACTION_POLL_TICK = "com.ztqc.smsrelay.POLL_TICK";
    private static final String CHANNEL_ID = "sms_relay_status";
    private static final int NOTIFICATION_ID = 9101;
    private static final int POLL_ALARM_REQUEST_CODE = 9102;
    private static final long POLL_ALARM_INTERVAL_MS = 30_000;
    private static final long FAST_COMMAND_POLL_MS = 2_000;
    private static final long LIVE_CONNECTED_COMMAND_POLL_MS = 30_000;
    private static volatile RelayForegroundService activeService;
    private static final AtomicBoolean queueDrainRunning = new AtomicBoolean(false);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private ContentObserver smsObserver;
    private boolean foregroundStarted;
    private final Runnable heartbeat = new Runnable() {
        @Override
        public void run() {
            SmsRelayDiagnostics.recordServiceAlive(RelayForegroundService.this);
            RelayClient.sendHeartbeatAsync(RelayForegroundService.this);
            drainQueueAsync(RelayForegroundService.this);
            SmsProviderMirror.repairAsync(RelayForegroundService.this);
            SmsLibrarySync.syncAsync(RelayForegroundService.this, false);
            handler.postDelayed(this, 60_000);
        }
    };
    private final Runnable commandPoll = new Runnable() {
        @Override
        public void run() {
            ActivationWindowStore.refreshAsync(RelayForegroundService.this);
            ScanAccessibilityService.nudgeActiveFlow();
            DeviceCommandExecutor.pollAsync(RelayForegroundService.this);
            handler.postDelayed(this, DeviceLiveClient.isConnected() ? LIVE_CONNECTED_COMMAND_POLL_MS : FAST_COMMAND_POLL_MS);
        }
    };

    public static void start(android.content.Context context) {
        Intent intent = new Intent(context, RelayForegroundService.class);
        intent.setAction(ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception ignored) {
            SmsRelayDiagnostics.recordServiceStartFailure(context, ignored);
            // Some OEM builds temporarily block background FGS starts; the durable
            // receiver/outbox and JobScheduler remain active and the next explicit
            // recovery/open event will retry only this package.
        }
        if (!AppMode.isCompatibilityProbe(context)) schedulePollAlarm(context);
    }

    public static void schedulePollAlarm(android.content.Context context) {
        try {
            android.content.Context appContext = context.getApplicationContext();
            AlarmManager alarmManager = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
            if (alarmManager == null) return;
            Intent intent = new Intent(appContext, BootReceiver.class);
            intent.setAction(ACTION_POLL_TICK);
            PendingIntent pendingIntent = PendingIntent.getBroadcast(
                appContext,
                POLL_ALARM_REQUEST_CODE,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
            );
            long triggerAt = SystemClock.elapsedRealtime() + POLL_ALARM_INTERVAL_MS;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent);
            } else {
                alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent);
            }
        } catch (Exception ignored) {
        }
    }

    public static void drainQueueAsync(android.content.Context context) {
        android.content.Context appContext = context.getApplicationContext();
        new Thread(() -> drainQueueNow(appContext)).start();
    }

    public static void drainQueueNow(android.content.Context context) {
        if (!queueDrainRunning.compareAndSet(false, true)) return;
        SmsQueueStore store = new SmsQueueStore(context);
        try {
            // One bounded batch per drain: a bad row must not starve later rows,
            // while a large offline outbox must not monopolize a worker forever.
            java.util.List<SmsQueueStore.PendingSms> pending = store.listPending(20);
            for (SmsQueueStore.PendingSms item : pending) {
                try {
                    String serverEventId = RelayClient.sendQueuedSmsBlocking(context, item);
                    store.markSent(item.id, serverEventId);
                } catch (Exception error) {
                    store.markFailed(item.id, error);
                }
            }
            if (store.countPending() > 0) {
                SmsUploadJobService.schedule(context, Math.max(1_000L, store.nextRetryDelayMillis()));
            }
        } finally {
            store.close();
            queueDrainRunning.set(false);
        }
    }

    public static void syncSmsLibraryAsync(android.content.Context context, boolean forceFull) {
        SmsLibrarySync.syncAsync(context.getApplicationContext(), forceFull);
    }

    public static void requestImmediateCommandPoll(android.content.Context context) {
        DeviceCommandExecutor.pollAsync(context.getApplicationContext());
        RelayForegroundService service = activeService;
        if (service != null) {
            service.handler.removeCallbacks(service.commandPoll);
            service.handler.post(service.commandPoll);
        } else {
            start(context);
        }
    }

    public static void requestImmediateActivationRefresh(android.content.Context context) {
        ActivationWindowStore.refreshNowAsync(context.getApplicationContext());
        RelayForegroundService service = activeService;
        if (service != null) {
            service.handler.removeCallbacks(service.commandPoll);
            service.handler.post(service.commandPoll);
        } else {
            start(context);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        activeService = this;
        SmsRelayDiagnostics.recordServiceAlive(this);
        createChannel();
        try {
            startRelayForeground();
            foregroundStarted = true;
            SmsRelayDiagnostics.recordServiceStartSuccess(this);
        } catch (Exception error) {
            foregroundStarted = false;
            SmsRelayDiagnostics.recordServiceStartFailure(this, error);
            stopSelf();
            return;
        }
        if (AppMode.isCompatibilityProbe(this)) return;
        DeviceLiveClient.start(this);
        registerSmsObserver();
        schedulePollAlarm(this);
        SmsUploadJobService.schedule(this, 0L);
        SmsLibrarySync.syncAsync(this, true);
        heartbeat.run();
        commandPoll.run();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!foregroundStarted) return START_NOT_STICKY;
        SmsRelayDiagnostics.recordServiceAlive(this);
        if (AppMode.isCompatibilityProbe(this)) return START_NOT_STICKY;
        RelayClient.sendHeartbeatAsync(this);
        drainQueueAsync(this);
        SmsProviderMirror.repairAsync(this);
        SmsLibrarySync.syncAsync(this, false);
        ActivationWindowStore.refreshAsync(this);
        DeviceLiveClient.start(this);
        DeviceCommandExecutor.pollAsync(this);
        if (!AppMode.isCompatibilityProbe(this)) schedulePollAlarm(this);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (activeService == this) activeService = null;
        handler.removeCallbacks(heartbeat);
        handler.removeCallbacks(commandPoll);
        unregisterSmsObserver();
        DeviceLiveClient.stop();
        if (!AppMode.isCompatibilityProbe(this)) schedulePollAlarm(this);
        super.onDestroy();
    }

    private void registerSmsObserver() {
        if (smsObserver != null) return;
        smsObserver = new ContentObserver(handler) {
            @Override
            public void onChange(boolean selfChange) {
                super.onChange(selfChange);
                SmsLibrarySync.syncAsync(RelayForegroundService.this, false);
            }
        };
        try {
            getContentResolver().registerContentObserver(Telephony.Sms.CONTENT_URI, true, smsObserver);
        } catch (Exception ignored) {
        }
    }

    private void unregisterSmsObserver() {
        if (smsObserver == null) return;
        try {
            getContentResolver().unregisterContentObserver(smsObserver);
        } catch (Exception ignored) {
        }
        smsObserver = null;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onTimeout(int startId, int foregroundServiceType) {
        SmsRelayDiagnostics.recordServiceStartFailure(
            this,
            new IllegalStateException("foreground service timeout type=" + foregroundServiceType)
        );
        stopSelf(startId);
    }

    private void startRelayForeground() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "验证码中控运行状态",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("保持短信验证码上报服务在线");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent intent = new Intent(this, SmsHomeActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        return builder
            .setContentTitle("ZTC 云控正在运行")
            .setContentText("短信、设备状态和任务轨迹会自动上报到私有中台")
            .setSmallIcon(R.drawable.ic_stat_ztc)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build();
    }
}

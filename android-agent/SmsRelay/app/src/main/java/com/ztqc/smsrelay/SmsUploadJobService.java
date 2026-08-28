package com.ztqc.smsrelay;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

public class SmsUploadJobService extends JobService {
    private static final int JOB_ID = 9104;

    public static void schedule(Context context, long minimumLatencyMillis) {
        try {
            JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (scheduler == null) return;
            JobInfo.Builder builder = new JobInfo.Builder(
                JOB_ID,
                new ComponentName(context, SmsUploadJobService.class)
            )
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .setBackoffCriteria(30_000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL);
            if (minimumLatencyMillis > 0L) builder.setMinimumLatency(minimumLatencyMillis);
            scheduler.schedule(builder.build());
        } catch (Exception ignored) {
        }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try {
                RelayForegroundService.drainQueueNow(getApplicationContext());
            } catch (Exception error) {
                schedule(getApplicationContext(), 30_000L);
            }
            // drainQueueNow schedules the exact next row-level retry. Do not ask
            // JobScheduler to add a second, unrelated backoff sequence.
            jobFinished(params, false);
        }, "sms-upload-job").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}

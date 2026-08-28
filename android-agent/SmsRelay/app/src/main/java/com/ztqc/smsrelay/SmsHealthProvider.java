package com.ztqc.smsrelay;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;

import org.json.JSONObject;

public class SmsHealthProvider extends ContentProvider {
    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        JSONObject snapshot = SmsRelayDiagnostics.snapshot(getContext());
        try {
            snapshot.put("processCheckedAt", System.currentTimeMillis());
        } catch (Exception ignored) {
        }
        MatrixCursor cursor = new MatrixCursor(new String[] { "status_json" });
        cursor.addRow(new Object[] { snapshot.toString() });
        return cursor;
    }

    @Override public String getType(Uri uri) { return "application/json"; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
}

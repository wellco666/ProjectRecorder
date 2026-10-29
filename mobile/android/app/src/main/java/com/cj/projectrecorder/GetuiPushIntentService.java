package com.cj.projectrecorder;

import android.content.Context;
import android.util.Log;

import com.igexin.sdk.GTIntentService;
import com.igexin.sdk.message.GTCmdMessage;
import com.igexin.sdk.message.GTNotificationMessage;
import com.igexin.sdk.message.GTTransmitMessage;

/** Stores the SDK CID even when the WebView is not running. */
public class GetuiPushIntentService extends GTIntentService {
    private static final String TAG = "ProjectRecorderPush";

    @Override public void onReceiveServicePid(Context context, int pid) { }

    @Override
    public void onReceiveClientId(Context context, String clientId) {
        GetuiPushPlugin.saveClientId(context, clientId);
        Log.i(TAG, "Getui client id registered");
    }

    @Override public void onReceiveMessageData(Context context, GTTransmitMessage message) { }

    @Override public void onReceiveOnlineState(Context context, boolean online) { }

    @Override public void onReceiveCommandResult(Context context, GTCmdMessage message) { }

    @Override public void onNotificationMessageArrived(Context context, GTNotificationMessage message) { }

    @Override public void onNotificationMessageClicked(Context context, GTNotificationMessage message) { }
}

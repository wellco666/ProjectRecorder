package com.cj.projectrecorder;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.igexin.sdk.PushManager;

/** Consent-gated bridge to the native GeTui SDK. */
@CapacitorPlugin(name = "GetuiPush")
public class GetuiPushPlugin extends Plugin {
    private static final String PREFS = "project_recorder_push";
    private static final String CONSENT = "getui_consent";
    private static final String CID = "getui_cid";

    @PluginMethod
    public void enable(PluginCall call) {
        Context context = getContext();
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(CONSENT, true).apply();
        try {
            PushManager.getInstance().initialize(context);
            JSObject result = new JSObject();
            result.put("clientId", readClientId(context));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("个推初始化失败：" + error.getMessage());
        }
    }

    @PluginMethod
    public void clientId(PluginCall call) {
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!prefs.getBoolean(CONSENT, false)) {
            call.reject("用户尚未同意推送隐私说明");
            return;
        }
        JSObject result = new JSObject();
        result.put("clientId", readClientId(context));
        call.resolve(result);
    }

    private String readClientId(Context context) {
        String cached = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(CID, "");
        if (cached != null && !cached.isEmpty()) return cached;
        try {
            String value = PushManager.getInstance().getClientid(context);
            return value == null ? "" : value;
        } catch (Exception ignored) {
            return "";
        }
    }

    static void saveClientId(Context context, String clientId) {
        if (clientId == null || clientId.isEmpty()) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(CID, clientId).apply();
    }
}

package com.cj.projectrecorder;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 通知设置 + **原生建通知渠道**。
 *
 * ## 为什么要用原生建渠道，不用 Capacitor 的 createChannel
 *
 * 实测发现（`node check-push-channel.js`）Capacitor LocalNotifications 的
 * `createChannel({ importance: 4 })` **不可靠**：
 *
 *     pr-alerts-v1   要 4 → 实际 4   ✓
 *     pr-task-v2     要 4 → 实际 2   ✗
 *
 * 同一段代码、同一个参数，两个渠道出来两个级别。而 Android 的
 * **渠道级别建好就锁死**，建错了只能换名字重来——试错成本很高。
 *
 * 所以这里直接调系统的 `NotificationManager.createNotificationChannel()`，
 * 用 `IMPORTANCE_HIGH` 常量。少一层封装，少一个出错的地方。
 *
 * ## 注意：渠道一旦存在，级别改不动
 *
 * Android 的硬规则：`createNotificationChannel` 对**已存在的**渠道
 * 只更新名字和描述，**不动重要级别**（防止 App 偷偷提升打扰级别）。
 *
 * 所以要升级别只能换新的 channel id。这个方法对此无能为力，
 * 但至少它建的时候级别是**确定的**。
 */
@CapacitorPlugin(name = "NotificationSettings")
public class NotificationSettingsPlugin extends Plugin {

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra("android.provider.extra.APP_PACKAGE", getContext().getPackageName());
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("无法打开通知设置：" + error.getMessage());
        }
    }

    /**
     * 建一个会弹横幅的通知渠道。
     *
     * 参数：
     *   id          渠道 id
     *   name        用户在设置里看到的名字
     *   description 说明文字
     *
     * 级别固定用 IMPORTANCE_HIGH（= 4，会弹横幅 + 响 + 震）。
     * 不做成参数，是为了避免"传错了也不知道"——
     * 这个方法存在的唯一理由就是建高优先级渠道。
     *
     * 返回：{ id, importance, created }
     *   importance 是建完之后**实际**的级别，调用方可以核对；
     *   created 表示这次是不是真的新建了（false = 早就存在，级别没改）。
     */
    @PluginMethod
    public void createHeadsUpChannel(PluginCall call) {
        JSObject result = new JSObject();
        try {
            String id = call.getString("id");
            String name = call.getString("name", "通知");
            String description = call.getString("description", "");
            if (id == null || id.isEmpty()) {
                call.reject("id 不能为空");
                return;
            }

            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                /* Android 8 以下没有渠道概念，通知本来就会弹横幅 */
                result.put("id", id);
                result.put("importance", 4);
                result.put("created", false);
                result.put("note", "系统版本低于 8，不需要渠道");
                call.resolve(result);
                return;
            }

            NotificationManager manager =
                (NotificationManager) getContext().getSystemService(
                    android.content.Context.NOTIFICATION_SERVICE);

            NotificationChannel existing = manager.getNotificationChannel(id);
            boolean created = existing == null;

            if (created) {
                NotificationChannel channel = new NotificationChannel(
                    id, name, NotificationManager.IMPORTANCE_HIGH);
                channel.setDescription(description);
                channel.enableVibration(true);
                channel.enableLights(true);
                channel.setShowBadge(true);
                manager.createNotificationChannel(channel);
            }

            /* **读回真实级别。**
               不假设"我设了 4 就是 4"——如果这个渠道之前被别处
               （比如推送 SDK）建成别的级别，这里读出来才是真相，
               调用方可以根据它决定要不要换个新名字。 */
            NotificationChannel after = manager.getNotificationChannel(id);
            int importance = after != null ? after.getImportance() : -1;

            result.put("id", id);
            result.put("importance", importance);
            result.put("created", created);
            if (!created) {
                result.put("note", "渠道已存在，重要级别不会被修改（Android 的规则）");
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject("建渠道失败：" + error.getMessage());
        }
    }
}

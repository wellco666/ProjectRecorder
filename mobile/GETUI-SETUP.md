# One-APK multi-vendor Android push setup

The project builds **one APK** with GeTui and adapters for Xiaomi, OPPO, vivo,
Huawei, Honor, Meizu, plus GeTui UPS (which currently supports Smartisan,
Sony, and Hisense devices). The installed SDK selects the available channel
for each device; separate APKs per brand are not required. GeTui documents
the vendor-channel path for background, lock-screen, and killed-process
delivery, but delivery still requires each applicable vendor app/channel to
be registered and enabled. [Official multi-vendor guide](https://docs.getui.com/getui/dos/third_party/)

This is broad coverage, not a promise that literally every Android model will
wake its screen or bypass user force-stop, disabled notifications, network
loss, vendor restrictions, or vendor quotas. Devices without a configured
vendor channel may only receive through GeTui while its client connection is
available. Samsung and other unlisted manufacturers do not have a dedicated
adapter in this project today.

## 1. Create the GeTui app and OEM apps

Create an Android app in the GeTui console using package
`com.cj.projectrecorder`. Copy its AppID, AppKey, and MasterSecret. To cover
the common mainland OEMs, create matching apps in Xiaomi, OPPO, vivo, Huawei,
Honor, and Meizu developer consoles, enable their push products, and register
each vendor's credentials in the GeTui app configuration. Keep the package
name and release signing certificate consistent across those registrations.
UPS covers supported Smartisan, Sony, and Hisense devices without separate
app IDs. Check each vendor's current approval, category, and quota rules in its
console; adding an SDK dependency alone does not activate the channel.

Huawei additionally requires the AppGallery Connect `agconnect-services.json`,
AGC Gradle plugin, and the release signing certificate to be registered. Do
not use an unsigned debug APK to validate Huawei offline delivery. OEM SDK
client identifiers/secrets are packaged as Android manifest configuration;
the GeTui REST MasterSecret is not and must never be placed in the APK.

## 2. Supply Android app identifiers locally

Set the public app identifiers in `C:\Users\<you>\.gradle\gradle.properties`
(or as local environment variables for the build). To enable each common OEM,
fill its pair/ID; do not leave it blank if that OEM must receive pushes while
the app process is asleep. Do not commit this file:

```properties
GETUI_APPID=your_getui_app_id
VIVO_APP_ID=...
VIVO_APP_KEY=...
XIAOMI_APP_ID=...
XIAOMI_APP_KEY=...
OPPO_APP_KEY=...
OPPO_APP_SECRET=...
HUAWEI_APP_ID=...
HONOR_APP_ID=...
MEIZU_APP_ID=...
MEIZU_APP_KEY=...
```

The app asks users before initializing the SDK. Users who decline can still
use the app, but cannot receive GeTui notifications. After changing these
values, rebuild and reinstall the same APK; credentials are embedded into its
manifest placeholders (the REST MasterSecret is not).

## 3. Run the device registration migration

Run `sql/getui-push.sql` in the Supabase SQL Editor after
`sql/migrate-notify.sql`. The authenticated app then registers its CID against
the current profile using RLS; logout removes that association.

## 4. Deploy the server function and secrets

From the `mobile` directory, link the Supabase CLI to the existing project,
then set server-side secrets and deploy:

```sh
supabase secrets set GETUI_APP_ID="..." GETUI_APP_KEY="..." GETUI_MASTER_SECRET="..." TASK_EVENT_WEBHOOK_SECRET="a-long-random-secret"
supabase functions deploy getui-task-event
```

Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Edge
Functions. Keep all of these values in Supabase secrets; never put them in
`sync.js`, an Android resource, or the APK.

## 5. Configure the database webhook

In Supabase Dashboard → Database → Webhooks, create an enabled `INSERT`
webhook on `public.task_events`, method `POST`, URL
`https://<project-ref>.supabase.co/functions/v1/getui-task-event`, with header:

```text
x-webhook-secret: <the same TASK_EVENT_WEBHOOK_SECRET>
```

The function sends `assigned` events to the employee and `done`/`undone`
events to the boss. It uses both the GeTui notification and Android OEM
notification payloads so a killed app does not depend on a transparent/data
message to display the system notification.

## 6. Verify background delivery

Build and install the APK after setting the Android app IDs. Log in, accept the
push disclosure, and check `push_devices` contains the phone's CID and the
current profile ID. Create a task and then complete one from the other account.
Test while the app is foregrounded, while another app is in front, with the
screen locked, and after swiping the app away. Check GeTui/OEM delivery reports
and Android notification permission/channel settings. On each phone, enable
the app's notifications, lock-screen/banner display, autostart, and background
operation/battery allowance where the manufacturer provides those controls.
With the screen off, Android may show a lock-screen notification without
turning the display on; apps cannot reliably force a full-screen wake for
ordinary task messages. Force-stop from Android Settings is a distinct state
and Android may block delivery until the user manually launches the app again.

The foreground keep-alive service and its persistent notification have been
removed as requested. Until the GeTui credentials, Supabase webhook, and OEM
channels are configured and tested, the app can still sync when opened but
cannot promise offline notifications. WebSocket/polling alone cannot wake a
killed app. Android's explicit **Force stop** may still block push delivery
until the app is launched again.

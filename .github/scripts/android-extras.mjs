// Adds MoneyPi's own Android pieces to the project `tauri android init` generates (run after init, before the build):
// the launcher icons and widget resources (src-tauri/android-res), the Kotlin sources (src-tauri/android-src: the
// home-screen widget, a MainActivity that refreshes it and an Application that records crashes), and the widget's
// <receiver> and that Application in AndroidManifest.xml.
// Safe to run more than once.
import { cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../src-tauri/", import.meta.url).pathname;
const app = join(root, "gen/android/app/src/main");
if (!existsSync(app)) { console.error("no generated Android project: run `tauri android init` first"); process.exit(1); }

cpSync(join(root, "android-res"), join(app, "res"), { recursive: true });
const kt = join(app, "java/com/moneypi/app");
for (const f of readdirSync(join(root, "android-src"))) cpSync(join(root, "android-src", f), join(kt, f));

// R8 rules for the release build (the generated build.gradle.kts picks up every *.pro file in the app folder)
cpSync(join(root, "android-proguard/moneypi.pro"), join(app, "../../moneypi.pro"));

const manifestPath = join(app, "AndroidManifest.xml");
let m = readFileSync(manifestPath, "utf8");
if (!m.includes(".NetWorthWidget")) {
  const receiver = `
        <receiver android:name=".NetWorthWidget" android:exported="false" android:label="@string/widget_title">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_networth_info" />
        </receiver>
    </application>`;
  if (!m.includes("</application>")) { console.error("AndroidManifest.xml has no </application>"); process.exit(1); }
  m = m.replace("</application>", receiver.trimStart());
}
// MoneyPiApp records crashes (see android-src/MoneyPiApp.kt)
if (!m.includes('android:name=".MoneyPiApp"')) {
  if (/<application[^>]*android:name=/.test(m)) { console.error("AndroidManifest.xml already names an Application class"); process.exit(1); }
  m = m.replace("<application", '<application\n        android:name=".MoneyPiApp"');
}
writeFileSync(manifestPath, m);
console.log("android extras: res, kotlin, R8 rules, widget receiver, crash recorder ok");

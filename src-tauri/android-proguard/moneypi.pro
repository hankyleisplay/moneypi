# MoneyPi's own R8 rules (copied into gen/android/app by .github/scripts/android-extras.mjs; the generated
# build.gradle.kts applies every *.pro file in that folder to the release build).

# The QR scanner (tauri-plugin-barcode-scanner) uses ML Kit, which creates its component registrars by reflection,
# through their no-argument constructors. firebase-components only ships "-keep class * implements ComponentRegistrar",
# and in R8 full mode that keeps the class but not its constructor: the constructors were removed, ML Kit could not
# start, and the app crashed as soon as a scan began (release builds only).
-keep class * implements com.google.firebase.components.ComponentRegistrar { public <init>(); }
# ML Kit looks up more of its own classes by name (detector creators, the Play services model): keep it whole.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }

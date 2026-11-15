package com.moneypi.app

import android.app.Application
import android.content.Context
import android.os.Build
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.util.Date

// Writes down why the app crashed (moneypi-crash.txt next to the data file), so the next start can show it and the
// user can pass it on. Installed in attachBaseContext: before any library's start-up code can crash.
// Holds only the error and the device model: no money data.
class MoneyPiApp : Application() {
  override fun attachBaseContext(base: Context) {
    super.attachBaseContext(base)
    val file = File(base.dataDir, "moneypi-crash.txt")
    val version = try { base.packageManager.getPackageInfo(base.packageName, 0).versionName } catch (_: Throwable) { "?" }
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      try {
        val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
        file.writeText(
          "MoneyPi $version · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · ${Build.MANUFACTURER} ${Build.MODEL}\n" +
            "${Date()} · thread ${thread.name}\n\n" + trace.take(12000)
        )
      } catch (_: Throwable) {}
      previous?.uncaughtException(thread, error)
    }
  }
}

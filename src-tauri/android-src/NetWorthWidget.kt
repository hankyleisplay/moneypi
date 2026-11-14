package com.moneypi.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File

/**
 * Home-screen widget with the net worth MoneyPi saved last. The app writes moneypi-widget.json next to its data file
 * (only when the widget is turned on in its Settings); this only reads it. Tapping the widget opens the app.
 */
class NetWorthWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val v = views(context)
        for (id in ids) manager.updateAppWidget(id, v)
    }

    companion object {
        /** Redraw every placed widget now (MainActivity calls this when the app goes to the background). */
        fun refreshAll(context: Context) {
            try {
                val manager = AppWidgetManager.getInstance(context) ?: return
                val ids = manager.getAppWidgetIds(ComponentName(context, NetWorthWidget::class.java))
                if (ids.isEmpty()) return
                val v = views(context)
                for (id in ids) manager.updateAppWidget(id, v)
            } catch (e: Exception) {
                // a widget problem must never affect the app
            }
        }

        private fun views(context: Context): RemoteViews {
            val v = RemoteViews(context.packageName, R.layout.widget_networth)
            var net = "—"
            var sub = "到 MoneyPi「設定 → 桌面小工具」開啟"
            var updated = ""
            try {
                val f = File(context.dataDir, "moneypi-widget.json")
                if (f.exists()) {
                    val j = JSONObject(f.readText())
                    if (j.optBoolean("enabled", false)) {
                        net = j.optString("net", "—")
                        sub = j.optString("change", "")
                        updated = j.optString("updated", "")
                    }
                }
            } catch (e: Exception) {
                sub = "暫時讀不到資料，打開 MoneyPi 一次就會更新"
            }
            v.setTextViewText(R.id.w_value, net)
            v.setTextViewText(R.id.w_sub, sub)
            v.setViewVisibility(R.id.w_sub, if (sub.isEmpty()) View.GONE else View.VISIBLE)
            v.setTextViewText(R.id.w_updated, if (updated.isEmpty()) "" else "更新於 $updated")
            val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val pi = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            v.setOnClickPendingIntent(R.id.w_root, pi)
            return v
        }
    }
}

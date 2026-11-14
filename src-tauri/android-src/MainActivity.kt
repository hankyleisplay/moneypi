package com.moneypi.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // leaving the app: let the home-screen widget show what was just saved
  override fun onPause() {
    super.onPause()
    NetWorthWidget.refreshAll(this)
  }
}

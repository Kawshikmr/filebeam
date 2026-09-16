package com.kaapav.filebeam_app

import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.widget.Toast
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "filebeam/download")
            .setMethodCallHandler { call, result ->
                if (call.method == "download") {
                    val url = call.argument<String>("url") ?: run {
                        result.error("NO_URL", "missing url", null); return@setMethodCallHandler
                    }
                    val filename = call.argument<String>("filename").orEmpty()
                    enqueueDownload(url, filename)
                    result.success(true)
                } else {
                    result.notImplemented()
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "filebeam/clipboard")
            .setMethodCallHandler { call, result ->
                if (call.method == "copy") {
                    val text = call.argument<String>("text").orEmpty()
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("FileBeam", text))
                    result.success(true)
                } else {
                    result.notImplemented()
                }
            }
    }

    private fun enqueueDownload(url: String, filename: String) {
        try {
            var name = filename.ifBlank { "filebeam_${System.currentTimeMillis()}" }
            if (!name.contains('.')) name += if (url.contains("/zip")) ".zip" else ".bin"
            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val req = DownloadManager.Request(Uri.parse(url))
            req.setTitle("FileBeam — $name")
            req.setDescription("Downloading via FileBeam")
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            dm.enqueue(req)
        } catch (e: Exception) {
            Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }
}
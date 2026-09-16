package com.kaapav.filebeam_app

import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import android.util.Base64
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream

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
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "filebeam/save")
            .setMethodCallHandler { call, result ->
                if (call.method == "save") {
                    val name = call.argument<String>("name").orEmpty().ifBlank { "file.bin" }
                    val mime = call.argument<String>("mime").orEmpty().ifBlank { "application/octet-stream" }
                    val b64 = call.argument<String>("base64").orEmpty()
                    try {
                        val bytes = Base64.decode(b64, Base64.DEFAULT)
                        saveToDownloads(name, mime, bytes)
                        result.success(true)
                    } catch (e: Exception) {
                        result.error("SAVE_FAILED", e.message, null)
                    }
                } else {
                    result.notImplemented()
                }
            }
    }

    private fun saveToDownloads(name: String, mime: String, bytes: ByteArray) {
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.IS_PENDING, 0)
            }
            val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            val uri = contentResolver.insert(collection, values)
                ?: throw Exception("MediaStore insert failed")
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw Exception("output stream failed")
        } else {
            val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            if (!dir.exists()) dir.mkdirs()
            val target = File(dir, name)
            var unique = target
            var n = 1
            val dot = name.lastIndexOf('.')
            while (unique.exists()) {
                val stem = if (dot > 0) name.substring(0, dot) else name
                val ext = if (dot > 0) name.substring(dot) else ""
                unique = File(dir, "${stem} ($n)$ext"); n++
            }
            FileOutputStream(unique).use { it.write(bytes) }
        }
        Toast.makeText(this, "Saved: $name", Toast.LENGTH_LONG).show()
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
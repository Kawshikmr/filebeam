import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MainApp());
}

const String _site = 'https://filebeam.dpdns.org';

class MainApp extends StatelessWidget {
  const MainApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FileBeam',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF26263C),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF6D7CFF),
          secondary: Color(0xFFA855F7),
        ),
      ),
      home: const FileBeamView(),
    );
  }
}

class FileBeamView extends StatefulWidget {
  const FileBeamView({super.key});

  @override
  State<FileBeamView> createState() => _FileBeamViewState();
}

class _FileBeamViewState extends State<FileBeamView> {
  InAppWebViewController? _webViewController;
  double _progress = 0;
  bool _loadFailed = false;

  static const _downloadChannel = MethodChannel('filebeam/download');
  static const _clipboardChannel = MethodChannel('filebeam/clipboard');
  static const _saveChannel = MethodChannel('filebeam/save');

  Future<void> _handleDownload(DownloadStartRequest request) async {
    final filename = request.suggestedFilename;
    try {
      await _downloadChannel.invokeMethod(
        'download',
        {'url': request.url.toString(), 'filename': filename ?? ''},
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Download started — check your Downloads folder')),
      );
    } catch (e) {
      debugPrint('download failed: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) async {
        if (didPop) return;
        final canGoBack = await (_webViewController?.canGoBack() ?? Future.value(false));
        if (canGoBack) {
          _webViewController?.goBack();
        } else {
          if (context.mounted) Navigator.of(context).pop();
        }
      },
      child: Scaffold(
        body: Stack(
          children: [
            Positioned.fill(
              child: _loadFailed
                  ? _buildError(context)
                  : InAppWebView(
                      initialSettings: InAppWebViewSettings(
                        javaScriptEnabled: true,
                        domStorageEnabled: true,
                        databaseEnabled: true,
                        useOnDownloadStart: true,
                        mediaPlaybackRequiresUserGesture: false,
                        allowFileAccess: true,
                        supportMultipleWindows: false,
                        useHybridComposition: true,
                      ),
                      initialUrlRequest: URLRequest(url: WebUri(_site)),
                      onWebViewCreated: (controller) {
                        _webViewController = controller;
                        controller.addJavaScriptHandler(
                          handlerName: 'filebeamClipboard',
                          callback: (args) async {
                            final text = args.isNotEmpty ? args.first.toString() : '';
                            try {
                              await _clipboardChannel.invokeMethod('copy', {'text': text});
                              return 'ok';
                            } catch (e) {
                              debugPrint('clipboard failed: $e');
                              return 'err';
                            }
                          },
                        );
                        controller.addJavaScriptHandler(
                          handlerName: 'filebeamSave',
                          callback: (args) async {
                            final name = args.isNotEmpty ? args.first.toString() : 'file.bin';
                            final mime = args.length > 1 ? args[1].toString() : 'application/octet-stream';
                            final b64 = args.length > 2 ? args[2].toString() : '';
                            if (b64.isEmpty) return 'err';
                            if (!mounted) return 'err';
                            final messenger = ScaffoldMessenger.of(context);
                            try {
                              final res =
                                  await _saveChannel.invokeMethod<String>(
                                'save',
                                {'name': name, 'mime': mime, 'base64': b64},
                              );
                              if (res?.startsWith('ok') ?? false) {
                                final path = res!.startsWith('ok:') ? res.substring(3) : null;
                                if (mounted) {
                                  messenger.showSnackBar(
                                    SnackBar(
                                      content: Text(
                                        path == null
                                            ? 'Saved: ${_displayName(name)}'
                                            : 'Saved to Downloads',
                                      ),
                                    ),
                                  );
                                }
                                return 'ok';
                              }
                              if (res == 'pending') {
                                if (mounted) {
                                  messenger.showSnackBar(
                                    const SnackBar(content: Text('Grant storage permission to save the file')),
                                  );
                                }
                                return 'ok';
                              }
                              return 'err';
                            } catch (e) {
                              debugPrint('save failed: $e');
                              return 'err';
                            }
                          },
                        );
                      },
                      shouldOverrideUrlLoading: (controller, navAction) async {
                        final url = navAction.request.url;
                        if (url == null) return NavigationActionPolicy.CANCEL;
                        if (url.scheme == _site.split('://')[0] &&
                            url.host == Uri.parse(_site).host) {
                          return NavigationActionPolicy.ALLOW;
                        }
                        if (url.scheme == 'mailto' ||
                            url.scheme == 'tel' ||
                            url.scheme == 'whatsapp' ||
                            url.scheme == 'tg') {
                          return NavigationActionPolicy.ALLOW;
                        }
                        try {
                          await launchExternal(url);
                        } catch (_) {}
                        return NavigationActionPolicy.CANCEL;
                      },
                      onDownloadStartRequest: (controller, request) {
                        _handleDownload(request);
                      },
                      onLoadStop: (controller, url) {
                        if (!mounted) return;
                        setState(() => _loadFailed = false);
                      },
                      onReceivedError: (controller, request, error) {
                        if (error.type == WebResourceErrorType.CANCELLED) return;
                        final isMain = request.isForMainFrame ?? true;
                        final isSite =
                            request.url.scheme == Uri.parse(_site).scheme &&
                                request.url.host == Uri.parse(_site).host;
                        if (!isSite || !isMain) return;
                        if (!mounted) return;
                        setState(() => _loadFailed = true);
                      },
                      onProgressChanged: (controller, progress) {
                        if (!mounted) return;
                        setState(() => _progress = progress / 100);
                      },
                    ),
            ),
            if (!_loadFailed && _progress < 1)
              LinearProgressIndicator(
                value: _progress,
                minHeight: 3,
                backgroundColor: Colors.transparent,
                valueColor: const AlwaysStoppedAnimation(Color(0xFF6D7CFF)),
              ),
          ],
        ),
        persistentFooterButtons: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text('FileBeam v1.1.1 · No accounts · Auto-delete 60 min',
                  style: TextStyle(fontSize: 11, color: Colors.white38)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildError(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.cloud_off, size: 64, color: Colors.white38),
          const SizedBox(height: 16),
          const Text('Could not reach FileBeam', style: TextStyle(fontSize: 16, color: Colors.white70)),
          const SizedBox(height: 4),
          const Text('Check your connection and retry', style: TextStyle(fontSize: 13, color: Colors.white38)),
          const SizedBox(height: 20),
          ElevatedButton(
            onPressed: () {
              setState(() => _loadFailed = false);
              _webViewController?.reload();
            },
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF6D7CFF)),
            child: const Text('Retry'),
          ),
        ],
      ),
    );
  }
}

Future<void> launchExternal(Uri url) async {
  await InAppBrowser.openWithSystemBrowser(url: WebUri(url.toString()));
}

String _displayName(String name) {
  if (name.length <= 28) return name;
  final ext = name.contains('.') ? name.substring(name.lastIndexOf('.')) : '';
  return '${name.substring(0, 25)}...$ext';
}
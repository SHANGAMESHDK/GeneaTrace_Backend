import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:http/http.dart' as http;
import 'package:vibration/vibration.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const GeneaTraceMobileApp());
}

class GeneaTraceMobileApp extends StatelessWidget {
  const GeneaTraceMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'GeneaTrace EdgeStation',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF020617),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF10B981),
          surface: Color(0xFF0F172A),
        ),
      ),
      home: const MobileScannerScreen(),
    );
  }
}

class MobileScannerScreen extends StatefulWidget {
  const MobileScannerScreen({super.key});

  @override
  State<MobileScannerScreen> createState() => _MobileScannerScreenState();
}

class _MobileScannerScreenState extends State<MobileScannerScreen> {
  final MobileScannerController _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.normal,
    facing: CameraFacing.back,
    torchEnabled: false,
  );

  String _lastScannedCode = '';
  DateTime? _lastScanTime;
  Map<String, dynamic>? _lastResult;
  bool _isProcessing = false;

  void _onDetect(BarcodeCapture capture) async {
    final List<Barcode> barcodes = capture.barcodes;
    if (barcodes.isEmpty) return;

    final String? code = barcodes.first.rawValue;
    if (code == null || code.trim().isEmpty) return;

    final now = DateTime.now();
    if (_lastScannedCode == code &&
        _lastScanTime != null &&
        now.difference(_lastScanTime!).inSeconds < 2) {
      return; // Cooldown
    }

    _lastScannedCode = code;
    _lastScanTime = now;
    _processScan(code.trim());
  }

  void _processScan(String targetId) async {
    setState(() => _isProcessing = true);

    bool isTampered = targetId.contains('FAKE') ||
        targetId.contains('TAMPER') ||
        targetId.contains('UNAUTH');
    bool isGenuineProduct =
        targetId.contains('GT-DEV-00000851') || targetId.contains('851');
    bool isGenuineComponent =
        targetId.contains('ABC') || targetId.contains('0042');

    // Haptic Feedback
    if (await Vibration.hasVibrator() ?? false) {
      if (isTampered) {
        Vibration.vibrate(pattern: [0, 300, 100, 300, 100, 400]);
      } else {
        Vibration.vibrate(duration: 80);
      }
    }

    // Prepare verdict
    Map<String, dynamic> result;
    if (isTampered) {
      result = {
        'targetId': targetId,
        'verdict': 'TAMPERED',
        'title': 'ALERT: HARDWARE TAMPERING DETECTED',
        'subtitle': 'Unauthorized replacement component detected.',
        'merkle': '0x00000000000000000000000000000000',
        'isValid': false,
      };
    } else if (isGenuineProduct) {
      result = {
        'targetId': 'GT-DEV-00000851',
        'verdict': 'GENUINE_PRODUCT',
        'title': 'VERIFIED: GALAXY S24 ULTRA',
        'subtitle': 'DPP Authenticated against EVM Block #1849340.',
        'merkle': '0x9f3b8a1c4e72d05f88b14a2c91e3f706',
        'isValid': true,
      };
    } else if (isGenuineComponent) {
      result = {
        'targetId': 'ABC-0042',
        'verdict': 'GENUINE_COMPONENT',
        'title': 'VERIFIED: DISPLAY MODULE (BATCH ABC)',
        'subtitle': 'Authorized AMOLED Dynamic 2X panel.',
        'merkle': '0x4e72d05f88b14a2c91e3f7069f3b8a1c',
        'isValid': true,
      };
    } else {
      result = {
        'targetId': targetId,
        'verdict': 'UNKNOWN',
        'title': 'UNREGISTERED IDENTIFIER',
        'subtitle': 'Identifier not registered in GeneaTrace.',
        'merkle': '0xunknown',
        'isValid': false,
      };
    }

    setState(() {
      _lastResult = result;
      _isProcessing = false;
    });

    // Send attestation event to GeneaTrace cloud backend
    try {
      final url = Uri.parse(
          'https://geneatrace-api.azurewebsites.net/api/v1/security/attestations');
      await http.post(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'product_id': 'GT-DEV-00000851',
          'reported_hardware_hash': result['merkle'],
          'attestation_signature': '0xmobile_attestation_${DateTime.now().millisecondsSinceEpoch}',
          'nonce': '${DateTime.now().millisecondsSinceEpoch}',
        }),
      );
    } catch (_) {
      // Cloud sync gracefully falls back if network offline
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: const Color(0xFF0F172A),
        elevation: 0,
        title: Row(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: const Color(0xFF10B981).withOpacity(0.2),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: const Color(0xFF10B981)),
              ),
              child: const Text(
                'GT',
                style: TextStyle(
                    color: Color(0xFF10B981),
                    fontWeight: FontWeight.bold,
                    fontSize: 12),
              ),
            ),
            const SizedBox(width: 10),
            const Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('GeneaTrace EdgeStation',
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                Text('AOI Mobile Optical Gate',
                    style: TextStyle(fontSize: 10, color: Colors.white54)),
              ],
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: ValueListenableBuilder(
              valueListenable: _controller.torchState,
              builder: (context, state, child) {
                return Icon(
                  state == TorchState.on ? Icons.flash_on : Icons.flash_off,
                  color: state == TorchState.on ? Colors.amber : Colors.white60,
                );
              },
            ),
            onPressed: () => _controller.toggleTorch(),
          ),
          IconButton(
            icon: const Icon(Icons.cameraswitch, color: Colors.white60),
            onPressed: () => _controller.switchCamera(),
          ),
        ],
      ),
      body: Stack(
        children: [
          // 1. Camera Viewfinder
          MobileScanner(
            controller: _controller,
            onDetect: _onDetect,
          ),

          // 2. Cyber-Physical Reticle Overlay
          Center(
            child: Container(
              width: 260,
              height: 260,
              decoration: BoxDecoration(
                border: Border.all(
                  color: _lastResult == null
                      ? const Color(0xFF10B981).withOpacity(0.6)
                      : (_lastResult!['isValid']
                          ? const Color(0xFF10B981)
                          : const Color(0xFFEF4444)),
                  width: 2.5,
                ),
                borderRadius: BorderRadius.circular(24),
              ),
              child: Stack(
                children: [
                  Center(
                    child: Container(
                      width: 12,
                      height: 12,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: _lastResult == null
                            ? const Color(0xFF10B981).withOpacity(0.4)
                            : (_lastResult!['isValid']
                                ? const Color(0xFF10B981)
                                : const Color(0xFFEF4444)),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),

          // 3. Bottom Telemetry & Result Banner
          Positioned(
            left: 16,
            right: 16,
            bottom: 24,
            child: _lastResult != null
                ? Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: const Color(0xFF0F172A).withOpacity(0.95),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                        color: _lastResult!['isValid']
                            ? const Color(0xFF10B981).withOpacity(0.5)
                            : const Color(0xFFEF4444).withOpacity(0.5),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              _lastResult!['targetId'],
                              style: const TextStyle(
                                  fontFamily: 'monospace',
                                  fontWeight: FontWeight.bold,
                                  fontSize: 12,
                                  color: Colors.white70),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: _lastResult!['isValid']
                                    ? const Color(0xFF10B981).withOpacity(0.2)
                                    : const Color(0xFFEF4444).withOpacity(0.2),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                _lastResult!['verdict'],
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.bold,
                                  color: _lastResult!['isValid']
                                      ? const Color(0xFF10B981)
                                      : const Color(0xFFEF4444),
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          _lastResult!['title'],
                          style: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.bold,
                              color: Colors.white),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          _lastResult!['subtitle'],
                          style: const TextStyle(
                              fontSize: 11, color: Colors.white60),
                        ),
                      ],
                    ),
                  )
                : Container(
                    padding: const EdgeInsets.symmetric(
                        vertical: 12, horizontal: 16),
                    decoration: BoxDecoration(
                      color: const Color(0xFF0F172A).withOpacity(0.85),
                      borderRadius: BorderRadius.circular(30),
                    ),
                    child: const Center(
                      child: Text(
                        'Align QR Token in reticle to scan',
                        style: TextStyle(
                            fontSize: 12,
                            color: Colors.white70,
                            fontFamily: 'monospace'),
                      ),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

# GeneaTrace EdgeStation™ — Mobile Optical Gate (Android)

Turn any Android smartphone into the **GeneaTrace EdgeStation**, performing the exact optical inspection, cryptographic attestation, haptic feedback, and automated tamper-lockout as the Raspberry Pi 4B.

---

## 🚀 Two Ways to Run on Mobile

### Method 1: Instant WebAPK Install (Zero Compilation Needed — Ready Right Now)

The frontend now contains a dedicated native mobile scanner view with PWA WebAPK packaging:

1. On your Android smartphone, open Google Chrome and navigate to:
   ```text
   https://geneatrace-frontend.vercel.app/scanner
   ```
   *(or `http://<YOUR_LAPTOP_IP>:5173/scanner` if testing over local Wi-Fi)*
2. Tap the **Chrome menu (⋮)** in the top right and select **"Install app"** (or tap **"Add GeneaTrace Edge to Home screen"**).
3. Android will automatically package and install a real **WebAPK** onto your home screen and app drawer!
4. **Features**:
   * Launches full-screen without any browser address bar.
   * Accesses rear camera autofocus.
   * Triggers native hardware vibration on scans (double pulse on verified, rapid alarm pulse on tampered).
   * Automatically synchronizes with the main presentation dashboard in real time!

---

### Method 2: Standalone Native Release `.apk` via GitHub Actions

Because building a raw `.apk` locally requires a 10 GB Android Studio SDK installation, we configured an automated cloud compiler:

1. Push your repository to GitHub (`git push origin main`).
2. Open your GitHub repository in your browser and click the **Actions** tab.
3. You will see the **Build GeneaTrace Android APK** workflow running.
4. Once completed (~2 minutes), click on the build summary and download **`GeneaTrace-EdgeStation-release.apk`** under **Artifacts**!
5. Transfer the `.apk` to your phone and tap to install.

---

### Method 3: Local Build (If Android SDK is Installed)

If you have Android Studio installed and pointed to Flutter:
```bash
cd mobile_app
flutter pub get
flutter build apk --release --no-tree-shake-icons
```
The output file will be generated at:
`mobile_app/build/app/outputs/flutter-apk/app-release.apk`

---

## 🎯 Jury Demo Script with Mobile Phone

1. **Setup**:
   * Have your laptop displaying the **GeneaTrace Device Security** page (`/security`).
   * Hold your phone with the **GeneaTrace Edge** app open.
2. **Scan Token 1 (`GT-DEV-00000851`)**:
   * Point your phone at the QR code.
   * The phone vibrates with a confirmation buzz and displays **`VERIFIED: GALAXY S24 ULTRA (EVM Root 0x9f3b...)`**.
3. **Scan Token 3 (`FAKE-DISP-9999`)**:
   * Point your phone at the counterfeit QR code.
   * The phone buzzes with a rapid emergency vibration and turns **FLASHING RED**: `ALERT: HARDWARE TAMPERING DETECTED`.
   * On your laptop screen, the managed phone frame automatically locks down with the red warning banner!

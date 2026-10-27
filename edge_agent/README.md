# GeneaTrace EdgeStation™: Cyber-Physical Hardware Gate & Optical Attestation Unit

**Hardware Stack:**
* **Raspberry Pi 4B** (Edge compute gateway running Linux)
* **USB Camera** (Automated Optical Inspection - AOI sensor)
* **CP2102 USB-to-UART Bridge** (Industrial serial bus & relay actuator simulator)

---

## 1. System Architecture

```
  [Physical QR Token]
          │
          ▼
   ┌──────────────┐          USB          ┌───────────────────────────┐
   │  USB Camera  │ ────────────────────► │     Raspberry Pi 4B       │
   └──────────────┘                       │   (geneatrace_edge_agent) │
                                          └─────────────┬─────────────┘
                                                        │
                      ┌─────────────────────────────────┴─────────────────────────────────┐
                      │                                                                   │
                      ▼ USB/UART                                                          ▼ HTTP / WiFi
       ┌───────────────────────────────┐                                   ┌─────────────────────────────┐
       │     CP2102 Serial Bridge      │                                   │     GeneaTrace Web UI       │
       │  (Blinks TX/RX Hardware LEDs, │                                   │  (Live DPP & Device Security│
       │   transmits industrial packet)│                                   │   Screen Auto-Locks)        │
       └───────────────────────────────┘                                   └─────────────────────────────┘
```

---

## 2. Hardware Connections

1. **USB Camera**: Plug into any **USB 3.0 (blue) port** on the Raspberry Pi 4B.
2. **CP2102**:
   * **Option A (Connected to Pi)**: Plug the CP2102 into the second USB port on the Raspberry Pi 4B (`/dev/ttyUSB0`). The agent will pulse industrial serial packets to the CP2102, making its onboard TX and RX LEDs blink on every scan!
   * **Option B (Connected to Demo Laptop)**: Plug the CP2102 into your presentation laptop. In the GeneaTrace web dashboard under **Device Security**, click **"Connect CP2102"** to stream telemetry via Web Serial API.

---

## 3. Quick Start (Raspberry Pi 4B)

### Step 1: Install Dependencies on the Pi
Open a terminal on your Raspberry Pi and run:
```bash
sudo apt-get update
sudo apt-get install -y python3-opencv python3-pip
pip3 install pyserial requests
```

### Step 2: Copy the Edge Agent
Copy the `edge_agent/` folder to your Pi (or clone the repository).

### Step 3: Run the Edge Agent
```bash
cd edge_agent
python3 geneatrace_edge_agent.py
```
* The OpenCV optical window will open displaying the HUD reticle.
* The local sync server will start at `http://<PI_IP>:8765`.

> **Note**: You can also run this script directly on your Windows/Mac laptop to test immediately with your USB Camera and CP2102!
> ```bash
> python geneatrace_edge_agent.py
> ```

---

## 4. The 3 Demo QR Tokens

Open `qr_demo_sheet.html` in any browser (or print it out) to present these tokens to the camera:

| Token Name | Identifier | Expected Visual HUD | Expected Hardware / Web Reaction |
| :--- | :--- | :--- | :--- |
| **1. Genuine Flagship** | `GT-DEV-00000851` | **High-Visibility GREEN** Reticle | CP2102 blinks green; Web UI displays 100% Verified DPP & Enclave Security |
| **2. Genuine Component** | `ABC-0042` | **CYAN / BLUE** Reticle | Identifies Display Module Batch ABC; links to Assembly Cell 3 |
| **3. Counterfeit Part** | `FAKE-DISP-9999` | **FLASHING RED** Reticle | CP2102 outputs emergency lockout packet; **Web UI triggers immediate Device Lock Screen!** |

---

## 5. The 2-Minute Jury Presentation Walkthrough

1. **Intro (15s)**:
   > *"Jury members, real supply chain security cannot exist only in software. We built the **GeneaTrace EdgeStation**, an industrial cyber-physical gate running on this Raspberry Pi 4B with automated computer vision and an industrial serial bus."*

2. **Genuine Scan (30s)**:
   > *(Hold Token 1 in front of the camera)*  
   > *"Notice how the optical gate detects the Galaxy S24 Ultra in under 12 milliseconds, pulses the hardware bus, and immediately verifies the cryptographic Merkle Root on the digital passport."*

3. **Tamper & Counterfeit Attack (45s)**:
   > *(Hold Token 3 in front of the camera)*  
   > *"Now, watch what happens when an unauthorized repair shop or malicious actor attempts to install a cloned, counterfeit screen. The camera locks on, detects the root mismatch, and the CP2102 signals an emergency lock. Look at the screen: GeneaTrace automatically executes an MDM cryptographic lock down on the device."*

4. **Conclusion (15s)**:
   > *"From physical silicon and camera inspection on the Raspberry Pi all the way to cloud Merkle trees and EVM blockchain checkpoints, GeneaTrace closes the loop on supply chain trust."*

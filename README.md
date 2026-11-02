# GeneaTrace – a product passport for everything

GeneaTrace gives every physical unit (a vial of antibiotic, a smartphone, a display panel) a **signed digital passport** on a **tamper-evident ledger** stored in **Supabase Postgres**. Every manufacture, entry, exit, sale, repair, recall and warranty decision is a signed transaction sealed into a hash-linked block.

It is built around two real failure modes:

| Problem | What GeneaTrace does |
| --- | --- |
| **Counterfeit / relabelled antibiotics** reaching hospitals from an unlicensed site, with fake batch data and non-working QR codes | Ed25519-signed QR on every unit · random unguessable IDs · custody only moves via EXIT → ENTRY between registered parties · entry into an unlicensed site auto-flags units · unminted IDs rejected at intake · relabelling by non-manufacturers blocked · cold-chain, expiry and recall enforced at the point of sale · counterfeit-scan hotspot map |
| **AMOLED "green line" defects**, sometimes after an update, with opaque free-replacement rules | Unit → component-lot genealogy · defect clustering by lot (compared against alternative lots of the same part) and by firmware · replacement programs with public, machine-checked eligibility (lot, defect, damage, one-time) · service and damage history that cannot be rewritten |

## The workflow (phone example: Nova A55, batch AAA)

| # | Step | Who / where | Ledger events |
| --- | --- | --- | --- |
| 1–3 | Assign batch `AAA`; issue cryptographic serials (`AAA` + 8 random digits). Each starts as an **empty container** | Manufacturer → Batches → New batch (batch code + process route) | `BATCH_CREATED`, `SERIAL_ISSUED` (status *in production*) |
| 4–6 | At every process the unit is scanned; **timestamp, machine ID, process** (and any installed part serial) are pushed into the serial. Out-of-order steps, unqualified machines and unregistered parts are rejected | `/scanner` (Process scanner) | `PROCESS_STEP`, `INSTALLED` (part), `PRODUCTION_COMPLETE` |
| 7 | Packing → warehouse → dispatched → delivered | Manufacturer → Logistics gate | `PACKED`, `STORED`, `EXIT`, `CHECKPOINT`, `DELIVERED` |
| 8 | Retailer takes over | Retail desk → Incoming deliveries | `ENTRY` |
| 9 | Sale with customer details. Details stay **off-chain**; only a salted reference goes on the ledger | Retail desk → Sell | `SOLD` |
| 10 | Customer returns the product; retailer opens a case on the serial | Retail desk → Customer return | `ISSUE_REPORTED` (case created) |
| 11 | Retailer sends the unit to the manufacturer | Service & recalls | `EXIT` → `ENTRY` |
| 12 | Manufacturer **backtraces**: the unit's process history, the same issue elsewhere in the batch, and which process + machine the affected units share | Service & recalls / product page → Backtrace | `DIAGNOSED` (+ automatic `PROCESS_FAULT` alert) |
| 13 | Recall: a **precision recall** of only the units that went through the faulty machine (or the whole batch). Retailers get a recall notice per customer unit | Backtrace → Recall these units | `RECALL`, `BATCH_RECALLED` + recall cases |
| 14 | Repair (or replace) and send back to the **same retailer** | Service & recalls | `SERVICE` (remedy), `EXIT` / `REPLACEMENT_ASSIGNED` |
| 15 | Retailer receives it and hands it to the customer | Service & recalls | `ENTRY`, `HANDED_OVER` (case closed) |
| 🔒 | A third-party centre fits a **fake part**: on its next internet connection the device sends an HMAC-signed parts report; unknown serials **lock** the device on-chain. Only an authorised centre installing a genuine part can unlock it | Product page → Device check-in (simulator); devices call `POST /api/public/device/attest` | `LOCK`, `SERVICE`, `UNLOCK` |

The same flow runs for **medicine** (batch `MRC`, 7-step sterile route with autoclaves AC-01/AC-02, pharmacy dispenses with patient details, an adverse reaction is backtraced to AC-02, AC-02 vials are recalled, and the patient gets a **replacement vial** instead of a repair). Other industries (food, apparel, automotive, cosmetics) get process-route presets on the New batch form.

## Folder structure

```
geneatrace-platform/
├─ frontend/                 React 18 + Vite + Tailwind (the web app, port 5173)
│  ├─ src/pages/             Landing, Verify, Scan, Login, ScannerStation (/scanner)
│  ├─ src/pages/app/         Dashboard, Passports, Batches, Logistics gate, Retail desk, Service & recalls, …
│  ├─ src/components/        UI kit, passport tabs, backtrace, event composer, QR scanner
│  └─ .env.example           VITE_API_URL (empty in dev: Vite proxies /api to the backend)
├─ backend/                  Next.js 14 (App Router) API node (port 8080)
│  ├─ app/api/[[...path]]/   one route handler for the whole REST API
│  ├─ app/page.js            node status page
│  ├─ lib/chain/             blocks, PoW, Merkle roots, Ed25519 signatures, verification, Ethereum anchoring
│  ├─ lib/services/          custody state machine, production, passports, tickets, device lock, analytics
│  ├─ lib/routes/            public (no key) and authenticated endpoints
│  ├─ lib/db/                Supabase Postgres store + local JSON store
│  ├─ scripts/               seed.js, reset.js
│  ├─ test/                  ledger and end-to-end workflow tests
│  ├─ supabase/migrations/   schema (applied automatically on start)
│  └─ .env.example
├─ blockchain/               Ethereum: Solidity anchor contract + Hardhat (local chain, tests, deploy)
│  ├─ contracts/GeneaTraceAnchor.sol
│  ├─ scripts/deploy.js      deploys and writes the address + ABI into the backend
│  └─ test/
└─ package.json              convenience scripts for all three
```

The frontend calls the backend over HTTP only (`/api/...`), so the two can be deployed separately. The backend writes to Ethereum through the anchor contract; the frontend never needs a wallet.

## Ethereum anchoring

Supabase holds the full ledger (every signed event, block and Merkle root). Ethereum holds its fingerprint: after each block is sealed, the backend writes that block's SHA-256 hash to the `GeneaTraceAnchor` smart contract, strictly in height order and in batches of up to 50 blocks per transaction.

- The contract is **append-only**: anchors can only be added in sequence; there is no function to change or delete one, and only the node wallet (contract owner) can write.
- A block hash commits to its Merkle root, its previous block and every event inside it, so once a block is anchored, rewriting any record in Supabase (even by someone holding the database password and `LEDGER_SECRET`) is provable against Ethereum.
- `GET /api/chain/verify` compares every block with its on-chain anchor; every passport checks the blocks holding its events; every Merkle proof shows the Ethereum transaction that anchored its block.
- No product, customer or business data goes on-chain: only 32-byte hashes, plus each block's Merkle root and event count in the contract's event log.
- Writing every scan straight to Ethereum would cost gas per event and seconds per confirmation; anchoring gives the same tamper evidence for one transaction per batch of blocks.

**Ledger design**
- Each event is a transaction `{type, product_id, batch_id, actor_id, facility_id, data, prev_tx, salt, ts}` hashed with SHA-256 over canonical JSON and **signed with the actor's Ed25519 key**.
- Each product has its own hash chain (`prev_tx`), so one unit's history cannot be reordered or have steps removed.
- Transactions are sealed into blocks with a **Merkle root**, `prev_hash` link, light **proof-of-work** and a **validator signature** (proof-of-authority node key).
- Keys are derived from `LEDGER_SECRET`; private keys never touch the database. Actor public keys are registered **on-chain** (`ACTOR_REGISTERED`), so swapping a key in the DB is detected.
- `blocks`, `events` and `scans` are **append-only at the database level** (triggers reject UPDATE/DELETE/TRUNCATE). Anyone who disables the triggers is still caught by `GET /api/chain/verify`, which recomputes every hash, signature, link and Merkle root.
- The `products` table is a cache of current state. Every passport view **replays the ledger** and flags any drift.

## Run it

Requires Node 20+.

```bash
npm run setup                                # installs backend, frontend and blockchain
cp backend/.env.example backend/.env         # set DATABASE_URL (Supabase) and LEDGER_SECRET
npm run chain:node                           # terminal 1: local Ethereum chain on :8545 (Hardhat)
npm run chain:deploy                         # deploys GeneaTraceAnchor and fills ETH_* in backend/.env
npm run seed                                 # demo network + both scenarios, then anchors every block
npm run dev:backend                          # terminal 2: Next.js API on :8080 (anchors new blocks every few seconds)
npm run dev:frontend                         # terminal 3: React app on :5173
```

Open http://localhost:5173 → **Partner sign in** → pick a demo account. Leave `DATABASE_URL` empty to run on a local JSON file instead of Supabase; leave the `ETH_*` values empty to run without Ethereum.

The local Hardhat chain lives in memory: after restarting it, run `npm run chain:deploy` again (it lands on the same address) and the backend re-anchors the whole ledger from block 0.

**Sepolia testnet:** in `blockchain/.env` set `SEPOLIA_RPC_URL` and `DEPLOYER_PRIVATE_KEY` (a wallet funded with Sepolia test ETH), run `npm --prefix blockchain run deploy:sepolia`, then put the same RPC URL and private key into `backend/.env` as `ETH_RPC_URL` / `ETH_PRIVATE_KEY` (the deploy fills in `ETH_CONTRACT_ADDRESS`). Transactions then link to sepolia.etherscan.io.

Production:
- Backend: `npm --prefix backend run build && npm --prefix backend start` (port 8080). Set `DEMO_MODE=false`, a strong `ADMIN_API_KEY`, a random `LEDGER_SECRET` (never rotate it once the chain has data), `PUBLIC_APP_URL` (the frontend's address, encoded into QR labels) and `CORS_ORIGINS` (the frontend's origin).
- Frontend: set `VITE_API_URL` to the backend's address, then `npm --prefix frontend run build` and host `frontend/dist` on any static host (with SPA fallback to `index.html`).

```bash
npm test                                     # contract tests + ledger, custody, fraud, tamper, workflow and Ethereum tests
npm --prefix backend run reset -- --yes      # drops only the geneatrace schema / local file (then redeploy the contract)
```

## Things to try in the demo

1. **Consumer verify**: Passports → open any unit → *Public passport*; or scan a printed label (Batches → Print labels) with `/scan`.
2. **Logistics gate**: sign in as *Sanjeevani Pharma*, dispatch units to *MedLink*; sign in as *City General Hospital* and try to receive them (custody breach alert); then receive as *MedLink*.
3. **Regulator**: Alerts shows the unlicensed Bidadi godown, the blocked relabelling, the 6 counterfeit IDs, the cold-chain excursion and the counterfeit hotspots on the dashboard map.
4. **Defects & warranty**: sign in as *Nova Mobile*. Green-line reports concentrate in panel lot A7 (7× other display lots, all after the OTA). The replacement program approves 6 claims and rejects 1 for liquid damage.
5. **Ledger explorer**: *Verify entire chain*. As admin, open any transaction → *Tamper demo*: Supabase refuses the edit (on the local store the edit goes through and verification pinpoints it).

## API (summary)

Public (no key): `POST /api/public/scan`, `GET /api/public/passport/:id`, `GET /api/public/proof/:txId`, `POST /api/public/report`, `GET /api/public/node`, `GET /api/public/health`.

Authenticated (`x-api-key`): `GET /api/me` · `GET|POST /api/actors` · `GET|POST /api/facilities`, `PATCH /api/facilities/:id/license` · `GET|POST /api/batches`, `GET /api/batches/:id`, `POST /api/batches/:id/mint` · `GET /api/products`, `GET /api/products/:id` · `POST /api/events` (`EXIT`, `ENTRY`, `CHECKPOINT`, `QUALITY_CHECK`, `SOLD`, `FIRMWARE_UPDATE`, `SERVICE`, `DEFECT_REPORTED`, `WARRANTY_CLAIM`, `RECALL`, `FLAG`, `CLEAR`, `REPACKAGE`, `DISPOSE`) · `GET /api/events` · `GET /api/chain/blocks`, `/blocks/:h`, `/tx/:id`, `/verify` · `GET /api/alerts`, `PATCH /api/alerts/:id/resolve` · `GET|POST /api/programs` · `GET /api/analytics/overview`, `/analytics/defects`.

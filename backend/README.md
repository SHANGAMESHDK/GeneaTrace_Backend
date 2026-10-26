# GeneaTrace Backend Engineering & Production Deployment Guide

**GeneaTrace: Blockchain-Linked Digital Product Passport for Manufacturing Lineage, Batch Traceability, Device Identity, and Precision Recalls**

---

## 1. System Architecture

```
                    React / Vite Frontend
                              |
                              v
                  FastAPI REST API (Port 8000)
                              |
     +------------------------+-------------------------+
     |                        |                         |
     v                        v                         v
Supabase PostgreSQL         Neo4j Graph Database    EVM Blockchain (Hardhat / Testnet)
(Transactional Authority)  (Lineage Traversal DAG) (Merkle Checkpoints & Commitments)
     |                        |
     +-- Merkle-DAG Engine ---+
         (SHA-256 Hashing)
```

- **PostgreSQL / Supabase:** Authoritative transactional records for users, suppliers, facilities, batches, components, assembly relationships, shipments, recalls, and device commands.
- **Neo4j Graph Database:** High-speed forward and backward lineage traversals. *(Includes a transparent PostgreSQL recursive-query fallback that guarantees sub-100-ms responses even when Neo4j is offline)*.
- **Merkle-DAG Integrity Engine:** Deterministic canonical JSON serialization and SHA-256 event hashing linking predecessor operations.
- **Blockchain Adapter (`GeneaTraceRegistry.sol`):** Anchors Merkle-root checkpoints and identity commitments without storing sensitive PII, raw IMEIs, or machine telemetry on-chain.
- **Device Security & Controlled MDM Lock:** Attestation verification, IMEI mismatch investigation, signed revocable lock commands with replay-protection nonces and recovery.

---

## 2. API Endpoints Directory

All API routes are prefixed under `/api/v1` with full OpenAPI Swagger documentation available at `/docs`:

| Module | Method & Path | Description | Required Role / Permission |
| :--- | :--- | :--- | :--- |
| **System** | `GET /health` | Liveness health check | Public |
| **System** | `GET /ready` | Readiness check (PG, Neo4j, Blockchain) | Public |
| **Auth** | `POST /api/v1/auth/login` | Authenticate with credentials | Public |
| **Auth** | `GET /api/v1/auth/me` | Current authenticated user profile | Authenticated |
| **Batches** | `POST /api/v1/batches` | Register batch & atomically allocate serials | `MANUFACTURER`, `ADMIN` |
| **Batches** | `GET /api/v1/batches` | Paginated batches list | Authenticated |
| **Batches** | `GET /api/v1/batches/{code}` | Batch details and planned vs actual | Authenticated |
| **Batches** | `GET /api/v1/batches/{code}/serials` | Paginated serial numbers list | Authenticated |
| **Batches** | `GET /api/v1/batches/{code}/events` | Chronological manufacturing events | Authenticated |
| **Batches** | `GET /api/v1/batches/{code}/recall-impact` | Lineage-derived recall exposure | Authenticated |
| **Components**| `GET /api/v1/components` | Paginated component registry | Authenticated |
| **Components**| `GET /api/v1/components/{serial}` | Component status and quality | Authenticated |
| **Components**| `GET /api/v1/components/{serial}/events` | Component manufacturing events | Authenticated |
| **Manufacturing**| `POST /api/v1/manufacturing/events` | Ingest single event with Merkle hash | `MANUFACTURER`, `INSPECTOR` |
| **Manufacturing**| `POST /api/v1/manufacturing/events/bulk`| Ingest bulk event batch | `MANUFACTURER` |
| **Manufacturing**| `GET /api/v1/manufacturing/events/{id}` | Inspect event and canonical hash | Authenticated |
| **Assembly** | `POST /api/v1/assembly` | Assemble phone (`GT-DEV-00000851`) | `MANUFACTURER` |
| **Assembly** | `POST /api/v1/assembly/{id}/replace-component` | Replace component preserving history | `MANUFACTURER` |
| **Products** | `GET /api/v1/products` | List assembled smartphones | Authenticated |
| **Products** | `GET /api/v1/products/{id}` | Smartphone assembly bill of materials | Authenticated |
| **Passports**| `GET /api/v1/passports/{id}` | Full internal Digital Product Passport | Authenticated |
| **Passports**| `GET /api/v1/passports/{id}/public` | Privacy-preserving public passport | Public |
| **Passports**| `GET /api/v1/passports/{id}/verify` | Cryptographic passport verification | Public |
| **Traceability**| `POST /api/v1/traceability/query` | Forward / backward graph query | Authenticated |
| **Traceability**| `GET /api/v1/traceability/product/{id}`| Backward product genealogy | Authenticated |
| **Traceability**| `GET /api/v1/traceability/batch/{code}` | Forward batch distribution graph | Authenticated |
| **Recalls** | `POST /api/v1/recalls` | Initiate recall on affected batch | `RECALL_MANAGER` |
| **Recalls** | `GET /api/v1/recalls/{id}/impact` | Deduplicated affected product counts | `RECALL_MANAGER` |
| **Recalls** | `POST /api/v1/recalls/{id}/confirm` | Confirm recall & mark defective | `RECALL_MANAGER` |
| **Recalls** | `GET /api/v1/recalls/{id}/export` | Download CSV impact report | `RECALL_MANAGER` |
| **Logistics** | `POST /api/v1/shipments` | Create logistics shipment | `LOGISTICS_OPERATOR` |
| **Logistics** | `POST /api/v1/shipments/{id}/events` | Record append-only custody event | `LOGISTICS_OPERATOR` |
| **Blockchain**| `POST /api/v1/blockchain/checkpoints` | Anchor Merkle-root on blockchain | `MANUFACTURER`, `ADMIN` |
| **Blockchain**| `POST /api/v1/blockchain/verify` | Verify Merkle root on blockchain | Public |
| **Blockchain**| `GET /api/v1/blockchain/audit` | Checkpoint audit statistics | `AUDITOR`, `ADMIN` |
| **Security** | `POST /api/v1/security/attestations` | Ingest device hardware attestation | Public / Device Agent |
| **Security** | `POST /api/v1/security/devices/{id}/evaluate` | Policy check on IMEI mismatch | `SECURITY_OFFICER` |
| **Security** | `POST /api/v1/security/commands` | Issue signed revocable lock command | `SECURITY_OFFICER` |
| **Security** | `POST /api/v1/security/commands/{id}/execution-report` | MDM execution callback | MDM Agent |
| **Security** | `POST /api/v1/security/devices/{id}/recovery` | Authorized officer recovery | `SECURITY_OFFICER` |
| **Dashboard** | `GET /api/v1/dashboard/summary` | Top-level KPIs and health | Authenticated |
| **Dashboard** | `GET /api/v1/dashboard/manufacturing-output` | Output metrics by component type | Authenticated |
| **Dashboard** | `GET /api/v1/dashboard/defect-rates` | Live defect rates by category | Authenticated |
| **Dashboard** | `GET /api/v1/dashboard/recall-exposure` | Current recall risk exposure | Authenticated |

---

## 3. Local Development Setup

### A. Python Environment
```bash
# Create virtual environment
python -m venv .venv

# Activate on Windows
.venv\Scripts\activate
# Activate on Linux/macOS
source .venv/bin/activate

# Install dependencies
pip install -r backend/requirements.txt
```

### B. Run Automated Test Suite
```bash
pytest backend/tests -v
```

### C. Seed Demonstration Dataset
```bash
python -m backend.app.db.seed
```
This populates:
- Display Batch `ABC` (100 units: `ABC-0001` through `ABC-0100`)
- Battery Batch `BTR`, PCB `PCB`, Camera `CAM`, Speaker `SPK`, Frame `FRM` (100 units each)
- Flagship Smartphone `GT-DEV-00000851` assembled with `ABC-0042`, `BTR-0018`, `PCB-0073`, `CAM-0034`, `SPK-0012`, `FRM-0048`
- 160 Chronological manufacturing events with Merkle-DAG hashes
- Active recall investigation scenario for Display Batch `ABC`

**Demonstration Credentials:**
- Admin: `admin` / `DevPassword123!`
- Manufacturer: `manufacturer` / `DevPassword123!`
- Quality Inspector: `inspector` / `DevPassword123!`
- Recall Manager: `recall_mgr` / `DevPassword123!`
- Security Officer: `security_officer` / `DevPassword123!`

### D. Start Local Server
```bash
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload
```
Navigate to `http://localhost:8000/docs` to test endpoints interactively.

---

## 4. Production Deployment: Microsoft Azure App Service

### A. Azure App Service Requirements
- **Runtime Stack:** Python 3.12 or 3.13 (Linux)
- **Startup Command:**
  ```bash
  uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 2
  ```
- **Port:** Azure App Service dynamically assigns a port via the `PORT` environment variable. The backend automatically binds to `${PORT:-8000}`.

### B. Deployment via Azure CLI (`az webapp`)
```bash
# 1. Log in to Azure
az login

# 2. Create a Resource Group
az group create --name rg-geneatrace-prod --location eastus

# 3. Create an App Service Plan (Linux)
az appservice plan create \
  --name plan-geneatrace-linux \
  --resource-group rg-geneatrace-prod \
  --sku B1 \
  --is-linux

# 4. Create the Web App
az webapp create \
  --name geneatrace-api-prod \
  --resource-group rg-geneatrace-prod \
  --plan plan-geneatrace-linux \
  --runtime "PYTHON:3.12"

# 5. Configure Startup Command
az webapp config set \
  --resource-group rg-geneatrace-prod \
  --name geneatrace-api-prod \
  --startup-file "uvicorn backend.app.main:app --host 0.0.0.0 --port \${PORT:-8000} --workers 2"

# 6. Configure Environment Variables
az webapp config appsettings set \
  --resource-group rg-geneatrace-prod \
  --name geneatrace-api-prod \
  --settings \
    APP_ENV="production" \
    DATABASE_URL="postgresql://postgres.YOUR_PROJECT:YOUR_PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require" \
    JWT_SECRET_KEY="YOUR_GENERATED_32BYTE_SECRET_KEY" \
    NEO4J_ENABLED="false" \
    BLOCKCHAIN_ENABLED="false" \
    CORS_ORIGINS='["https://geneatrace.azureedge.net","https://your-frontend.com"]' \
    LOG_LEVEL="INFO"

# 7. Deploy Source Code (Zip / Git)
az webapp deploy \
  --resource-group rg-geneatrace-prod \
  --name geneatrace-api-prod \
  --src-path . \
  --type zip

# 8. Verify Health
curl https://geneatrace-api-prod.azurewebsites.net/health
curl https://geneatrace-api-prod.azurewebsites.net/ready
```

---

## 5. Supabase Managed PostgreSQL Integration

### A. Connection Pooling Setup
Supabase provides two connection types:
1. **Direct Connection (Port 5432):** Best for environments with direct IPv6 routing.
2. **Transaction Pooler (Port 6543 via PgBouncer):** Recommended for Azure App Service to prevent connection pool exhaustion across multiple workers.

In `backend/app/db/postgres.py`, the engine automatically detects `:6543` or `pooler` in the connection string and uses SQLAlchemy's `NullPool` to avoid double pooling on top of PgBouncer.

### B. Applying Alembic Migrations
Run migrations as a controlled step prior to switching traffic:
```bash
# Set production DATABASE_URL
export DATABASE_URL="postgresql://postgres.YOUR_PROJECT:YOUR_PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require"

# Apply all migrations
alembic -c backend/alembic.ini upgrade head
```

---

## 6. Blockchain Layer (`GeneaTraceRegistry.sol`)

### A. Smart Contract Capabilities
- Register authorized issuers
- Register cryptographic identity commitments (prevents duplicate registrations)
- Record authenticated Merkle-root checkpoints
- Record revocations with timestamps
- Emits audit events (`CheckpointRecorded`, `IdentityCommitmentRegistered`)

### B. Contract Compilation & Testing (Hardhat)
```bash
cd contracts
npm install
npm test
```

### C. Deploying to Local Hardhat Node
```bash
# In terminal 1:
npx hardhat node

# In terminal 2:
npx hardhat run scripts/deploy.ts --network localhost
```
Copy the deployed contract address into your `.env` or Azure App Settings as `BLOCKCHAIN_CONTRACT_ADDRESS`.

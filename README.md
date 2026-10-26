# GeneaTrace Backend

Blockchain-Linked Digital Product Passport for Manufacturing Lineage, Batch Traceability, Device Identity, and Precision Recalls.

## Key Subsystems
- **API Backend (`backend/`):** FastAPI + Pydantic v2 + SQLAlchemy 2.x + Alembic + Merkle-DAG Engine
- **Database Persistence:** PostgreSQL / Supabase Managed Database + Neo4j Lineage Graph (with transparent PostgreSQL recursive CTE fallback)
- **Smart Contracts (`contracts/`):** Solidity `GeneaTraceRegistry.sol` for EVM Merkle root and commitment anchoring
- **Cloud Readiness:** Production-ready for Microsoft Azure App Service (Linux, Python) + Supabase + GitHub Actions CI/CD

## Quick Start
```bash
# 1. Install dependencies
pip install -r backend/requirements.txt

# 2. Run automated tests (11 passing unit, integration, security, and benchmark tests)
pytest backend/tests -v

# 3. Seed demonstration dataset (Batches ABC, BTR, PCB; GT-DEV-00000851; Events; Recalls)
python -m backend.app.db.seed

# 4. Start local development server
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload
```

Interactive OpenAPI Swagger UI is available at: `http://localhost:8000/docs`

For full Azure App Service and Supabase deployment instructions, see [backend/README.md](file:///c:/Users/dksss/GeneaTrace_Backend/backend/README.md).
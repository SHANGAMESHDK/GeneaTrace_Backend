import os
import time
import uuid
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from backend.app.api.router import api_router
from backend.blockchain.adapter import blockchain_adapter
from backend.app.core.config import settings
from backend.app.core.exceptions import GeneaTraceException
from backend.app.core.logging import logger
from backend.app.db.neo4j import neo4j_manager
from backend.app.db.postgres import check_postgres_connection, init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: ensure tables exist in dev/test environments
    logger.info(f"Starting {settings.APP_NAME} in '{settings.APP_ENV}' mode on port {settings.PORT}...")
    try:
        init_db()
        logger.info("Database schema verified.")
    except Exception as e:
        logger.error(f"Database initialization warning: {str(e)}")
    yield
    # Shutdown
    neo4j_manager.close()
    logger.info("Application shutdown completed.")


app = FastAPI(
    title=settings.APP_NAME,
    description="Blockchain-Linked Digital Product Passport for Manufacturing Lineage, Batch Traceability, Device Identity, and Precision Recalls",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    request.state.request_id = request_id
    start_time = time.perf_counter()

    response = await call_next(request)
    duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Response-Time-Ms"] = str(duration_ms)

    # Don't log spam on health probes
    if not request.url.path.startswith(("/health", "/ready")):
        logger.info(
            f"[{request.method}] {request.url.path} -> {response.status_code} in {duration_ms}ms (req_id={request_id})"
        )
    return response


# Global Exception Handler
@app.exception_handler(GeneaTraceException)
async def geneatrace_exception_handler(request: Request, exc: GeneaTraceException):
    req_id = getattr(request.state, "request_id", str(uuid.uuid4()))
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "success": False,
            "request_id": req_id,
            "error": exc.detail,
        },
    )


# Health and Readiness Endpoints for Azure App Service & Kubernetes
@app.get("/health", tags=["Health Checks"])
def health_check():
    """Liveness probe: verifies the ASGI worker is responding"""
    return {
        "status": "healthy",
        "service": settings.APP_NAME,
        "environment": settings.APP_ENV,
        "timestamp": time.time(),
    }


@app.get("/ready", tags=["Health Checks"])
def readiness_check():
    """Readiness probe: validates database, graph database, and blockchain adapter status"""
    pg_status = check_postgres_connection()
    graph_status = neo4j_manager.check_connection()
    bc_status = blockchain_adapter.check_connection()

    all_ready = (pg_status.get("status") == "healthy")

    return JSONResponse(
        status_code=status.HTTP_200_OK if all_ready else status.HTTP_503_SERVICE_UNAVAILABLE,
        content={
            "status": "ready" if all_ready else "not_ready",
            "relational_database": pg_status,
            "graph_database": graph_status,
            "blockchain": bc_status,
            "environment": settings.APP_ENV,
        },
    )


# Mount API Router
app.include_router(api_router)


if __name__ == "__main__":
    import uvicorn
    # Azure App Service sets the PORT environment variable
    port = int(os.environ.get("PORT", settings.PORT))
    uvicorn.run("backend.app.main:app", host=settings.HOST, port=port, reload=settings.DEBUG)

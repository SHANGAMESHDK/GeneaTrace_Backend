from fastapi import APIRouter
from backend.app.api.v1 import (
    assembly,
    auth,
    batches,
    blockchain,
    components,
    dashboard,
    integrations,
    logistics,
    manufacturing,
    passports,
    products,
    recalls,
    security,
    traceability,
)

api_router = APIRouter(prefix="/api/v1")

api_router.include_router(auth.router)
api_router.include_router(batches.router)
api_router.include_router(components.router)
api_router.include_router(manufacturing.router)
api_router.include_router(assembly.router)
api_router.include_router(products.router)
api_router.include_router(passports.router)
api_router.include_router(traceability.router)
api_router.include_router(recalls.router)
api_router.include_router(logistics.router)
api_router.include_router(blockchain.router)
api_router.include_router(security.router)
api_router.include_router(integrations.router)
api_router.include_router(dashboard.router)

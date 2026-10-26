from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from backend.app.db.postgres import get_db
from backend.app.schemas.traceability import (
    TraceabilityQueryRequest,
    TraceabilityResultResponse,
)
from backend.app.services.graph_service import graph_service

router = APIRouter(prefix="/traceability", tags=["Lineage & Traceability Graph"])


@router.post("/query", response_model=TraceabilityResultResponse)
def query_traceability(query: TraceabilityQueryRequest, db: Session = Depends(get_db)):
    return graph_service.execute_traceability_query(db, query)


@router.get("/batch/{batch_code}", response_model=TraceabilityResultResponse)
@router.get("/forward/{batch_code}", response_model=TraceabilityResultResponse)
def trace_batch(batch_code: str, db: Session = Depends(get_db)):
    req = TraceabilityQueryRequest(entity_type="batch", entity_id=batch_code, direction="forward")
    return graph_service.execute_traceability_query(db, req)


@router.get("/component/{serial}", response_model=TraceabilityResultResponse)
def trace_component(serial: str, db: Session = Depends(get_db)):
    req = TraceabilityQueryRequest(entity_type="component", entity_id=serial, direction="forward")
    return graph_service.execute_traceability_query(db, req)


@router.get("/product/{product_id}", response_model=TraceabilityResultResponse)
@router.get("/backward/{product_id}", response_model=TraceabilityResultResponse)
def trace_product(product_id: str, db: Session = Depends(get_db)):
    req = TraceabilityQueryRequest(entity_type="product", entity_id=product_id, direction="backward")
    return graph_service.execute_traceability_query(db, req)


@router.get("/shipment/{shipment_id}", response_model=TraceabilityResultResponse)
def trace_shipment(shipment_id: str, db: Session = Depends(get_db)):
    req = TraceabilityQueryRequest(entity_type="shipment", entity_id=shipment_id, direction="backward")
    return graph_service.execute_traceability_query(db, req)


# Separate lineage_router without /traceability prefix for frontend compatibility
lineage_router = APIRouter(prefix="/lineage", tags=["Lineage"])


@lineage_router.get("/forward/{batch_code}", response_model=TraceabilityResultResponse)
def lineage_forward(batch_code: str, db: Session = Depends(get_db)):
    req = TraceabilityQueryRequest(entity_type="batch", entity_id=batch_code, direction="forward")
    return graph_service.execute_traceability_query(db, req)


@lineage_router.get("/backward/{product_id}", response_model=TraceabilityResultResponse)
def lineage_backward(product_id: str, db: Session = Depends(get_db)):
    req = TraceabilityQueryRequest(entity_type="product", entity_id=product_id, direction="backward")
    return graph_service.execute_traceability_query(db, req)

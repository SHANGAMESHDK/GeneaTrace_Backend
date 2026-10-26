from typing import List, Optional
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session
from backend.app.api.deps import require_permission
from backend.app.db.postgres import get_db
from backend.app.models.shipment import ShipmentStatus
from backend.app.schemas.common import PaginatedResponse
from backend.app.schemas.logistics import (
    AddProductsToShipmentRequest,
    ShipmentCreate,
    ShipmentEventCreate,
    ShipmentEventResponse,
    ShipmentResponse,
    ShipmentTraceabilityResponse,
)
from backend.app.services.logistics_service import logistics_service

router = APIRouter(prefix="/shipments", tags=["Logistics & Custody"])


@router.post("", response_model=ShipmentResponse, status_code=status.HTTP_201_CREATED)
def create_shipment(
    req: ShipmentCreate,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("shipments:create")),
):
    return logistics_service.create_shipment(db, req)


@router.get("", response_model=PaginatedResponse[ShipmentResponse])
def list_shipments(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    shipment_status: Optional[ShipmentStatus] = None,
    db: Session = Depends(get_db),
):
    items, total = logistics_service.get_shipments(db, page=page, page_size=page_size, status=shipment_status)
    total_pages = (total + page_size - 1) // page_size if total > 0 else 1
    return PaginatedResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.get("/{shipment_id}", response_model=ShipmentResponse)
def get_shipment(shipment_id: str, db: Session = Depends(get_db)):
    return logistics_service.get_shipment(db, shipment_id)


@router.post("/{shipment_id}/events", response_model=ShipmentEventResponse, status_code=status.HTTP_201_CREATED)
def add_shipment_event(
    shipment_id: str,
    req: ShipmentEventCreate,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("shipments:event")),
):
    return logistics_service.add_shipment_event(db, shipment_id, req)


@router.post("/{shipment_id}/products", response_model=ShipmentResponse)
def add_products_to_shipment(
    shipment_id: str,
    req: AddProductsToShipmentRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("shipments:create")),
):
    return logistics_service.add_products_to_shipment(db, shipment_id, req.product_ids)


@router.get("/{shipment_id}/traceability", response_model=ShipmentTraceabilityResponse)
def get_shipment_traceability(shipment_id: str, db: Session = Depends(get_db)):
    shipment = logistics_service.get_shipment(db, shipment_id)
    return ShipmentTraceabilityResponse(
        shipment=shipment,
        products=[{"product_id": pid} for pid in shipment.product_ids],
        custody_chain=shipment.events,
    )

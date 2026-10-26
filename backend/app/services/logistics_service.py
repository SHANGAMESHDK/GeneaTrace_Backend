import uuid
from datetime import datetime, timezone
from typing import List, Optional, Tuple
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from backend.app.core.exceptions import (
    DuplicateEntityException,
    EntityNotFoundException,
    InvalidOperationException,
)
from backend.app.models.product import FinishedProduct, ProductManufacturingStatus
from backend.app.models.shipment import (
    Shipment,
    ShipmentEvent,
    ShipmentEventType,
    ShipmentItem,
    ShipmentStatus,
)
from backend.app.schemas.logistics import (
    ShipmentCreate,
    ShipmentEventCreate,
    ShipmentEventResponse,
    ShipmentResponse,
    ShipmentTraceabilityResponse,
)


class LogisticsService:
    @staticmethod
    def create_shipment(db: Session, req: ShipmentCreate) -> ShipmentResponse:
        existing = db.execute(
            select(Shipment).where(Shipment.shipment_id == req.shipment_id.strip().upper())
        ).scalar_one_or_none()
        if existing:
            raise DuplicateEntityException("Shipment", req.shipment_id)

        shipment = Shipment(
            shipment_id=req.shipment_id.strip().upper(),
            origin=req.origin,
            destination=req.destination,
            carrier=req.carrier,
            expected_delivery=req.expected_delivery,
            status=ShipmentStatus.PREPARING,
            custody_metadata=req.custody_metadata,
        )
        db.add(shipment)
        db.flush()

        # Add initial products if provided
        added_product_ids = []
        for pid in req.product_ids:
            prod = db.execute(
                select(FinishedProduct).where(FinishedProduct.product_id == pid.strip().upper())
            ).scalar_one_or_none()
            if prod:
                item = ShipmentItem(shipment_id=shipment.id, product_id=prod.id)
                db.add(item)
                prod.manufacturing_status = ProductManufacturingStatus.SHIPPED
                added_product_ids.append(prod.product_id)

        # Initial packing event
        evt_id = f"LOG-EVT-{uuid.uuid4().hex[:8].upper()}"
        initial_evt = ShipmentEvent(
            event_id=evt_id,
            shipment_id=shipment.id,
            event_type=ShipmentEventType.PACKING,
            location=req.origin,
            custody_party=req.carrier,
            notes="Initial shipment container packing completed.",
        )
        db.add(initial_evt)

        db.commit()
        db.refresh(shipment)

        return LogisticsService.get_shipment(db, shipment.shipment_id)

    @staticmethod
    def get_shipment(db: Session, shipment_id: str) -> ShipmentResponse:
        shipment = db.execute(
            select(Shipment).where(Shipment.shipment_id == shipment_id.strip().upper())
        ).scalar_one_or_none()
        if not shipment:
            raise EntityNotFoundException("Shipment", shipment_id)

        items = db.execute(select(ShipmentItem).where(ShipmentItem.shipment_id == shipment.id)).scalars().all()
        prod_ids = [i.product.product_id for i in items if i.product]

        events = db.execute(
            select(ShipmentEvent)
            .where(ShipmentEvent.shipment_id == shipment.id)
            .order_by(ShipmentEvent.timestamp.asc())
        ).scalars().all()

        evt_responses = [ShipmentEventResponse.model_validate(e) for e in events]

        return ShipmentResponse(
            id=shipment.id,
            shipment_id=shipment.shipment_id,
            origin=shipment.origin,
            destination=shipment.destination,
            carrier=shipment.carrier,
            dispatched_at=shipment.dispatched_at,
            expected_delivery=shipment.expected_delivery,
            delivered_at=shipment.delivered_at,
            status=shipment.status,
            custody_metadata=shipment.custody_metadata,
            product_count=len(items),
            product_ids=prod_ids,
            events=evt_responses,
            created_at=shipment.created_at,
        )

    @staticmethod
    def get_shipments(
        db: Session, page: int = 1, page_size: int = 20, status: Optional[ShipmentStatus] = None
    ) -> Tuple[List[ShipmentResponse], int]:
        stmt = select(Shipment)
        count_stmt = select(func.count(Shipment.id))

        if status:
            stmt = stmt.where(Shipment.status == status)
            count_stmt = count_stmt.where(Shipment.status == status)

        total = db.scalar(count_stmt) or 0
        shipments = db.execute(stmt.order_by(Shipment.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).scalars().all()
        
        responses = [LogisticsService.get_shipment(db, s.shipment_id) for s in shipments]
        return responses, total

    @staticmethod
    def add_shipment_event(db: Session, shipment_id: str, req: ShipmentEventCreate) -> ShipmentEventResponse:
        shipment = db.execute(
            select(Shipment).where(Shipment.shipment_id == shipment_id.strip().upper())
        ).scalar_one_or_none()
        if not shipment:
            raise EntityNotFoundException("Shipment", shipment_id)

        evt_id = f"LOG-EVT-{uuid.uuid4().hex[:8].upper()}"
        evt = ShipmentEvent(
            event_id=evt_id,
            shipment_id=shipment.id,
            event_type=req.event_type,
            location=req.location,
            custody_party=req.custody_party,
            timestamp=req.timestamp or datetime.now(timezone.utc),
            notes=req.notes,
            source_system=req.source_system,
            verification_metadata=req.verification_metadata,
        )
        db.add(evt)

        # Update shipment status based on event type
        if req.event_type == ShipmentEventType.DISPATCH:
            shipment.status = ShipmentStatus.IN_TRANSIT
            shipment.dispatched_at = evt.timestamp
        elif req.event_type in (ShipmentEventType.CARRIER_HANDOVER, ShipmentEventType.TRANSIT_CHECKPOINT):
            shipment.status = ShipmentStatus.IN_TRANSIT
        elif req.event_type == ShipmentEventType.DISTRIBUTION:
            shipment.status = ShipmentStatus.OUT_FOR_DELIVERY
        elif req.event_type == ShipmentEventType.DELIVERY:
            shipment.status = ShipmentStatus.DELIVERED
            shipment.delivered_at = evt.timestamp
        elif req.event_type == ShipmentEventType.EXCEPTION:
            shipment.status = ShipmentStatus.EXCEPTION
        elif req.event_type == ShipmentEventType.RETURN:
            shipment.status = ShipmentStatus.RETURNED

        db.commit()
        db.refresh(evt)
        return ShipmentEventResponse.model_validate(evt)

    @staticmethod
    def add_products_to_shipment(db: Session, shipment_id: str, product_ids: List[str]) -> ShipmentResponse:
        shipment = db.execute(
            select(Shipment).where(Shipment.shipment_id == shipment_id.strip().upper())
        ).scalar_one_or_none()
        if not shipment:
            raise EntityNotFoundException("Shipment", shipment_id)

        for pid in product_ids:
            prod = db.execute(
                select(FinishedProduct).where(FinishedProduct.product_id == pid.strip().upper())
            ).scalar_one_or_none()
            if prod:
                # Check not already in shipment
                already = db.execute(
                    select(ShipmentItem).where(ShipmentItem.shipment_id == shipment.id, ShipmentItem.product_id == prod.id)
                ).scalar_one_or_none()
                if not already:
                    item = ShipmentItem(shipment_id=shipment.id, product_id=prod.id)
                    db.add(item)
                    prod.manufacturing_status = ProductManufacturingStatus.SHIPPED

        db.commit()
        return LogisticsService.get_shipment(db, shipment.shipment_id)


logistics_service = LogisticsService

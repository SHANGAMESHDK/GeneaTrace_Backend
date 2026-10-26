import uuid
from typing import List, Optional, Tuple
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from backend.app.core.exceptions import (
    DuplicateEntityException,
    EntityNotFoundException,
    InvalidOperationException,
)
from backend.app.models.batch import Batch
from backend.app.models.component import Component, ComponentStatus, QualityStatus
from backend.app.models.manufacturing_event import (
    EventResult,
    EventStatus,
    ManufacturingEvent,
    ManufacturingOperation,
)
from backend.app.models.product import FinishedProduct
from backend.app.schemas.manufacturing import EventCreate, EventResponse
from backend.app.services.merkle_service import merkle_service


class ManufacturingService:
    @staticmethod
    def get_or_create_operation(
        db: Session,
        operation_code: str,
        operation_name: Optional[str] = None,
        sequence_number: int = 1,
    ) -> ManufacturingOperation:
        op = db.execute(
            select(ManufacturingOperation).where(ManufacturingOperation.operation_code == operation_code.upper())
        ).scalar_one_or_none()
        if not op:
            op = ManufacturingOperation(
                operation_code=operation_code.upper(),
                operation_name=operation_name or operation_code.replace("_", " ").title(),
                sequence_number=sequence_number,
            )
            db.add(op)
            db.flush()
        return op

    @staticmethod
    def record_event(
        db: Session,
        event_in: EventCreate,
        operator_id: str,
    ) -> ManufacturingEvent:
        # Check idempotency
        if event_in.idempotency_key:
            existing = db.execute(
                select(ManufacturingEvent).where(ManufacturingEvent.idempotency_key == event_in.idempotency_key)
            ).scalar_one_or_none()
            if existing:
                return existing

        component = None
        product = None
        batch = None

        if event_in.component_serial:
            component = db.execute(
                select(Component).where(Component.component_serial == event_in.component_serial.strip().upper())
            ).scalar_one_or_none()
            if not component:
                raise EntityNotFoundException("Component", event_in.component_serial)
            batch = db.execute(select(Batch).where(Batch.id == component.batch_id)).scalar_one_or_none()

            # Validate component belongs to specified batch if provided
            if event_in.batch_code and batch and batch.batch_code != event_in.batch_code.upper():
                raise InvalidOperationException(
                    f"Component '{event_in.component_serial}' belongs to batch '{batch.batch_code}', not '{event_in.batch_code}'."
                )

        if event_in.product_id:
            product = db.execute(
                select(FinishedProduct).where(FinishedProduct.product_id == event_in.product_id)
            ).scalar_one_or_none()
            if not product and not component:
                raise EntityNotFoundException("FinishedProduct", event_in.product_id)

        operation = db.execute(
            select(ManufacturingOperation).where(ManufacturingOperation.operation_code == event_in.operation_code.upper())
        ).scalar_one_or_none()
        if not operation:
            operation = ManufacturingOperation(
                operation_code=event_in.operation_code.upper(),
                operation_name=event_in.operation_code.replace("_", " ").title(),
                sequence_number=1,
            )
            db.add(operation)
            db.flush()

        # Find previous event hash for this unit to establish Merkle-DAG parent link
        previous_event_hash = None
        if component:
            last_event = db.execute(
                select(ManufacturingEvent)
                .where(ManufacturingEvent.component_id == component.id)
                .order_by(ManufacturingEvent.completed_at.desc(), ManufacturingEvent.created_at.desc())
            ).scalars().first()
            if last_event:
                previous_event_hash = last_event.canonical_payload_hash
        elif product:
            last_event = db.execute(
                select(ManufacturingEvent)
                .where(ManufacturingEvent.product_id == product.id)
                .order_by(ManufacturingEvent.completed_at.desc(), ManufacturingEvent.created_at.desc())
            ).scalars().first()
            if last_event:
                previous_event_hash = last_event.canonical_payload_hash

        event_id = f"EVT-{uuid.uuid4().hex[:10].upper()}"

        # Build payload dict for canonical hashing
        payload_dict = {
            "event_id": event_id,
            "component_id": component.id if component else None,
            "product_id": product.id if product else None,
            "batch_id": batch.id if batch else None,
            "operation_id": operation.id,
            "machine_id": event_in.machine_id,
            "operator_id": operator_id,
            "started_at": event_in.started_at,
            "completed_at": event_in.completed_at,
            "event_status": event_in.event_status.value,
            "result": event_in.result.value,
            "measured_parameters": event_in.measured_parameters or {},
            "inspection_result": event_in.inspection_result,
            "rework_reference": event_in.rework_reference,
            "previous_event_hash": previous_event_hash,
            "source_system": event_in.source_system,
        }
        canonical_hash = merkle_service.compute_event_hash(payload_dict)

        new_event = ManufacturingEvent(
            event_id=event_id,
            component_id=component.id if component else None,
            product_id=product.id if product else None,
            batch_id=batch.id if batch else None,
            operation_id=operation.id,
            machine_id=event_in.machine_id,
            operator_id=operator_id,
            started_at=event_in.started_at,
            completed_at=event_in.completed_at,
            event_status=event_in.event_status,
            result=event_in.result,
            measured_parameters=event_in.measured_parameters or {},
            inspection_result=event_in.inspection_result,
            rework_reference=event_in.rework_reference,
            idempotency_key=event_in.idempotency_key,
            source_system=event_in.source_system,
            canonical_payload_hash=canonical_hash,
            previous_event_hash=previous_event_hash,
            signature_metadata=event_in.signature_metadata,
        )
        db.add(new_event)

        # Update component quality/status if this is an inspection/final test
        if component:
            if event_in.result == EventResult.FAIL:
                component.quality_status = QualityStatus.FAILED
            elif event_in.result == EventResult.PASS:
                component.quality_status = QualityStatus.PASSED
                component.status = ComponentStatus.READY_FOR_ASSEMBLY

        db.commit()
        db.refresh(new_event)
        return new_event

    @staticmethod
    def get_event_by_id(db: Session, event_id: str) -> ManufacturingEvent:
        evt = db.execute(
            select(ManufacturingEvent).where(ManufacturingEvent.event_id == event_id)
        ).scalar_one_or_none()
        if not evt:
            raise EntityNotFoundException("ManufacturingEvent", event_id)
        return evt

    @staticmethod
    def get_events_for_component(db: Session, serial: str) -> List[ManufacturingEvent]:
        comp = db.execute(
            select(Component).where(Component.component_serial == serial.strip().upper())
        ).scalar_one_or_none()
        if not comp:
            raise EntityNotFoundException("Component", serial)
        events = db.execute(
            select(ManufacturingEvent)
            .where(ManufacturingEvent.component_id == comp.id)
            .order_by(ManufacturingEvent.completed_at.asc())
        ).scalars().all()
        return list(events)

    @staticmethod
    def get_events_for_batch(db: Session, batch_code: str) -> List[ManufacturingEvent]:
        batch = db.execute(
            select(Batch).where(Batch.batch_code == batch_code.strip().upper())
        ).scalar_one_or_none()
        if not batch:
            raise EntityNotFoundException("Batch", batch_code)
        events = db.execute(
            select(ManufacturingEvent)
            .where(ManufacturingEvent.batch_id == batch.id)
            .order_by(ManufacturingEvent.completed_at.asc())
        ).scalars().all()
        return list(events)


manufacturing_service = ManufacturingService

from typing import List, Optional, Tuple
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from backend.app.core.exceptions import DuplicateEntityException, EntityNotFoundException
from backend.app.models.batch import Batch, BatchStatus, ComponentType
from backend.app.models.component import Component
from backend.app.schemas.batch import BatchCreate, BatchWithSerialsResponse
from backend.app.services.serial_service import serial_service


class BatchService:
    @staticmethod
    def create_batch(db: Session, batch_in: BatchCreate, issuer_id: str) -> BatchWithSerialsResponse:
        # Check uniqueness of batch_code
        existing = db.execute(select(Batch).where(Batch.batch_code == batch_in.batch_code.upper())).scalar_one_or_none()
        if existing:
            raise DuplicateEntityException("Batch", batch_in.batch_code)

        new_batch = Batch(
            batch_code=batch_in.batch_code.upper(),
            component_type=batch_in.component_type,
            issuer_id=issuer_id,
            supplier_id=batch_in.supplier_id,
            facility_id=batch_in.facility_id,
            planned_quantity=batch_in.planned_quantity,
            actual_quantity=0,
            status=BatchStatus.IN_PRODUCTION,
        )
        db.add(new_batch)
        db.flush()

        # Atomically allocate serials
        allocated_components = serial_service.allocate_batch_serials(db, new_batch, batch_in.planned_quantity)
        db.commit()
        db.refresh(new_batch)

        start_serial, end_serial = serial_service.get_serial_range(allocated_components)
        sample = [c.component_serial for c in allocated_components[:10]]

        return BatchWithSerialsResponse(
            id=new_batch.id,
            batch_code=new_batch.batch_code,
            component_type=new_batch.component_type,
            issuer_id=new_batch.issuer_id,
            supplier_id=new_batch.supplier_id,
            facility_id=new_batch.facility_id,
            planned_quantity=new_batch.planned_quantity,
            actual_quantity=new_batch.actual_quantity,
            production_start=new_batch.production_start,
            production_end=new_batch.production_end,
            status=new_batch.status,
            quality_status=new_batch.quality_status,
            created_at=new_batch.created_at,
            serial_range_start=start_serial,
            serial_range_end=end_serial,
            allocated_serials_sample=sample,
            total_serials_allocated=len(allocated_components),
        )

    @staticmethod
    def get_batch_by_code(db: Session, batch_code: str) -> Batch:
        batch = db.execute(select(Batch).where(Batch.batch_code == batch_code.upper())).scalar_one_or_none()
        if not batch:
            raise EntityNotFoundException("Batch", batch_code)
        return batch

    @staticmethod
    def get_batches(
        db: Session,
        page: int = 1,
        page_size: int = 20,
        component_type: Optional[ComponentType] = None,
        status: Optional[BatchStatus] = None,
    ) -> Tuple[List[Batch], int]:
        stmt = select(Batch)
        count_stmt = select(func.count(Batch.id))

        if component_type:
            stmt = stmt.where(Batch.component_type == component_type)
            count_stmt = count_stmt.where(Batch.component_type == component_type)
        if status:
            stmt = stmt.where(Batch.status == status)
            count_stmt = count_stmt.where(Batch.status == status)

        total = db.scalar(count_stmt) or 0
        batches = db.execute(stmt.order_by(Batch.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).scalars().all()
        return list(batches), total

    @staticmethod
    def get_batch_serials(
        db: Session,
        batch_code: str,
        page: int = 1,
        page_size: int = 50,
    ) -> Tuple[List[Component], int]:
        batch = BatchService.get_batch_by_code(db, batch_code)
        count_stmt = select(func.count(Component.id)).where(Component.batch_id == batch.id)
        total = db.scalar(count_stmt) or 0

        components = db.execute(
            select(Component)
            .where(Component.batch_id == batch.id)
            .order_by(Component.component_serial.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).scalars().all()
        return list(components), total


batch_service = BatchService

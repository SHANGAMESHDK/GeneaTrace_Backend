from datetime import datetime, timezone
from typing import List, Optional, Tuple
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from backend.app.core.exceptions import DuplicateEntityException, EntityNotFoundException
from backend.app.models.batch import Batch, ComponentType, QualityStatus
from backend.app.models.component import Component, ComponentStatus
from backend.app.schemas.component import ComponentCreate


class ComponentService:
    @staticmethod
    def get_component_by_serial(db: Session, serial: str) -> Component:
        comp = db.execute(select(Component).where(Component.component_serial == serial.strip().upper())).scalar_one_or_none()
        if not comp:
            raise EntityNotFoundException("Component", serial)
        return comp

    @staticmethod
    def create_component(db: Session, comp_in: ComponentCreate) -> Component:
        serial_clean = comp_in.component_serial.strip().upper()
        existing = db.execute(select(Component).where(Component.component_serial == serial_clean)).scalar_one_or_none()
        if existing:
            raise DuplicateEntityException("Component", serial_clean)

        # Allow batch_id to be UUID or batch_code
        batch = db.execute(
            select(Batch).where(
                (Batch.id == comp_in.batch_id) | (Batch.batch_code == comp_in.batch_id.upper())
            )
        ).scalar_one_or_none()
        if not batch:
            raise EntityNotFoundException("Batch", comp_in.batch_id)

        new_comp = Component(
            component_serial=serial_clean,
            component_type=comp_in.component_type,
            batch_id=batch.id,
            manufacturer_id=comp_in.manufacturer_id,
            supplier_id=comp_in.supplier_id,
            facility_id=comp_in.facility_id,
            production_date=comp_in.production_date or datetime.now(timezone.utc),
            status=ComponentStatus.REGISTERED,
            quality_status=QualityStatus.PENDING,
        )
        db.add(new_comp)
        db.commit()
        db.refresh(new_comp)
        return new_comp

    @staticmethod
    def get_components(
        db: Session,
        page: int = 1,
        page_size: int = 20,
        component_type: Optional[ComponentType] = None,
        status: Optional[ComponentStatus] = None,
    ) -> Tuple[List[Component], int]:
        stmt = select(Component)
        count_stmt = select(func.count(Component.id))

        if component_type:
            stmt = stmt.where(Component.component_type == component_type)
            count_stmt = count_stmt.where(Component.component_type == component_type)
        if status:
            stmt = stmt.where(Component.status == status)
            count_stmt = count_stmt.where(Component.status == status)

        total = db.scalar(count_stmt) or 0
        items = db.execute(stmt.order_by(Component.component_serial.asc()).offset((page - 1) * page_size).limit(page_size)).scalars().all()
        return list(items), total


component_service = ComponentService


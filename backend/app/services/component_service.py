from typing import List, Optional, Tuple
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from backend.app.core.exceptions import EntityNotFoundException
from backend.app.models.batch import ComponentType
from backend.app.models.component import Component, ComponentStatus


class ComponentService:
    @staticmethod
    def get_component_by_serial(db: Session, serial: str) -> Component:
        comp = db.execute(select(Component).where(Component.component_serial == serial.strip().upper())).scalar_one_or_none()
        if not comp:
            raise EntityNotFoundException("Component", serial)
        return comp

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

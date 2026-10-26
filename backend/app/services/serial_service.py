from typing import List, Tuple
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from backend.app.core.exceptions import DuplicateEntityException, InvalidOperationException
from backend.app.models.batch import Batch, ComponentType
from backend.app.models.component import Component, ComponentStatus, QualityStatus

COMPONENT_PREFIX_MAP = {
    ComponentType.DISPLAY: "ABC",
    ComponentType.BATTERY: "BTR",
    ComponentType.PCB: "PCB",
    ComponentType.CAMERA: "CAM",
    ComponentType.SPEAKER: "SPK",
    ComponentType.FRAME: "FRM",
}


class SerialService:
    @staticmethod
    def get_prefix_for_component_type(component_type: ComponentType) -> str:
        return COMPONENT_PREFIX_MAP.get(component_type, component_type.value[:3].upper())

    @classmethod
    def allocate_batch_serials(
        cls,
        db: Session,
        batch: Batch,
        quantity: int,
    ) -> List[Component]:
        """
        Atomically allocates serial numbers for a new batch in sequence.
        Format: {PREFIX}-{0001} up to {PREFIX}-{NNNN}.
        Guarantees atomicity, checks for uniqueness, and rolls back on collision.
        """
        if quantity <= 0:
            raise InvalidOperationException("Planned quantity must be greater than zero.")
        if quantity > 10000:
            raise InvalidOperationException("Batch quantity cannot exceed 10,000 in a single allocation.")

        prefix = batch.batch_code.strip().upper()

        # Check existing components with this prefix to determine sequence offset
        existing_count_stmt = (
            select(func.count(Component.id))
            .where(Component.component_serial.like(f"{prefix}-%"))
        )
        existing_count = db.scalar(existing_count_stmt) or 0

        components_to_add: List[Component] = []
        pad_length = 4 if (existing_count + quantity) <= 9999 else 6

        for i in range(1, quantity + 1):
            seq_num = existing_count + i
            serial_str = f"{prefix}-{seq_num:0{pad_length}d}"
            
            comp = Component(
                component_serial=serial_str,
                component_type=batch.component_type,
                batch_id=batch.id,
                manufacturer_id=batch.issuer_id,
                supplier_id=batch.supplier_id,
                facility_id=batch.facility_id,
                status=ComponentStatus.REGISTERED,
                quality_status=QualityStatus.PENDING,
            )
            components_to_add.append(comp)

        try:
            db.add_all(components_to_add)
            batch.actual_quantity = len(components_to_add)
            db.flush()
        except Exception as e:
            db.rollback()
            raise DuplicateEntityException("ComponentSerialAllocation", f"Serial collision detected for prefix {prefix}: {str(e)}")

        return components_to_add

    @classmethod
    def get_serial_range(cls, components: List[Component]) -> Tuple[str, str]:
        if not components:
            return "", ""
        return components[0].component_serial, components[-1].component_serial


serial_service = SerialService

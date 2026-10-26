from datetime import datetime, timezone
from enum import Enum
from sqlalchemy import DateTime, Enum as SQLEnum, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.app.models.base import Base, TimestampMixin, UUIDMixin


class ComponentType(str, Enum):
    DISPLAY = "DISPLAY"
    BATTERY = "BATTERY"
    PCB = "PCB"
    CAMERA = "CAMERA"
    SPEAKER = "SPEAKER"
    FRAME = "FRAME"


class BatchStatus(str, Enum):
    PLANNED = "PLANNED"
    IN_PRODUCTION = "IN_PRODUCTION"
    COMPLETED = "COMPLETED"
    DEFECTIVE = "DEFECTIVE"
    QUARANTINED = "QUARANTINED"


class QualityStatus(str, Enum):
    PENDING = "PENDING"
    PASSED = "PASSED"
    FAILED = "FAILED"
    REWORKED = "REWORKED"


class Batch(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "batches"

    batch_code: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    component_type: Mapped[ComponentType] = mapped_column(SQLEnum(ComponentType), nullable=False, index=True)
    issuer_id: Mapped[str] = mapped_column(String(100), nullable=False)
    supplier_id: Mapped[str] = mapped_column(String(100), nullable=False)
    facility_id: Mapped[str] = mapped_column(String(100), nullable=False)
    planned_quantity: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    actual_quantity: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    production_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    production_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[BatchStatus] = mapped_column(SQLEnum(BatchStatus), default=BatchStatus.IN_PRODUCTION, nullable=False)
    quality_status: Mapped[QualityStatus] = mapped_column(SQLEnum(QualityStatus), default=QualityStatus.PENDING, nullable=False)

    components = relationship("Component", back_populates="batch", cascade="all, delete-orphan")

from datetime import datetime, timezone
from enum import Enum
from sqlalchemy import DateTime, Enum as SQLEnum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.app.models.base import Base, TimestampMixin, UUIDMixin
from backend.app.models.batch import ComponentType, QualityStatus


class ComponentStatus(str, Enum):
    REGISTERED = "REGISTERED"
    IN_PROCESS = "IN_PROCESS"
    READY_FOR_ASSEMBLY = "READY_FOR_ASSEMBLY"
    INSTALLED = "INSTALLED"
    REPLACED = "REPLACED"
    QUARANTINED = "QUARANTINED"
    SCRAPPED = "SCRAPPED"


class Component(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "components"

    component_serial: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    component_type: Mapped[ComponentType] = mapped_column(SQLEnum(ComponentType), nullable=False, index=True)
    batch_id: Mapped[str] = mapped_column(String(36), ForeignKey("batches.id", ondelete="CASCADE"), nullable=False, index=True)
    manufacturer_id: Mapped[str] = mapped_column(String(100), nullable=False)
    supplier_id: Mapped[str] = mapped_column(String(100), nullable=False)
    facility_id: Mapped[str] = mapped_column(String(100), nullable=False)
    production_date: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    status: Mapped[ComponentStatus] = mapped_column(SQLEnum(ComponentStatus), default=ComponentStatus.REGISTERED, nullable=False)
    quality_status: Mapped[QualityStatus] = mapped_column(SQLEnum(QualityStatus), default=QualityStatus.PENDING, nullable=False)

    batch = relationship("Batch", back_populates="components")

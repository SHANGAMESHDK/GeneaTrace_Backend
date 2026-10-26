from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Optional
from sqlalchemy import JSON, DateTime, Enum as SQLEnum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.app.models.base import Base, TimestampMixin, UUIDMixin
from backend.app.models.batch import ComponentType


class EventStatus(str, Enum):
    NOT_STARTED = "NOT_STARTED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    REWORK_REQUIRED = "REWORK_REQUIRED"
    REWORKED = "REWORKED"
    VERIFIED = "VERIFIED"


class EventResult(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    MARGINAL = "MARGINAL"


class ManufacturingOperation(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "manufacturing_operations"

    operation_code: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    operation_name: Mapped[str] = mapped_column(String(255), nullable=False)
    component_type: Mapped[Optional[ComponentType]] = mapped_column(SQLEnum(ComponentType), nullable=True, index=True)
    sequence_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    facility_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    machine_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    configuration: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)


class ManufacturingEvent(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "manufacturing_events"

    event_id: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    component_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("components.id", ondelete="SET NULL"), nullable=True, index=True)
    product_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("finished_products.id", ondelete="SET NULL"), nullable=True, index=True)
    batch_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("batches.id", ondelete="SET NULL"), nullable=True, index=True)
    operation_id: Mapped[str] = mapped_column(String(36), ForeignKey("manufacturing_operations.id"), nullable=False, index=True)
    machine_id: Mapped[str] = mapped_column(String(100), nullable=False)
    operator_id: Mapped[str] = mapped_column(String(100), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    event_status: Mapped[EventStatus] = mapped_column(SQLEnum(EventStatus), default=EventStatus.COMPLETED, nullable=False)
    result: Mapped[EventResult] = mapped_column(SQLEnum(EventResult), default=EventResult.PASS, nullable=False)
    measured_parameters: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    inspection_result: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    rework_reference: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(100), unique=True, index=True, nullable=True)
    source_system: Mapped[str] = mapped_column(String(100), default="MES-01", nullable=False)
    
    # Merkle-DAG fields
    canonical_payload_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    previous_event_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    signature_metadata: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)

    operation = relationship("ManufacturingOperation")

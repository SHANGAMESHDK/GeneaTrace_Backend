from datetime import datetime
from enum import Enum
from typing import Optional
from sqlalchemy import DateTime, Enum as SQLEnum, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.app.models.base import Base, TimestampMixin, UUIDMixin


class RecallStatus(str, Enum):
    INITIATED = "INITIATED"
    CONFIRMED = "CONFIRMED"
    RESOLVED = "RESOLVED"
    CANCELLED = "CANCELLED"


class RecallSeverity(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class Recall(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "recalls"

    recall_id: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    affected_batch_id: Mapped[str] = mapped_column(String(36), ForeignKey("batches.id"), nullable=False, index=True)
    defect_category: Mapped[str] = mapped_column(String(100), nullable=False)
    severity: Mapped[RecallSeverity] = mapped_column(SQLEnum(RecallSeverity), default=RecallSeverity.HIGH, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[RecallStatus] = mapped_column(SQLEnum(RecallStatus), default=RecallStatus.INITIATED, nullable=False)
    created_by: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    confirmed_by: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    resolution_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    batch = relationship("Batch")
    creator = relationship("User", foreign_keys=[created_by])
    confirmer = relationship("User", foreign_keys=[confirmed_by])
    resolver = relationship("User", foreign_keys=[resolved_by])

from datetime import datetime
from enum import Enum
from typing import Any, Dict, Optional
from sqlalchemy import Boolean, DateTime, Enum as SQLEnum, Integer, String, JSON
from sqlalchemy.orm import Mapped, mapped_column
from backend.app.models.base import Base, TimestampMixin, UUIDMixin


class IntegrationSourceType(str, Enum):
    ERP = "ERP"
    MES = "MES"
    SCADA = "SCADA"
    QMS = "QMS"
    SUPPLIER = "SUPPLIER"
    LOGISTICS = "LOGISTICS"


class IntegrationStatus(str, Enum):
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    ERROR = "ERROR"


class IntegrationSource(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "integration_sources"

    name: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    source_type: Mapped[IntegrationSourceType] = mapped_column(SQLEnum(IntegrationSourceType), nullable=False)
    status: Mapped[IntegrationStatus] = mapped_column(SQLEnum(IntegrationStatus), default=IntegrationStatus.ACTIVE, nullable=False)
    endpoint_url: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    last_sync_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    sync_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    config_data: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)


class QuarantinedEvent(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "quarantined_events"

    source_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    raw_payload: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
    error_reason: Mapped[str] = mapped_column(String(500), nullable=False)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

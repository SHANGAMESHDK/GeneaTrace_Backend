from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Optional
from sqlalchemy import DateTime, Enum as SQLEnum, ForeignKey, String, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.app.models.base import Base, TimestampMixin, UUIDMixin


class ShipmentStatus(str, Enum):
    PREPARING = "PREPARING"
    PACKED = "PACKED"
    IN_TRANSIT = "IN_TRANSIT"
    OUT_FOR_DELIVERY = "OUT_FOR_DELIVERY"
    DELIVERED = "DELIVERED"
    EXCEPTION = "EXCEPTION"
    RETURNED = "RETURNED"


class ShipmentEventType(str, Enum):
    PACKING = "PACKING"
    DISPATCH = "DISPATCH"
    CARRIER_HANDOVER = "CARRIER_HANDOVER"
    TRANSIT_CHECKPOINT = "TRANSIT_CHECKPOINT"
    WAREHOUSE_ARRIVAL = "WAREHOUSE_ARRIVAL"
    DISTRIBUTION = "DISTRIBUTION"
    DELIVERY = "DELIVERY"
    EXCEPTION = "EXCEPTION"
    RETURN = "RETURN"


class Shipment(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "shipments"

    shipment_id: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    origin: Mapped[str] = mapped_column(String(255), nullable=False)
    destination: Mapped[str] = mapped_column(String(255), nullable=False)
    carrier: Mapped[str] = mapped_column(String(100), nullable=False)
    dispatched_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    expected_delivery: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    delivered_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[ShipmentStatus] = mapped_column(
        SQLEnum(ShipmentStatus), default=ShipmentStatus.PREPARING, nullable=False
    )
    custody_metadata: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)

    items = relationship("ShipmentItem", back_populates="shipment", cascade="all, delete-orphan")
    events = relationship("ShipmentEvent", back_populates="shipment", cascade="all, delete-orphan")


class ShipmentItem(Base, UUIDMixin):
    __tablename__ = "shipment_items"

    shipment_id: Mapped[str] = mapped_column(String(36), ForeignKey("shipments.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("finished_products.id", ondelete="CASCADE"), nullable=False, index=True)
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )

    shipment = relationship("Shipment", back_populates="items")
    product = relationship("FinishedProduct")


class ShipmentEvent(Base, UUIDMixin):
    __tablename__ = "shipment_events"

    event_id: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    shipment_id: Mapped[str] = mapped_column(String(36), ForeignKey("shipments.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type: Mapped[ShipmentEventType] = mapped_column(SQLEnum(ShipmentEventType), nullable=False)
    location: Mapped[str] = mapped_column(String(255), nullable=False)
    custody_party: Mapped[str] = mapped_column(String(100), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    source_system: Mapped[str] = mapped_column(String(100), default="LOGISTICS_PORTAL", nullable=False)
    verification_metadata: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)

    shipment = relationship("Shipment", back_populates="events")

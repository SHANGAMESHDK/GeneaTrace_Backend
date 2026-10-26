from datetime import datetime, timezone
from enum import Enum
from typing import Optional
from sqlalchemy import DateTime, Enum as SQLEnum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.app.models.base import Base, TimestampMixin, UUIDMixin


class ProductManufacturingStatus(str, Enum):
    IN_ASSEMBLY = "IN_ASSEMBLY"
    ASSEMBLED = "ASSEMBLED"
    TESTED = "TESTED"
    PACKAGED = "PACKAGED"
    SHIPPED = "SHIPPED"


class PassportStatus(str, Enum):
    DRAFT = "DRAFT"
    PUBLISHED = "PUBLISHED"
    SUSPENDED = "SUSPENDED"
    REVOKED = "REVOKED"


class AssemblyRelationshipStatus(str, Enum):
    ACTIVE = "ACTIVE"
    REPLACED = "REPLACED"


class FinishedProduct(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "finished_products"

    product_id: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    product_type: Mapped[str] = mapped_column(String(100), default="SMARTPHONE", nullable=False)
    manufacturer_id: Mapped[str] = mapped_column(String(100), nullable=False)
    assembly_facility_id: Mapped[str] = mapped_column(String(100), nullable=False)
    manufacturing_status: Mapped[ProductManufacturingStatus] = mapped_column(
        SQLEnum(ProductManufacturingStatus), default=ProductManufacturingStatus.ASSEMBLED, nullable=False
    )
    quality_status: Mapped[str] = mapped_column(String(50), default="PASSED", nullable=False)
    authorized_device_identity_commitment: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    masked_imei: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    passport_status: Mapped[PassportStatus] = mapped_column(
        SQLEnum(PassportStatus), default=PassportStatus.PUBLISHED, nullable=False
    )

    component_relationships = relationship(
        "ProductComponentRelationship", back_populates="product", cascade="all, delete-orphan"
    )


class ProductComponentRelationship(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "product_component_relationships"

    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("finished_products.id", ondelete="CASCADE"), nullable=False, index=True)
    component_id: Mapped[str] = mapped_column(String(36), ForeignKey("components.id", ondelete="CASCADE"), nullable=False, index=True)
    installation_event_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    installation_timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    removal_event_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    removal_timestamp: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    relationship_status: Mapped[AssemblyRelationshipStatus] = mapped_column(
        SQLEnum(AssemblyRelationshipStatus), default=AssemblyRelationshipStatus.ACTIVE, nullable=False
    )
    rework_reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    product = relationship("FinishedProduct", back_populates="component_relationships")
    component = relationship("Component")

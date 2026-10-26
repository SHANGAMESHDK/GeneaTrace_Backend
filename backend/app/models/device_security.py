from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Optional
from sqlalchemy import DateTime, Enum as SQLEnum, ForeignKey, String, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.app.models.base import Base, TimestampMixin, UUIDMixin


class VerificationStatus(str, Enum):
    VERIFIED = "VERIFIED"
    VERIFICATION_PENDING = "VERIFICATION_PENDING"
    SUSPICIOUS = "SUSPICIOUS"
    CONFIRMED_TAMPERING = "CONFIRMED_TAMPERING"
    REVOKED = "REVOKED"


class PolicyDecision(str, Enum):
    ALLOW = "ALLOW"
    FLAG_FOR_REVIEW = "FLAG_FOR_REVIEW"
    QUARANTINE = "QUARANTINE"
    ISSUE_LOCK_COMMAND = "ISSUE_LOCK_COMMAND"


class CommandType(str, Enum):
    LOCK = "LOCK"
    UNLOCK = "UNLOCK"
    RESTRICT_NETWORK = "RESTRICT_NETWORK"


class CommandStatus(str, Enum):
    PENDING_APPROVAL = "PENDING_APPROVAL"
    AUTHORIZED = "AUTHORIZED"
    ISSUED = "ISSUED"
    DELIVERED = "DELIVERED"
    EXECUTED = "EXECUTED"
    FAILED = "FAILED"
    EXPIRED = "EXPIRED"
    CANCELLED = "CANCELLED"


class DeviceSecurityEvent(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "device_security_events"

    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("finished_products.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)  # ATTESTATION_CHECK, IMEI_MISMATCH, etc.
    evidence_reference: Mapped[str] = mapped_column(String(255), nullable=False)
    severity: Mapped[str] = mapped_column(String(50), default="MEDIUM", nullable=False)
    verification_status: Mapped[VerificationStatus] = mapped_column(
        SQLEnum(VerificationStatus), default=VerificationStatus.VERIFICATION_PENDING, nullable=False
    )
    policy_decision: Mapped[PolicyDecision] = mapped_column(
        SQLEnum(PolicyDecision), default=PolicyDecision.FLAG_FOR_REVIEW, nullable=False
    )
    command_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    product = relationship("FinishedProduct")


class DeviceCommand(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "device_commands"

    command_id: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("finished_products.id", ondelete="CASCADE"), nullable=False, index=True)
    command_type: Mapped[CommandType] = mapped_column(SQLEnum(CommandType), default=CommandType.LOCK, nullable=False)
    status: Mapped[CommandStatus] = mapped_column(SQLEnum(CommandStatus), default=CommandStatus.PENDING_APPROVAL, nullable=False)
    issuer_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    expiry_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    signed_payload: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    reason: Mapped[str] = mapped_column(String(255), nullable=False)
    evidence_reference: Mapped[str] = mapped_column(String(255), nullable=False)
    execution_report: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    executed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    product = relationship("FinishedProduct")
    issuer = relationship("User")

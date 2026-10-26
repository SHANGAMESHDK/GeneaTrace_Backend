from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from sqlalchemy import DateTime, Enum as SQLEnum, Integer, String, JSON
from sqlalchemy.orm import Mapped, mapped_column
from backend.app.models.base import Base, TimestampMixin, UUIDMixin


class CheckpointStatus(str, Enum):
    PENDING = "PENDING"
    CONFIRMED = "CONFIRMED"
    FAILED = "FAILED"


class BlockchainCheckpoint(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "blockchain_checkpoints"

    checkpoint_id: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    merkle_root: Mapped[str] = mapped_column(String(66), nullable=False, index=True)
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False, default=31337)
    contract_address: Mapped[Optional[str]] = mapped_column(String(42), nullable=True)
    transaction_hash: Mapped[Optional[str]] = mapped_column(String(66), nullable=True, index=True)
    block_number: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    status: Mapped[CheckpointStatus] = mapped_column(
        SQLEnum(CheckpointStatus), default=CheckpointStatus.PENDING, nullable=False
    )
    error_message: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    batch_ids: Mapped[Optional[List[str]]] = mapped_column(JSON, nullable=True)
    event_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

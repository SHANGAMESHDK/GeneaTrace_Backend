from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field
from backend.app.models.blockchain_record import CheckpointStatus


class CheckpointCreateRequest(BaseModel):
    batch_ids: List[str] = Field(..., description="Batches included in this Merkle-DAG checkpoint")


class CheckpointResponse(BaseModel):
    id: str
    checkpoint_id: str
    merkle_root: str
    chain_id: int
    contract_address: Optional[str] = None
    transaction_hash: Optional[str] = None
    block_number: Optional[int] = None
    status: CheckpointStatus
    batch_ids: Optional[List[str]] = None
    event_count: int
    created_at: datetime
    confirmed_at: Optional[datetime] = None
    is_mock: bool = False

    class Config:
        from_attributes = True


class BlockchainVerifyRequest(BaseModel):
    merkle_root: str
    event_payload: Optional[Dict[str, Any]] = None
    inclusion_proof: Optional[List[str]] = None


class BlockchainVerifyResponse(BaseModel):
    merkle_root: str
    anchored_on_blockchain: bool
    checkpoint_status: str
    transaction_hash: Optional[str] = None
    block_number: Optional[int] = None
    verification_passed: bool
    is_mock_network: bool
    verified_at: datetime


class BlockchainAuditResponse(BaseModel):
    total_checkpoints: int
    confirmed_checkpoints: int
    pending_checkpoints: int
    failed_checkpoints: int
    latest_checkpoint: Optional[CheckpointResponse] = None
    adapter_status: Dict[str, Any]

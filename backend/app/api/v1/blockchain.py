from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session
from backend.app.api.deps import require_permission
from backend.app.db.postgres import get_db
from backend.app.schemas.blockchain import (
    BlockchainAuditResponse,
    BlockchainVerifyRequest,
    BlockchainVerifyResponse,
    CheckpointCreateRequest,
    CheckpointResponse,
)
from backend.app.services.blockchain_service import blockchain_service

router = APIRouter(prefix="/blockchain", tags=["Blockchain Checkpoints & Verification"])


@router.post("/checkpoints", response_model=CheckpointResponse, status_code=status.HTTP_201_CREATED)
def create_checkpoint(
    req: CheckpointCreateRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("blockchain:read")),
):
    return blockchain_service.create_checkpoint(db, req)


@router.get("/checkpoints/{checkpoint_id}", response_model=CheckpointResponse)
def get_checkpoint(checkpoint_id: str, db: Session = Depends(get_db)):
    return blockchain_service.get_checkpoint(db, checkpoint_id)


@router.post("/verify", response_model=BlockchainVerifyResponse)
def verify_root(req: BlockchainVerifyRequest):
    return blockchain_service.verify_checkpoint(req)


@router.get("/audit", response_model=BlockchainAuditResponse)
def get_blockchain_audit(db: Session = Depends(get_db)):
    return blockchain_service.get_audit(db)

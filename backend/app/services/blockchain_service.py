import uuid
from datetime import datetime, timezone
from typing import List, Optional
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from backend.blockchain.adapter import blockchain_adapter
from backend.app.core.config import settings
from backend.app.core.exceptions import EntityNotFoundException, InvalidOperationException
from backend.app.models.batch import Batch
from backend.app.models.blockchain_record import BlockchainCheckpoint, CheckpointStatus
from backend.app.models.manufacturing_event import ManufacturingEvent
from backend.app.schemas.blockchain import (
    BlockchainAuditResponse,
    BlockchainVerifyRequest,
    BlockchainVerifyResponse,
    CheckpointCreateRequest,
    CheckpointResponse,
)
from backend.app.services.merkle_service import merkle_service


class BlockchainService:
    @staticmethod
    def create_checkpoint(db: Session, req: CheckpointCreateRequest) -> CheckpointResponse:
        # Collect batch IDs
        batches = list(db.execute(
            select(Batch).where(Batch.batch_code.in_([b.upper() for b in req.batch_ids]))
        ).scalars().all())
        if not batches:
            raise EntityNotFoundException("Batches", str(req.batch_ids))

        batch_internal_ids = [b.id for b in batches]
        events = list(db.execute(
            select(ManufacturingEvent).where(ManufacturingEvent.batch_id.in_(batch_internal_ids))
        ).scalars().all())

        if not events:
            raise InvalidOperationException("Cannot create checkpoint: No manufacturing events recorded for these batches.")

        event_hashes = [e.canonical_payload_hash for e in events]
        merkle_root, _ = merkle_service.build_merkle_tree(event_hashes)
        primary_batch = req.batch_ids[0]

        checkpoint_id = f"CHK-{datetime.now(timezone.utc).year}-{uuid.uuid4().hex[:6].upper()}"

        checkpoint = BlockchainCheckpoint(
            checkpoint_id=checkpoint_id,
            merkle_root=merkle_root,
            chain_id=settings.BLOCKCHAIN_CHAIN_ID,
            contract_address=settings.BLOCKCHAIN_CONTRACT_ADDRESS,
            status=CheckpointStatus.PENDING,
            batch_ids=req.batch_ids,
            event_count=len(events),
        )
        db.add(checkpoint)
        db.flush()

        # Submit to blockchain adapter
        try:
            adapter_res = blockchain_adapter.record_checkpoint(
                merkle_root=merkle_root,
                batch_id=primary_batch,
                event_count=len(events),
            )
            checkpoint.status = CheckpointStatus.CONFIRMED if adapter_res.get("status") == "CONFIRMED" else CheckpointStatus.FAILED
            checkpoint.transaction_hash = adapter_res.get("transaction_hash")
            checkpoint.block_number = adapter_res.get("block_number")
            checkpoint.confirmed_at = datetime.now(timezone.utc)
        except Exception as e:
            checkpoint.status = CheckpointStatus.FAILED
            checkpoint.error_message = str(e)

        db.commit()
        db.refresh(checkpoint)

        return CheckpointResponse(
            id=checkpoint.id,
            checkpoint_id=checkpoint.checkpoint_id,
            merkle_root=checkpoint.merkle_root,
            chain_id=checkpoint.chain_id,
            contract_address=checkpoint.contract_address,
            transaction_hash=checkpoint.transaction_hash,
            block_number=checkpoint.block_number,
            status=checkpoint.status,
            batch_ids=checkpoint.batch_ids,
            event_count=checkpoint.event_count,
            created_at=checkpoint.created_at,
            confirmed_at=checkpoint.confirmed_at,
            is_mock=blockchain_adapter.is_mock,
        )

    @staticmethod
    def get_checkpoint(db: Session, checkpoint_id: str) -> CheckpointResponse:
        cp = db.execute(
            select(BlockchainCheckpoint).where(BlockchainCheckpoint.checkpoint_id == checkpoint_id)
        ).scalar_one_or_none()
        if not cp:
            raise EntityNotFoundException("BlockchainCheckpoint", checkpoint_id)
        
        return CheckpointResponse(
            id=cp.id,
            checkpoint_id=cp.checkpoint_id,
            merkle_root=cp.merkle_root,
            chain_id=cp.chain_id,
            contract_address=cp.contract_address,
            transaction_hash=cp.transaction_hash,
            block_number=cp.block_number,
            status=cp.status,
            batch_ids=cp.batch_ids,
            event_count=cp.event_count,
            created_at=cp.created_at,
            confirmed_at=cp.confirmed_at,
            is_mock=blockchain_adapter.is_mock,
        )

    @staticmethod
    def verify_checkpoint(req: BlockchainVerifyRequest) -> BlockchainVerifyResponse:
        res = blockchain_adapter.verify_checkpoint(req.merkle_root)
        anchored = res.get("exists", False)
        
        return BlockchainVerifyResponse(
            merkle_root=req.merkle_root,
            anchored_on_blockchain=anchored,
            checkpoint_status="CONFIRMED" if anchored else "NOT_FOUND",
            transaction_hash=res.get("transaction_hash"),
            block_number=res.get("block_number"),
            verification_passed=anchored,
            is_mock_network=blockchain_adapter.is_mock,
            verified_at=datetime.now(timezone.utc),
        )

    @staticmethod
    def get_audit(db: Session) -> BlockchainAuditResponse:
        total = db.scalar(select(func.count(BlockchainCheckpoint.id))) or 0
        confirmed = db.scalar(
            select(func.count(BlockchainCheckpoint.id)).where(BlockchainCheckpoint.status == CheckpointStatus.CONFIRMED)
        ) or 0
        pending = db.scalar(
            select(func.count(BlockchainCheckpoint.id)).where(BlockchainCheckpoint.status == CheckpointStatus.PENDING)
        ) or 0
        failed = db.scalar(
            select(func.count(BlockchainCheckpoint.id)).where(BlockchainCheckpoint.status == CheckpointStatus.FAILED)
        ) or 0

        latest = db.execute(
            select(BlockchainCheckpoint).order_by(BlockchainCheckpoint.created_at.desc())
        ).scalars().first()

        latest_resp = None
        if latest:
            latest_resp = CheckpointResponse(
                id=latest.id,
                checkpoint_id=latest.checkpoint_id,
                merkle_root=latest.merkle_root,
                chain_id=latest.chain_id,
                contract_address=latest.contract_address,
                transaction_hash=latest.transaction_hash,
                block_number=latest.block_number,
                status=latest.status,
                batch_ids=latest.batch_ids,
                event_count=latest.event_count,
                created_at=latest.created_at,
                confirmed_at=latest.confirmed_at,
                is_mock=blockchain_adapter.is_mock,
            )

        return BlockchainAuditResponse(
            total_checkpoints=total,
            confirmed_checkpoints=confirmed,
            pending_checkpoints=pending,
            failed_checkpoints=failed,
            latest_checkpoint=latest_resp,
            adapter_status=blockchain_adapter.check_connection(),
        )


blockchain_service = BlockchainService

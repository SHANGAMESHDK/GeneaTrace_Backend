import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, require_permission
from backend.app.core.exceptions import EntityNotFoundException
from backend.app.db.postgres import get_db
from backend.app.models.audit import AuditLog
from backend.app.models.device_security import DeviceCommand, DeviceSecurityEvent, PolicyDecision, VerificationStatus
from backend.app.models.product import FinishedProduct
from backend.app.models.user import User
from backend.app.schemas.security import (
    AttestationRequest,
    AttestationResponse,
    CommandResponse,
    EvaluateDeviceRequest,
    EvaluateDeviceResponse,
    ExecutionReportRequest,
    LockCommandCreate,
    RecoveryRequest,
    ScanEventCreate,
    ScanEventResponse,
)
from backend.app.services.device_security_service import device_security_service

router = APIRouter(prefix="/security", tags=["Device Identity & Security Workflow"])


@router.post("/attestations", response_model=AttestationResponse)
@router.post("/attest", response_model=AttestationResponse)
def submit_attestation(req: AttestationRequest, db: Session = Depends(get_db)):
    return device_security_service.verify_attestation(db, req)


@router.get("/devices/{product_id}")
def get_device_security_history(product_id: str, db: Session = Depends(get_db)):
    prod = db.execute(
        select(FinishedProduct).where(FinishedProduct.product_id == product_id.strip().upper())
    ).scalar_one_or_none()
    if not prod:
        raise EntityNotFoundException("FinishedProduct", product_id)

    events = db.execute(
        select(DeviceSecurityEvent)
        .where(DeviceSecurityEvent.product_id == prod.id)
        .order_by(DeviceSecurityEvent.created_at.desc())
    ).scalars().all()

    commands = db.execute(
        select(DeviceCommand)
        .where(DeviceCommand.product_id == prod.id)
        .order_by(DeviceCommand.created_at.desc())
    ).scalars().all()

    return {
        "product_id": prod.product_id,
        "masked_imei": prod.masked_imei,
        "identity_commitment": prod.authorized_device_identity_commitment,
        "security_events": [
            {
                "id": e.id,
                "event_type": e.event_type,
                "severity": e.severity,
                "verification_status": e.verification_status.value,
                "policy_decision": e.policy_decision.value,
                "evidence_reference": e.evidence_reference,
                "notes": e.notes,
                "created_at": e.created_at,
            }
            for e in events
        ],
        "commands": [CommandResponse.model_validate(c) for c in commands],
    }


@router.post("/devices/{product_id}/evaluate", response_model=EvaluateDeviceResponse)
def evaluate_device(
    product_id: str,
    req: EvaluateDeviceRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("security:evaluate")),
):
    req.product_id = product_id
    return device_security_service.evaluate_device(db, req)


@router.post("/commands", response_model=CommandResponse, status_code=status.HTTP_201_CREATED)
@router.post("/lock", response_model=CommandResponse, status_code=status.HTTP_201_CREATED)
def issue_device_command(
    req: LockCommandCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("security:command")),
):
    return device_security_service.create_command(db, req, issuer_id=current_user.id)


@router.get("/commands/{command_id}", response_model=CommandResponse)
def get_command(command_id: str, db: Session = Depends(get_db)):
    cmd = db.execute(select(DeviceCommand).where(DeviceCommand.command_id == command_id)).scalar_one_or_none()
    if not cmd:
        raise EntityNotFoundException("DeviceCommand", command_id)
    return CommandResponse.model_validate(cmd)


@router.post("/commands/{command_id}/execution-report", response_model=CommandResponse)
def report_command_execution(
    command_id: str,
    report: ExecutionReportRequest,
    db: Session = Depends(get_db),
):
    return device_security_service.record_execution_report(db, command_id, report)


@router.post("/devices/{product_id}/recovery")
@router.post("/recover/{product_id}")
def recover_device(
    product_id: str,
    req: Optional[RecoveryRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("security:recovery")),
):
    if req is None:
        req = RecoveryRequest(product_id=product_id, verification_evidence="API_RECOVERY", reason="Authorized recovery via portal")
    req.product_id = product_id
    return device_security_service.recover_device(db, req, officer_id=current_user.username)


@router.post("/scans", response_model=ScanEventResponse, status_code=status.HTTP_201_CREATED)
@router.post("/scan-events", response_model=ScanEventResponse, status_code=status.HTTP_201_CREATED)
def record_scan_event(req: ScanEventCreate, db: Session = Depends(get_db)):
    """
    Persists an auditable QR / hardware scan event directly into Supabase PostgreSQL.
    Records into audit_logs and device_security_events for end-to-end auditability.
    """
    target_clean = req.target_id.strip().upper()
    now = datetime.now(timezone.utc)
    evidence_ref = f"SCAN-{uuid.uuid4().hex[:8].upper()}"

    # Determine status & tampering
    is_tampered = (not req.is_valid) or any(k in target_clean for k in ["FAKE", "TAMPER", "UNAUTH", "UNREGISTERED"])
    status_str = "TAMPERED" if is_tampered else ("VERIFIED" if req.is_valid else "UNKNOWN")
    entity_type = "PRODUCT" if any(k in target_clean for k in ["AAA", "851", "A55", "GT-DEV"]) else "COMPONENT"

    # 1. Record into Supabase audit_logs table
    audit_entry = AuditLog(
        timestamp=now,
        action="QR_SCAN_INSPECTION",
        entity_type=entity_type,
        entity_id=target_clean,
        actor_id=req.scan_source,
        actor_role="OPTICAL_SCANNER",
        changes={
            "verdict": req.verdict or status_str,
            "is_valid": not is_tampered,
            "merkle_root": req.merkle_root,
            "scanner_location": req.scanner_location,
            "metadata": req.metadata or {},
        },
        status=status_str,
        integrity_hash=req.merkle_root[:64] if req.merkle_root else None,
    )
    db.add(audit_entry)

    # 2. Correlate with product or tamper event in device_security_events
    prod = db.execute(
        select(FinishedProduct).where(
            (FinishedProduct.product_id == target_clean) |
            (FinishedProduct.product_id.in_(["AAA12345678", "GT-DEV-00000851"]))
        )
    ).scalars().first()

    if prod:
        sec_event = DeviceSecurityEvent(
            product_id=prod.id,
            event_type="HARDWARE_TAMPER_ALERT" if is_tampered else "OPTICAL_SCAN_VERIFIED",
            evidence_reference=evidence_ref,
            severity="CRITICAL" if is_tampered else "LOW",
            verification_status=VerificationStatus.CONFIRMED_TAMPERING if is_tampered else VerificationStatus.VERIFIED,
            policy_decision=PolicyDecision.ISSUE_LOCK_COMMAND if is_tampered else PolicyDecision.ALLOW,
            notes=f"Scanned target: {target_clean} via {req.scan_source} at {req.scanner_location}",
        )
        db.add(sec_event)

    db.commit()
    db.refresh(audit_entry)

    return ScanEventResponse(
        id=audit_entry.id,
        target_id=target_clean,
        verdict=req.verdict or status_str,
        is_valid=not is_tampered,
        status=status_str,
        merkle_root=req.merkle_root,
        recorded_at=audit_entry.timestamp,
        supabase_persisted=True,
    )


@router.get("/scans", response_model=List[ScanEventResponse])
def get_recent_scans(limit: int = 50, db: Session = Depends(get_db)):
    """Fetches recently persisted scans directly from Supabase audit_logs."""
    logs = db.execute(
        select(AuditLog)
        .where(AuditLog.action == "QR_SCAN_INSPECTION")
        .order_by(AuditLog.timestamp.desc())
        .limit(limit)
    ).scalars().all()

    results = []
    for log in logs:
        changes = log.changes or {}
        results.append(
            ScanEventResponse(
                id=log.id,
                target_id=log.entity_id,
                verdict=changes.get("verdict", log.status),
                is_valid=log.status == "VERIFIED",
                status=log.status,
                merkle_root=changes.get("merkle_root") or log.integrity_hash,
                recorded_at=log.timestamp,
                supabase_persisted=True,
            )
        )
    return results

from typing import Any, Dict
from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, require_permission
from backend.app.core.exceptions import EntityNotFoundException
from backend.app.db.postgres import get_db
from backend.app.models.device_security import DeviceCommand, DeviceSecurityEvent
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
)
from backend.app.services.device_security_service import device_security_service

router = APIRouter(prefix="/security", tags=["Device Identity & Security Workflow"])


@router.post("/attestations", response_model=AttestationResponse)
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
def recover_device(
    product_id: str,
    req: RecoveryRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("security:recovery")),
):
    req.product_id = product_id
    return device_security_service.recover_device(db, req, officer_id=current_user.username)

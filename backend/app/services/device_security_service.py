import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.core.exceptions import (
    EntityNotFoundException,
    InvalidOperationException,
)
from backend.app.core.security import compute_identity_commitment
from backend.app.models.device_security import (
    CommandStatus,
    CommandType,
    DeviceCommand,
    DeviceSecurityEvent,
    PolicyDecision,
    VerificationStatus,
)
from backend.app.models.product import FinishedProduct, ProductComponentRelationship
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


class DeviceSecurityService:
    @staticmethod
    def verify_attestation(db: Session, req: AttestationRequest) -> AttestationResponse:
        prod = db.execute(
            select(FinishedProduct).where(FinishedProduct.product_id == req.product_id.strip().upper())
        ).scalar_one_or_none()
        if not prod:
            raise EntityNotFoundException("FinishedProduct", req.product_id)

        evidence_ref = f"EVD-ATT-{uuid.uuid4().hex[:8].upper()}"

        # Check reported hardware components against registered assembly relationships
        active_rels = db.execute(
            select(ProductComponentRelationship).where(
                ProductComponentRelationship.product_id == prod.id,
                ProductComponentRelationship.relationship_status == "ACTIVE",
            )
        ).scalars().all()
        registered_serials = {r.component.component_serial for r in active_rels}

        mismatched_components = []
        if req.reported_component_serials:
            for c_type, serial in req.reported_component_serials.items():
                if serial not in registered_serials:
                    mismatched_components.append(serial)

        # Policy evaluation
        if mismatched_components:
            status = VerificationStatus.SUSPICIOUS
            decision = PolicyDecision.FLAG_FOR_REVIEW
            details = {
                "reason": "Unregistered hardware components detected in attestation report.",
                "mismatched_components": mismatched_components,
            }
        else:
            status = VerificationStatus.VERIFIED
            decision = PolicyDecision.ALLOW
            details = {"attestation_valid": True, "registered_components_verified": len(registered_serials)}

        # Record auditable security event
        evt = DeviceSecurityEvent(
            product_id=prod.id,
            event_type="HARDWARE_ATTESTATION_CHECK",
            evidence_reference=evidence_ref,
            severity="LOW" if status == VerificationStatus.VERIFIED else "HIGH",
            verification_status=status,
            policy_decision=decision,
            notes=str(details),
        )
        db.add(evt)
        db.commit()

        return AttestationResponse(
            product_id=prod.product_id,
            verification_status=status,
            policy_decision=decision,
            evidence_reference=evidence_ref,
            details=details,
            timestamp=datetime.now(timezone.utc),
        )

    @staticmethod
    def evaluate_device(db: Session, req: EvaluateDeviceRequest) -> EvaluateDeviceResponse:
        prod = db.execute(
            select(FinishedProduct).where(FinishedProduct.product_id == req.product_id.strip().upper())
        ).scalar_one_or_none()
        if not prod:
            raise EntityNotFoundException("FinishedProduct", req.product_id)

        # IMEI mismatch alone must NOT automatically prove tampering
        if req.detected_event == "IMEI_MISMATCH":
            status = VerificationStatus.SUSPICIOUS
            decision = PolicyDecision.FLAG_FOR_REVIEW
            recommendation = (
                "IMEI discrepancy detected. Authorized repair, motherboard replacement, or data synchronization "
                "latency should be verified before any restriction. Quarantine device telemetry only."
            )
            action_req = False
        elif req.detected_event == "CONFIRMED_HARDWARE_TAMPERING":
            status = VerificationStatus.CONFIRMED_TAMPERING
            decision = PolicyDecision.ISSUE_LOCK_COMMAND
            recommendation = "Cryptographic identity commitment violated. Issue authorized MDM lock command."
            action_req = True
        else:
            status = VerificationStatus.SUSPICIOUS
            decision = PolicyDecision.FLAG_FOR_REVIEW
            recommendation = "Maintain observation. Flag for security officer review."
            action_req = False

        sec_evt = DeviceSecurityEvent(
            product_id=prod.id,
            event_type=req.detected_event,
            evidence_reference=req.evidence_reference,
            severity="CRITICAL" if action_req else "MEDIUM",
            verification_status=status,
            policy_decision=decision,
            notes=recommendation,
        )
        db.add(sec_evt)
        db.commit()
        db.refresh(sec_evt)

        return EvaluateDeviceResponse(
            product_id=prod.product_id,
            verification_status=status,
            policy_decision=decision,
            recommendation=recommendation,
            action_required=action_req,
            security_event_id=sec_evt.id,
        )

    @staticmethod
    def create_command(db: Session, req: LockCommandCreate, issuer_id: str) -> CommandResponse:
        prod = db.execute(
            select(FinishedProduct).where(FinishedProduct.product_id == req.product_id.strip().upper())
        ).scalar_one_or_none()
        if not prod:
            raise EntityNotFoundException("FinishedProduct", req.product_id)

        command_id = f"CMD-{req.command_type.value}-{uuid.uuid4().hex[:8].upper()}"
        nonce = uuid.uuid4().hex
        expiry = datetime.now(timezone.utc) + timedelta(minutes=req.expiry_minutes)

        signed_payload = {
            "command_id": command_id,
            "product_id": prod.product_id,
            "command_type": req.command_type.value,
            "nonce": nonce,
            "expiry_iso": expiry.isoformat(),
            "reason": req.reason,
            "issuer_id": issuer_id,
            "signature": f"simulated_ecdsa_sig_{uuid.uuid4().hex}",
        }

        cmd = DeviceCommand(
            command_id=command_id,
            product_id=prod.id,
            command_type=req.command_type,
            status=CommandStatus.ISSUED,
            issuer_id=issuer_id,
            nonce=nonce,
            expiry_time=expiry,
            reason=req.reason,
            evidence_reference=req.evidence_reference,
            signed_payload=signed_payload,
        )
        db.add(cmd)
        db.commit()
        db.refresh(cmd)

        return CommandResponse.model_validate(cmd)

    @staticmethod
    def record_execution_report(
        db: Session, command_id: str, report: ExecutionReportRequest
    ) -> CommandResponse:
        cmd = db.execute(select(DeviceCommand).where(DeviceCommand.command_id == command_id)).scalar_one_or_none()
        if not cmd:
            raise EntityNotFoundException("DeviceCommand", command_id)

        # Check expiry (timezone-safe comparison)
        now = datetime.now(timezone.utc)
        expiry = cmd.expiry_time
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)

        if now > expiry:
            cmd.status = CommandStatus.EXPIRED
        elif report.success:
            cmd.status = CommandStatus.EXECUTED
            cmd.executed_at = datetime.now(timezone.utc)
        else:
            cmd.status = CommandStatus.FAILED

        cmd.execution_report = {
            "mdm_agent_id": report.mdm_agent_id,
            "success": report.success,
            "timestamp": report.execution_timestamp.isoformat(),
            "telemetry": report.telemetry or {},
            "error_message": report.error_message,
        }

        db.commit()
        db.refresh(cmd)
        return CommandResponse.model_validate(cmd)

    @staticmethod
    def recover_device(db: Session, req: RecoveryRequest, officer_id: str) -> Dict[str, Any]:
        prod = db.execute(
            select(FinishedProduct).where(FinishedProduct.product_id == req.product_id.strip().upper())
        ).scalar_one_or_none()
        if not prod:
            raise EntityNotFoundException("FinishedProduct", req.product_id)

        # Cancel any active lock commands
        active_cmds = db.execute(
            select(DeviceCommand).where(
                DeviceCommand.product_id == prod.id,
                DeviceCommand.status.in_([CommandStatus.PENDING_APPROVAL, CommandStatus.ISSUED]),
            )
        ).scalars().all()
        for c in active_cmds:
            c.status = CommandStatus.CANCELLED
            c.cancelled_at = datetime.now(timezone.utc)

        # Update commitment if new salt provided
        if req.new_commitment_salt:
            prod.authorized_device_identity_commitment = compute_identity_commitment(
                prod.product_id, req.new_commitment_salt
            )

        # Record recovery audit event
        rec_evt = DeviceSecurityEvent(
            product_id=prod.id,
            event_type="OFFICER_AUTHORIZED_RECOVERY",
            evidence_reference=f"REC-{uuid.uuid4().hex[:6].upper()}",
            severity="INFO",
            verification_status=VerificationStatus.VERIFIED,
            policy_decision=PolicyDecision.ALLOW,
            notes=f"Authorized recovery by officer {officer_id}: {req.authorized_officer_reason}",
        )
        db.add(rec_evt)
        db.commit()

        return {
            "product_id": prod.product_id,
            "recovered": True,
            "cancelled_commands": len(active_cmds),
            "status": "RESTORED_TO_NORMAL",
        }


device_security_service = DeviceSecurityService

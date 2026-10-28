from datetime import datetime
from typing import Any, Dict, Optional
from pydantic import BaseModel, Field
from backend.app.models.device_security import CommandStatus, CommandType, PolicyDecision, VerificationStatus


class AttestationRequest(BaseModel):
    product_id: str
    reported_hardware_hash: str
    attestation_signature: str
    measured_boot_state: Optional[str] = None
    reported_component_serials: Optional[Dict[str, str]] = None
    nonce: str


class AttestationResponse(BaseModel):
    product_id: str
    verification_status: VerificationStatus
    policy_decision: PolicyDecision
    evidence_reference: str
    details: Dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime


class EvaluateDeviceRequest(BaseModel):
    product_id: str
    detected_event: str  # e.g., "UNAUTHORIZED_COMPONENT_DETECTED", "ATTESTATION_MISMATCH"
    evidence_reference: str
    raw_details: Optional[Dict[str, Any]] = None


class EvaluateDeviceResponse(BaseModel):
    product_id: str
    verification_status: VerificationStatus
    policy_decision: PolicyDecision
    recommendation: str
    action_required: bool
    security_event_id: str


class LockCommandCreate(BaseModel):
    product_id: str
    command_type: CommandType = CommandType.LOCK
    reason: str
    evidence_reference: str
    expiry_minutes: int = Field(default=60, ge=5, le=1440)


class CommandResponse(BaseModel):
    id: str
    command_id: str
    product_id: str
    command_type: CommandType
    status: CommandStatus
    issuer_id: str
    nonce: str
    expiry_time: datetime
    reason: str
    evidence_reference: str
    signed_payload: Optional[Dict[str, Any]] = None
    execution_report: Optional[Dict[str, Any]] = None
    created_at: datetime
    executed_at: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ExecutionReportRequest(BaseModel):
    success: bool
    mdm_agent_id: str
    execution_timestamp: datetime
    telemetry: Optional[Dict[str, Any]] = None
    error_message: Optional[str] = None


class RecoveryRequest(BaseModel):
    product_id: str
    authorized_officer_reason: str
    replacement_component_serial: Optional[str] = None
    new_commitment_salt: Optional[str] = None


class ScanEventCreate(BaseModel):
    target_id: str
    scan_source: Optional[str] = "OPTICAL_SCANNER"
    verdict: Optional[str] = "VERIFIED"
    is_valid: Optional[bool] = True
    merkle_root: Optional[str] = None
    scanner_location: Optional[str] = "Cleanroom Complex Alpha Line 3"
    metadata: Optional[Dict[str, Any]] = None


class ScanEventResponse(BaseModel):
    id: str
    target_id: str
    verdict: str
    is_valid: bool
    status: str
    merkle_root: Optional[str] = None
    recorded_at: datetime
    supabase_persisted: bool = True

from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field
from backend.app.models.batch import ComponentType
from backend.app.models.manufacturing_event import EventResult, EventStatus


class OperationCreate(BaseModel):
    operation_code: str
    operation_name: str
    component_type: Optional[ComponentType] = None
    sequence_number: int = 1
    facility_id: Optional[str] = None
    machine_id: Optional[str] = None
    configuration: Optional[Dict[str, Any]] = None


class OperationResponse(BaseModel):
    id: str
    operation_code: str
    operation_name: str
    component_type: Optional[ComponentType] = None
    sequence_number: int
    facility_id: Optional[str] = None
    machine_id: Optional[str] = None
    configuration: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


class EventCreate(BaseModel):
    component_serial: Optional[str] = None
    product_id: Optional[str] = None
    batch_code: Optional[str] = None
    operation_code: str
    machine_id: str
    operator_id: Optional[str] = None
    started_at: datetime
    completed_at: datetime
    event_status: EventStatus = EventStatus.COMPLETED
    result: EventResult = EventResult.PASS
    measured_parameters: Optional[Dict[str, Any]] = Field(default_factory=dict)
    inspection_result: Optional[str] = None
    rework_reference: Optional[str] = None
    idempotency_key: Optional[str] = None
    source_system: str = "MES-01"
    signature_metadata: Optional[Dict[str, Any]] = None


class BulkEventCreate(BaseModel):
    events: List[EventCreate]


class EventResponse(BaseModel):
    id: str
    event_id: str
    component_id: Optional[str] = None
    component_serial: Optional[str] = None
    product_id: Optional[str] = None
    batch_id: Optional[str] = None
    operation_id: str
    operation_code: Optional[str] = None
    operation_name: Optional[str] = None
    machine_id: str
    operator_id: str
    started_at: datetime
    completed_at: datetime
    event_status: EventStatus
    result: EventResult
    measured_parameters: Optional[Dict[str, Any]] = None
    inspection_result: Optional[str] = None
    rework_reference: Optional[str] = None
    idempotency_key: Optional[str] = None
    source_system: str
    canonical_payload_hash: str
    previous_event_hash: Optional[str] = None
    signature_metadata: Optional[Dict[str, Any]] = None
    created_at: datetime

    class Config:
        from_attributes = True


class EventVerificationResult(BaseModel):
    event_id: str
    canonical_payload_hash: str
    expected_hash: str
    is_payload_valid: bool
    previous_event_hash: Optional[str] = None
    is_parent_link_valid: bool
    verification_status: str
    details: Dict[str, Any] = Field(default_factory=dict)

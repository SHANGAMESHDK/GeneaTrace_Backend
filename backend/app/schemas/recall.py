from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field
from backend.app.models.recall import RecallSeverity, RecallStatus


class RecallCreateRequest(BaseModel):
    batch_code: str
    defect_category: str
    severity: RecallSeverity = RecallSeverity.HIGH
    description: str


class RecallConfirmRequest(BaseModel):
    notes: Optional[str] = None


class RecallResolveRequest(BaseModel):
    resolution_notes: str


class RecallImpactResponse(BaseModel):
    batch_code: str
    component_type: str
    supplier_id: str
    total_batch_units: int
    affected_component_count: int
    unique_affected_product_count: int
    affected_product_ids: List[str] = []
    shipment_count: int
    delivered_count: int
    in_transit_count: int
    unresolved_distribution_count: int
    query_duration_ms: float
    data_synchronization_status: str = "SYNCHRONIZED"
    lineage_references: List[Dict[str, Any]] = []


class RecallResponse(BaseModel):
    id: str
    recall_id: str
    affected_batch_id: str
    batch_code: Optional[str] = None
    defect_category: str
    severity: RecallSeverity
    description: str
    status: RecallStatus
    created_by: str
    created_at: datetime
    confirmed_at: Optional[datetime] = None
    confirmed_by: Optional[str] = None
    resolved_at: Optional[datetime] = None
    resolved_by: Optional[str] = None
    resolution_notes: Optional[str] = None
    impact: Optional[RecallImpactResponse] = None

    class Config:
        from_attributes = True

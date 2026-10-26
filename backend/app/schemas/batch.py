from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field
from backend.app.models.batch import BatchStatus, ComponentType, QualityStatus


class BatchCreate(BaseModel):
    batch_code: str = Field(..., min_length=2, max_length=20, description="Batch identifier e.g. ABC, BTR, PCB")
    component_type: ComponentType
    planned_quantity: int = Field(default=100, ge=1, le=10000)
    supplier_id: str
    facility_id: str
    idempotency_key: Optional[str] = None


class BatchResponse(BaseModel):
    id: str
    batch_code: str
    component_type: ComponentType
    issuer_id: str
    supplier_id: str
    facility_id: str
    planned_quantity: int
    actual_quantity: int
    production_start: datetime
    production_end: Optional[datetime] = None
    status: BatchStatus
    quality_status: QualityStatus
    created_at: datetime

    class Config:
        from_attributes = True


class BatchWithSerialsResponse(BatchResponse):
    serial_range_start: str
    serial_range_end: str
    allocated_serials_sample: List[str] = []
    total_serials_allocated: int


class BatchStatusUpdate(BaseModel):
    status: Optional[BatchStatus] = None
    quality_status: Optional[QualityStatus] = None

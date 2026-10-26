from datetime import datetime
from typing import Optional
from pydantic import BaseModel
from backend.app.models.batch import ComponentType, QualityStatus
from backend.app.models.component import ComponentStatus


class ComponentCreate(BaseModel):
    component_serial: str
    component_type: ComponentType
    batch_id: str
    manufacturer_id: str
    supplier_id: str
    facility_id: str
    production_date: Optional[datetime] = None


class ComponentResponse(BaseModel):
    id: str
    component_serial: str
    component_type: ComponentType
    batch_id: str
    manufacturer_id: str
    supplier_id: str
    facility_id: str
    production_date: datetime
    status: ComponentStatus
    quality_status: QualityStatus
    created_at: datetime

    class Config:
        from_attributes = True


class ComponentStatusUpdate(BaseModel):
    status: Optional[ComponentStatus] = None
    quality_status: Optional[QualityStatus] = None

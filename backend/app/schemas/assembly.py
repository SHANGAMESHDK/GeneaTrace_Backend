from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field
from backend.app.models.product import AssemblyRelationshipStatus


class ComponentInstallItem(BaseModel):
    component_serial: str
    installation_event_id: Optional[str] = None


class ProductAssemblyRequest(BaseModel):
    product_id: str = Field(..., description="Unique product identifier e.g. GT-DEV-00000851")
    product_type: str = "SMARTPHONE"
    manufacturer_id: str
    assembly_facility_id: str
    raw_imei: Optional[str] = Field(None, description="Optional raw IMEI; will be masked and committed, NEVER exposed")
    device_salt: Optional[str] = Field(None, description="Optional salt for cryptographic commitment")
    components: List[ComponentInstallItem]


class ComponentReplacementRequest(BaseModel):
    old_component_serial: str
    new_component_serial: str
    rework_reason: str
    installation_event_id: Optional[str] = None


class InstalledComponentInfo(BaseModel):
    component_serial: str
    component_type: str
    batch_code: str
    supplier_id: str
    installation_timestamp: datetime
    relationship_status: AssemblyRelationshipStatus
    removal_timestamp: Optional[datetime] = None
    rework_reason: Optional[str] = None


class AssemblyResponse(BaseModel):
    product_id: str
    product_type: str
    manufacturing_status: str
    quality_status: str
    masked_imei: Optional[str] = None
    installed_components: List[InstalledComponentInfo] = []
    created_at: datetime

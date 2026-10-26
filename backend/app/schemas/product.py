from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel
from backend.app.models.product import PassportStatus, ProductManufacturingStatus
from backend.app.schemas.assembly import InstalledComponentInfo


class ProductCreate(BaseModel):
    product_id: str
    product_type: str = "SMARTPHONE"
    manufacturer_id: str
    assembly_facility_id: str
    raw_imei: Optional[str] = None
    device_salt: Optional[str] = None


class ProductResponse(BaseModel):
    id: str
    product_id: str
    product_type: str
    manufacturer_id: str
    assembly_facility_id: str
    manufacturing_status: ProductManufacturingStatus
    quality_status: str
    authorized_device_identity_commitment: Optional[str] = None
    masked_imei: Optional[str] = None
    passport_status: PassportStatus
    created_at: datetime
    installed_components: List[InstalledComponentInfo] = []

    class Config:
        from_attributes = True

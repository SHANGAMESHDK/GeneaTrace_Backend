from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel
from backend.app.schemas.assembly import InstalledComponentInfo
from backend.app.schemas.manufacturing import EventResponse


class ShipmentSummary(BaseModel):
    shipment_id: str
    origin: str
    destination: str
    carrier: str
    status: str
    dispatched_at: Optional[datetime] = None
    delivered_at: Optional[datetime] = None


class PassportVerificationSummary(BaseModel):
    is_tamper_free: bool
    event_hashes_verified: bool
    blockchain_anchored: bool
    checkpoint_status: Optional[str] = None
    merkle_root: Optional[str] = None
    transaction_hash: Optional[str] = None
    verification_stage_failed: Optional[str] = None


class ProductPassportInternalResponse(BaseModel):
    product_id: str
    product_type: str
    manufacturer_id: str
    assembly_facility_id: str
    manufacturing_status: str
    quality_status: str
    passport_status: str
    masked_imei: Optional[str] = None
    authorized_device_identity_commitment: Optional[str] = None
    installed_components: List[InstalledComponentInfo] = []
    manufacturing_events: List[EventResponse] = []
    shipments: List[ShipmentSummary] = []
    recall_affected: bool = False
    recall_details: Optional[Dict[str, Any]] = None
    verification: PassportVerificationSummary
    qr_pointer_url: str
    created_at: datetime


class PublicComponentSummary(BaseModel):
    component_type: str
    quality_certified: bool
    country_of_origin: Optional[str] = None


class ProductPassportPublicResponse(BaseModel):
    product_id: str
    product_type: str
    manufacturer_id: str
    assembly_date: datetime
    passport_status: str
    quality_badge: str
    component_breakdown: List[PublicComponentSummary] = []
    recall_affected: bool = False
    is_authentic: bool
    blockchain_verified: bool
    merkle_root: Optional[str] = None
    verification_message: str

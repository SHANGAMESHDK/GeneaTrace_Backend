from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel
from backend.app.models.shipment import ShipmentEventType, ShipmentStatus


class ShipmentEventCreate(BaseModel):
    event_type: ShipmentEventType
    location: str
    custody_party: str
    timestamp: Optional[datetime] = None
    notes: Optional[str] = None
    source_system: str = "LOGISTICS_PORTAL"
    verification_metadata: Optional[Dict[str, Any]] = None


class ShipmentCreate(BaseModel):
    shipment_id: str
    origin: str
    destination: str
    carrier: str
    expected_delivery: Optional[datetime] = None
    product_ids: List[str] = []
    custody_metadata: Optional[Dict[str, Any]] = None


class AddProductsToShipmentRequest(BaseModel):
    product_ids: List[str]


class ShipmentEventResponse(BaseModel):
    id: str
    event_id: str
    event_type: ShipmentEventType
    location: str
    custody_party: str
    timestamp: datetime
    notes: Optional[str] = None
    source_system: str
    verification_metadata: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


class ShipmentResponse(BaseModel):
    id: str
    shipment_id: str
    origin: str
    destination: str
    carrier: str
    dispatched_at: Optional[datetime] = None
    expected_delivery: Optional[datetime] = None
    delivered_at: Optional[datetime] = None
    status: ShipmentStatus
    custody_metadata: Optional[Dict[str, Any]] = None
    product_count: int = 0
    product_ids: List[str] = []
    events: List[ShipmentEventResponse] = []
    created_at: datetime

    class Config:
        from_attributes = True


class ShipmentTraceabilityResponse(BaseModel):
    shipment: ShipmentResponse
    products: List[Dict[str, Any]] = []
    custody_chain: List[ShipmentEventResponse] = []

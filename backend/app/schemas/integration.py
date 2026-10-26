from datetime import datetime
from typing import Any, Dict, Optional
from pydantic import BaseModel
from backend.app.models.integration import IntegrationSourceType, IntegrationStatus


class IntegrationSourceResponse(BaseModel):
    id: str
    name: str
    source_type: IntegrationSourceType
    status: IntegrationStatus
    endpoint_url: Optional[str] = None
    last_sync_at: Optional[datetime] = None
    sync_count: int
    error_count: int
    config_data: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


class IntegrationSyncRequest(BaseModel):
    integration_id: str
    trigger_mode: str = "MANUAL"

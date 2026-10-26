from typing import List
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from backend.app.db.postgres import get_db
from backend.app.schemas.integration import IntegrationSourceResponse, IntegrationSyncRequest
from backend.app.services.integration_service import integration_service

router = APIRouter(prefix="/integrations", tags=["Enterprise System Integrations (ERP/MES/SCADA/QMS)"])


@router.get("", response_model=List[IntegrationSourceResponse])
def list_integrations(db: Session = Depends(get_db)):
    return integration_service.list_sources(db)


@router.get("/{integration_id}/status", response_model=IntegrationSourceResponse)
def get_integration_status(integration_id: str, db: Session = Depends(get_db)):
    return integration_service.get_source_status(db, integration_id)


@router.post("/{integration_id}/sync", response_model=IntegrationSourceResponse)
def trigger_sync(integration_id: str, db: Session = Depends(get_db)):
    return integration_service.trigger_sync(db, integration_id)

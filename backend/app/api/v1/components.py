from typing import List, Optional
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session
from backend.app.api.deps import require_permission
from backend.app.db.postgres import get_db
from backend.app.models.batch import ComponentType
from backend.app.models.component import ComponentStatus
from backend.app.schemas.common import PaginatedResponse
from backend.app.schemas.component import ComponentCreate, ComponentResponse
from backend.app.schemas.manufacturing import EventResponse
from backend.app.services.component_service import component_service
from backend.app.services.manufacturing_service import manufacturing_service

router = APIRouter(prefix="/components", tags=["Components"])


@router.post("", response_model=ComponentResponse, status_code=status.HTTP_201_CREATED)
def register_component(
    comp_in: ComponentCreate,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("components:create")),
):
    comp = component_service.create_component(db, comp_in)
    return ComponentResponse.model_validate(comp)


@router.get("", response_model=PaginatedResponse[ComponentResponse])
def list_components(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    component_type: Optional[ComponentType] = None,
    status: Optional[ComponentStatus] = None,
    db: Session = Depends(get_db),
):
    items, total = component_service.get_components(
        db, page=page, page_size=page_size, component_type=component_type, status=status
    )
    total_pages = (total + page_size - 1) // page_size if total > 0 else 1
    return PaginatedResponse(
        items=[ComponentResponse.model_validate(c) for c in items],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.get("/{serial}", response_model=ComponentResponse)
def get_component(serial: str, db: Session = Depends(get_db)):
    comp = component_service.get_component_by_serial(db, serial)
    return ComponentResponse.model_validate(comp)


@router.get("/{serial}/events", response_model=List[EventResponse])
def get_component_events(serial: str, db: Session = Depends(get_db)):
    events = manufacturing_service.get_events_for_component(db, serial)
    return [EventResponse.model_validate(e) for e in events]

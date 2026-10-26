from typing import List, Optional
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, require_permission
from backend.app.db.postgres import get_db
from backend.app.models.batch import BatchStatus, ComponentType
from backend.app.models.user import User
from backend.app.schemas.batch import BatchCreate, BatchResponse, BatchWithSerialsResponse
from backend.app.schemas.common import PaginatedResponse
from backend.app.schemas.component import ComponentResponse
from backend.app.schemas.manufacturing import EventResponse
from backend.app.schemas.recall import RecallImpactResponse
from backend.app.services.batch_service import batch_service
from backend.app.services.manufacturing_service import manufacturing_service
from backend.app.services.recall_service import recall_service

router = APIRouter(prefix="/batches", tags=["Batches"])


@router.post("", response_model=BatchWithSerialsResponse, status_code=status.HTTP_201_CREATED)
def create_batch(
    batch_in: BatchCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("batches:create")),
):
    return batch_service.create_batch(db, batch_in, issuer_id=current_user.id)


@router.get("", response_model=PaginatedResponse[BatchResponse])
def list_batches(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    component_type: Optional[ComponentType] = None,
    batch_status: Optional[BatchStatus] = None,
    db: Session = Depends(get_db),
):
    items, total = batch_service.get_batches(
        db, page=page, page_size=page_size, component_type=component_type, status=batch_status
    )
    total_pages = (total + page_size - 1) // page_size if total > 0 else 1
    return PaginatedResponse(
        items=[BatchResponse.model_validate(b) for b in items],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.get("/{batch_code}", response_model=BatchResponse)
def get_batch(batch_code: str, db: Session = Depends(get_db)):
    batch = batch_service.get_batch_by_code(db, batch_code)
    return BatchResponse.model_validate(batch)


@router.get("/{batch_code}/serials", response_model=PaginatedResponse[ComponentResponse])
def get_batch_serials(
    batch_code: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    components, total = batch_service.get_batch_serials(db, batch_code, page=page, page_size=page_size)
    total_pages = (total + page_size - 1) // page_size if total > 0 else 1
    return PaginatedResponse(
        items=[ComponentResponse.model_validate(c) for c in components],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.get("/{batch_code}/events", response_model=List[EventResponse])
def get_batch_events(batch_code: str, db: Session = Depends(get_db)):
    events = manufacturing_service.get_events_for_batch(db, batch_code)
    return [EventResponse.model_validate(e) for e in events]


@router.get("/{batch_code}/recall-impact", response_model=RecallImpactResponse)
def get_batch_recall_impact(batch_code: str, db: Session = Depends(get_db)):
    return recall_service.calculate_batch_impact(db, batch_code)

from typing import List
from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, require_permission
from backend.app.db.postgres import get_db
from backend.app.models.manufacturing_event import ManufacturingOperation
from backend.app.models.user import User
from backend.app.schemas.manufacturing import (
    BulkEventCreate,
    EventCreate,
    EventResponse,
    OperationCreate,
    OperationResponse,
)
from backend.app.services.manufacturing_service import manufacturing_service

router = APIRouter(prefix="/manufacturing", tags=["Manufacturing Operations & Events"])


@router.post("/events", response_model=EventResponse, status_code=status.HTTP_201_CREATED)
def record_event(
    event_in: EventCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("manufacturing:create")),
):
    evt = manufacturing_service.record_event(db, event_in, operator_id=current_user.username)
    return EventResponse.model_validate(evt)


@router.post("/events/bulk", response_model=List[EventResponse], status_code=status.HTTP_201_CREATED)
def record_events_bulk(
    bulk_in: BulkEventCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("manufacturing:create")),
):
    results = []
    for evt_req in bulk_in.events:
        evt = manufacturing_service.record_event(db, evt_req, operator_id=current_user.username)
        results.append(EventResponse.model_validate(evt))
    return results


@router.get("/events/{event_id}", response_model=EventResponse)
def get_event(event_id: str, db: Session = Depends(get_db)):
    evt = manufacturing_service.get_event_by_id(db, event_id)
    return EventResponse.model_validate(evt)


@router.post("/operations", response_model=OperationResponse, status_code=status.HTTP_201_CREATED)
def create_operation(
    op_in: OperationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("manufacturing:create")),
):
    op = manufacturing_service.get_or_create_operation(
        db,
        operation_code=op_in.operation_code,
        operation_name=op_in.operation_name,
        sequence_number=op_in.sequence_number,
    )
    db.commit()
    return OperationResponse.model_validate(op)


@router.get("/operations", response_model=List[OperationResponse])
def list_operations(db: Session = Depends(get_db)):
    ops = db.execute(select(ManufacturingOperation).order_by(ManufacturingOperation.sequence_number.asc())).scalars().all()
    return [OperationResponse.model_validate(o) for o in ops]

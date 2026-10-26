from typing import List, Optional
from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, require_permission
from backend.app.db.postgres import get_db
from backend.app.models.recall import Recall, RecallStatus
from backend.app.models.user import User
from backend.app.schemas.recall import (
    RecallConfirmRequest,
    RecallCreateRequest,
    RecallImpactResponse,
    RecallResolveRequest,
    RecallResponse,
)
from backend.app.services.recall_service import recall_service

router = APIRouter(prefix="/recalls", tags=["Precision Recalls"])


@router.post("", response_model=RecallResponse, status_code=status.HTTP_201_CREATED)
def initiate_recall(
    req: RecallCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("recalls:create")),
):
    rec = recall_service.create_recall(db, req, creator_id=current_user.id)
    impact = recall_service.calculate_batch_impact(db, rec.batch.batch_code)
    resp = RecallResponse.model_validate(rec)
    resp.batch_code = rec.batch.batch_code
    resp.impact = impact
    return resp


@router.get("", response_model=List[RecallResponse])
def list_recalls(
    status: Optional[RecallStatus] = None,
    db: Session = Depends(get_db),
):
    stmt = select(Recall)
    if status:
        stmt = stmt.where(Recall.status == status)
    recalls = db.execute(stmt.order_by(Recall.created_at.desc())).scalars().all()

    results = []
    for r in recalls:
        resp = RecallResponse.model_validate(r)
        resp.batch_code = r.batch.batch_code if r.batch else "UNKNOWN"
        results.append(resp)
    return results


@router.get("/{recall_id}", response_model=RecallResponse)
def get_recall(recall_id: str, db: Session = Depends(get_db)):
    rec = db.execute(select(Recall).where(Recall.recall_id == recall_id)).scalar_one_or_none()
    if not rec:
        from backend.app.core.exceptions import EntityNotFoundException
        raise EntityNotFoundException("Recall", recall_id)

    impact = recall_service.calculate_batch_impact(db, rec.batch.batch_code)
    resp = RecallResponse.model_validate(rec)
    resp.batch_code = rec.batch.batch_code
    resp.impact = impact
    return resp


@router.post("/{recall_id}/confirm", response_model=RecallResponse)
def confirm_recall(
    recall_id: str,
    req: RecallConfirmRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("recalls:confirm")),
):
    rec = recall_service.confirm_recall(db, recall_id, confirmer_id=current_user.id, req=req)
    impact = recall_service.calculate_batch_impact(db, rec.batch.batch_code)
    resp = RecallResponse.model_validate(rec)
    resp.batch_code = rec.batch.batch_code
    resp.impact = impact
    return resp


@router.post("/{recall_id}/resolve", response_model=RecallResponse)
def resolve_recall(
    recall_id: str,
    req: RecallResolveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("recalls:resolve")),
):
    rec = recall_service.resolve_recall(db, recall_id, resolver_id=current_user.id, req=req)
    impact = recall_service.calculate_batch_impact(db, rec.batch.batch_code)
    resp = RecallResponse.model_validate(rec)
    resp.batch_code = rec.batch.batch_code
    resp.impact = impact
    return resp


@router.get("/{recall_id}/impact", response_model=RecallImpactResponse)
def get_recall_impact(recall_id: str, db: Session = Depends(get_db)):
    rec = db.execute(select(Recall).where(Recall.recall_id == recall_id)).scalar_one_or_none()
    if not rec:
        from backend.app.core.exceptions import EntityNotFoundException
        raise EntityNotFoundException("Recall", recall_id)
    return recall_service.calculate_batch_impact(db, rec.batch.batch_code)


@router.get("/exposure/{batch_code}", response_model=RecallImpactResponse)
def get_batch_recall_exposure(batch_code: str, db: Session = Depends(get_db)):
    """Frontend compatibility alias for batch recall impact analysis"""
    return recall_service.calculate_batch_impact(db, batch_code)


@router.post("/trigger", response_model=RecallResponse, status_code=status.HTTP_201_CREATED)
def trigger_recall_alias(
    req: RecallCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("recalls:create")),
):
    """Frontend compatibility alias for initiating a precision recall"""
    rec = recall_service.create_recall(db, req, creator_id=current_user.id)
    impact = recall_service.calculate_batch_impact(db, rec.batch.batch_code)
    resp = RecallResponse.model_validate(rec)
    resp.batch_code = rec.batch.batch_code
    resp.impact = impact
    return resp


@router.get("/{recall_id}/export")
def export_recall_csv(recall_id: str, db: Session = Depends(get_db)):
    csv_data = recall_service.export_recall_csv(db, recall_id)
    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=recall_{recall_id}_impact.csv"},
    )

from typing import List
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from backend.app.db.postgres import get_db
from backend.app.schemas.dashboard import (
    BatchDistributionMetric,
    DashboardSummaryResponse,
    DefectRateMetric,
    ManufacturingOutputMetric,
    RecallExposureMetric,
)
from backend.app.schemas.manufacturing import EventResponse
from backend.app.services.dashboard_service import dashboard_service

router = APIRouter(prefix="/dashboard", tags=["Operational Dashboard"])


@router.get("/summary", response_model=DashboardSummaryResponse)
@router.get("/metrics", response_model=DashboardSummaryResponse)
def get_dashboard_summary(db: Session = Depends(get_db)):
    return dashboard_service.get_summary(db)


@router.get("/manufacturing-output", response_model=List[ManufacturingOutputMetric])
def get_manufacturing_output(db: Session = Depends(get_db)):
    return dashboard_service.get_manufacturing_output(db)


@router.get("/defect-rates", response_model=List[DefectRateMetric])
def get_defect_rates(db: Session = Depends(get_db)):
    return dashboard_service.get_defect_rates(db)


@router.get("/batch-distribution", response_model=List[BatchDistributionMetric])
def get_batch_distribution(db: Session = Depends(get_db)):
    return dashboard_service.get_batch_distribution(db)


@router.get("/recall-exposure", response_model=List[RecallExposureMetric])
def get_recall_exposure(db: Session = Depends(get_db)):
    return dashboard_service.get_recall_exposure(db)


@router.get("/recent-events", response_model=List[EventResponse])
def get_recent_events(limit: int = Query(default=15, ge=1, le=100), db: Session = Depends(get_db)):
    return dashboard_service.get_recent_events(db, limit=limit)

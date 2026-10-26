from datetime import datetime
from typing import Any, Dict, List
from pydantic import BaseModel


class DashboardSummaryResponse(BaseModel):
    total_components: int
    total_batches: int
    total_products_assembled: int
    active_recalls: int
    blockchain_checkpoints: int
    pass_rate_percentage: float
    total_manufacturing_events: int
    graph_health: str
    blockchain_health: str


class ManufacturingOutputMetric(BaseModel):
    date: str
    component_type: str
    output_count: int
    pass_rate: float


class DefectRateMetric(BaseModel):
    component_type: str
    inspected_count: int
    defective_count: int
    defect_percentage: float


class BatchDistributionMetric(BaseModel):
    batch_code: str
    component_type: str
    planned_quantity: int
    actual_quantity: int
    status: str


class RecallExposureMetric(BaseModel):
    recall_id: str
    batch_code: str
    affected_components: int
    affected_products: int
    affected_shipments: int
    severity: str
    status: str

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


class TraceabilityQueryRequest(BaseModel):
    entity_type: Literal["batch", "component", "product", "shipment"]
    entity_id: str
    direction: Literal["forward", "backward"] = "forward"
    include: List[str] = Field(
        default=["components", "manufacturing_events", "finished_products", "shipments"]
    )
    depth_limit: int = Field(default=10, ge=1, le=50)


class LineageNode(BaseModel):
    id: str
    label: str
    type: str  # Batch, Component, ManufacturingEvent, FinishedProduct, Shipment
    properties: Dict[str, Any] = Field(default_factory=dict)


class LineageEdge(BaseModel):
    id: str
    source: str
    target: str
    relationship_type: str  # BELONGS_TO_BATCH, PROCESSED_BY, INSTALLED_IN, INCLUDED_IN_SHIPMENT, etc.
    properties: Dict[str, Any] = Field(default_factory=dict)


class TraceabilityResultResponse(BaseModel):
    entity_type: str
    entity_id: str
    direction: str
    nodes: List[LineageNode] = []
    edges: List[LineageEdge] = []
    summary: Dict[str, int] = Field(default_factory=dict)
    query_duration_ms: float
    graph_data_source: str  # "neo4j" or "postgresql_recursive_fallback"
    graph_synchronized: bool = True
    verification_status: str = "VERIFIED"

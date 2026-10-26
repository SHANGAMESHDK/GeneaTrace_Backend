from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session
from backend.app.api.deps import require_permission
from backend.app.db.postgres import get_db
from backend.app.schemas.assembly import (
    AssemblyResponse,
    ComponentReplacementRequest,
    ProductAssemblyRequest,
)
from backend.app.services.assembly_service import assembly_service

router = APIRouter(prefix="/assembly", tags=["Smartphone Assembly"])


@router.post("", response_model=AssemblyResponse, status_code=status.HTTP_201_CREATED)
def assemble_product(
    req: ProductAssemblyRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("assembly:create")),
):
    return assembly_service.assemble_product(db, req)


@router.post("/{product_id}/replace-component", response_model=AssemblyResponse)
def replace_component(
    product_id: str,
    req: ComponentReplacementRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("assembly:create")),
):
    return assembly_service.replace_component(db, product_id, req)

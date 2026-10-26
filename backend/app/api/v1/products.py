from typing import List, Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from backend.app.core.exceptions import EntityNotFoundException
from backend.app.db.postgres import get_db
from backend.app.models.product import FinishedProduct
from backend.app.schemas.assembly import InstalledComponentInfo
from backend.app.schemas.common import PaginatedResponse
from backend.app.schemas.product import ProductResponse

router = APIRouter(prefix="/products", tags=["Finished Products"])


@router.get("", response_model=PaginatedResponse[ProductResponse])
def list_products(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    total = db.scalar(select(func.count(FinishedProduct.id))) or 0
    products = db.execute(
        select(FinishedProduct)
        .order_by(FinishedProduct.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).scalars().all()

    total_pages = (total + page_size - 1) // page_size if total > 0 else 1

    items = []
    for p in products:
        comps = [
            InstalledComponentInfo(
                component_serial=r.component.component_serial,
                component_type=r.component.component_type.value,
                batch_code=r.component.batch.batch_code if r.component.batch else "",
                supplier_id=r.component.supplier_id,
                installation_timestamp=r.installation_timestamp,
                relationship_status=r.relationship_status,
                removal_timestamp=r.removal_timestamp,
                rework_reason=r.rework_reason,
            )
            for r in p.component_relationships
        ]
        items.append(
            ProductResponse(
                id=p.id,
                product_id=p.product_id,
                product_type=p.product_type,
                manufacturer_id=p.manufacturer_id,
                assembly_facility_id=p.assembly_facility_id,
                manufacturing_status=p.manufacturing_status,
                quality_status=p.quality_status,
                authorized_device_identity_commitment=p.authorized_device_identity_commitment,
                masked_imei=p.masked_imei,
                passport_status=p.passport_status,
                created_at=p.created_at,
                installed_components=comps,
            )
        )

    return PaginatedResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.get("/{product_id}", response_model=ProductResponse)
def get_product(product_id: str, db: Session = Depends(get_db)):
    p = db.execute(
        select(FinishedProduct).where(FinishedProduct.product_id == product_id.strip().upper())
    ).scalar_one_or_none()
    if not p:
        raise EntityNotFoundException("FinishedProduct", product_id)

    comps = [
        InstalledComponentInfo(
            component_serial=r.component.component_serial,
            component_type=r.component.component_type.value,
            batch_code=r.component.batch.batch_code if r.component.batch else "",
            supplier_id=r.component.supplier_id,
            installation_timestamp=r.installation_timestamp,
            relationship_status=r.relationship_status,
            removal_timestamp=r.removal_timestamp,
            rework_reason=r.rework_reason,
        )
        for r in p.component_relationships
    ]

    return ProductResponse(
        id=p.id,
        product_id=p.product_id,
        product_type=p.product_type,
        manufacturer_id=p.manufacturer_id,
        assembly_facility_id=p.assembly_facility_id,
        manufacturing_status=p.manufacturing_status,
        quality_status=p.quality_status,
        authorized_device_identity_commitment=p.authorized_device_identity_commitment,
        masked_imei=p.masked_imei,
        passport_status=p.passport_status,
        created_at=p.created_at,
        installed_components=comps,
    )

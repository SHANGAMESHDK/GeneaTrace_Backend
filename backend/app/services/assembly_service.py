from datetime import datetime, timezone
from typing import List, Optional
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.core.exceptions import (
    DuplicateEntityException,
    EntityNotFoundException,
    InvalidOperationException,
)
from backend.app.core.security import compute_identity_commitment, mask_imei
from backend.app.models.component import Component, ComponentStatus
from backend.app.models.product import (
    AssemblyRelationshipStatus,
    FinishedProduct,
    PassportStatus,
    ProductComponentRelationship,
    ProductManufacturingStatus,
)
from backend.app.schemas.assembly import (
    AssemblyResponse,
    ComponentReplacementRequest,
    InstalledComponentInfo,
    ProductAssemblyRequest,
)


class AssemblyService:
    @staticmethod
    def assemble_product(db: Session, req: ProductAssemblyRequest) -> AssemblyResponse:
        # Check if product_id already exists
        existing = db.execute(
            select(FinishedProduct).where(FinishedProduct.product_id == req.product_id.strip().upper())
        ).scalar_one_or_none()
        if existing:
            raise DuplicateEntityException("FinishedProduct", req.product_id)

        # Cryptographic commitment and masking for IMEI
        salt = req.device_salt or "geneatrace_device_salt"
        commitment = compute_identity_commitment(req.product_id, salt) if req.raw_imei else None
        masked_imei_val = mask_imei(req.raw_imei) if req.raw_imei else None

        product = FinishedProduct(
            product_id=req.product_id.strip().upper(),
            product_type=req.product_type,
            manufacturer_id=req.manufacturer_id,
            assembly_facility_id=req.assembly_facility_id,
            manufacturing_status=ProductManufacturingStatus.ASSEMBLED,
            quality_status="PASSED",
            authorized_device_identity_commitment=commitment,
            masked_imei=masked_imei_val,
            passport_status=PassportStatus.PUBLISHED,
        )
        db.add(product)
        db.flush()

        installed_info_list: List[InstalledComponentInfo] = []

        for item in req.components:
            comp = db.execute(
                select(Component).where(Component.component_serial == item.component_serial.strip().upper())
            ).scalar_one_or_none()
            if not comp:
                raise EntityNotFoundException("Component", item.component_serial)

            # Create assembly relationship
            rel = ProductComponentRelationship(
                product_id=product.id,
                component_id=comp.id,
                installation_event_id=item.installation_event_id,
                installation_timestamp=datetime.now(timezone.utc),
                relationship_status=AssemblyRelationshipStatus.ACTIVE,
            )
            db.add(rel)
            comp.status = ComponentStatus.INSTALLED
            db.flush()

            installed_info_list.append(
                InstalledComponentInfo(
                    component_serial=comp.component_serial,
                    component_type=comp.component_type.value,
                    batch_code=comp.batch.batch_code if comp.batch else "",
                    supplier_id=comp.supplier_id,
                    installation_timestamp=rel.installation_timestamp,
                    relationship_status=rel.relationship_status,
                )
            )

        db.commit()
        db.refresh(product)

        return AssemblyResponse(
            product_id=product.product_id,
            product_type=product.product_type,
            manufacturing_status=product.manufacturing_status.value,
            quality_status=product.quality_status,
            masked_imei=product.masked_imei,
            installed_components=installed_info_list,
            created_at=product.created_at,
        )

    @staticmethod
    def replace_component(
        db: Session,
        product_id: str,
        req: ComponentReplacementRequest,
    ) -> AssemblyResponse:
        product = db.execute(
            select(FinishedProduct).where(FinishedProduct.product_id == product_id.strip().upper())
        ).scalar_one_or_none()
        if not product:
            raise EntityNotFoundException("FinishedProduct", product_id)

        old_comp = db.execute(
            select(Component).where(Component.component_serial == req.old_component_serial.strip().upper())
        ).scalar_one_or_none()
        if not old_comp:
            raise EntityNotFoundException("Component", req.old_component_serial)

        new_comp = db.execute(
            select(Component).where(Component.component_serial == req.new_component_serial.strip().upper())
        ).scalar_one_or_none()
        if not new_comp:
            raise EntityNotFoundException("Component", req.new_component_serial)

        # Find existing active relationship
        existing_rel = db.execute(
            select(ProductComponentRelationship)
            .where(
                ProductComponentRelationship.product_id == product.id,
                ProductComponentRelationship.component_id == old_comp.id,
                ProductComponentRelationship.relationship_status == AssemblyRelationshipStatus.ACTIVE,
            )
        ).scalar_one_or_none()

        if not existing_rel:
            raise InvalidOperationException(
                f"Component '{req.old_component_serial}' is not currently active on product '{product_id}'."
            )

        # Deactivate old component without erasing history
        existing_rel.relationship_status = AssemblyRelationshipStatus.REPLACED
        existing_rel.removal_timestamp = datetime.now(timezone.utc)
        existing_rel.rework_reason = req.rework_reason
        old_comp.status = ComponentStatus.REPLACED

        # Add new active component
        new_rel = ProductComponentRelationship(
            product_id=product.id,
            component_id=new_comp.id,
            installation_event_id=req.installation_event_id,
            installation_timestamp=datetime.now(timezone.utc),
            relationship_status=AssemblyRelationshipStatus.ACTIVE,
            rework_reason=f"Replacement for {old_comp.component_serial}: {req.rework_reason}",
        )
        db.add(new_rel)
        new_comp.status = ComponentStatus.INSTALLED

        db.commit()
        db.refresh(product)

        # Build current components list
        all_rels = db.execute(
            select(ProductComponentRelationship)
            .where(ProductComponentRelationship.product_id == product.id)
            .order_by(ProductComponentRelationship.installation_timestamp.asc())
        ).scalars().all()

        installed_info_list = [
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
            for r in all_rels
        ]

        return AssemblyResponse(
            product_id=product.product_id,
            product_type=product.product_type,
            manufacturing_status=product.manufacturing_status.value,
            quality_status=product.quality_status,
            masked_imei=product.masked_imei,
            installed_components=installed_info_list,
            created_at=product.created_at,
        )


assembly_service = AssemblyService

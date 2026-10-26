from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user
from backend.app.db.postgres import get_db
from backend.app.models.user import User
from backend.app.schemas.passport import (
    ProductPassportInternalResponse,
    ProductPassportPublicResponse,
)
from backend.app.services.passport_service import passport_service

router = APIRouter(prefix="/passports", tags=["Digital Product Passports"])


@router.get("/{product_id}", response_model=ProductPassportInternalResponse)
def get_internal_passport(
    product_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return passport_service.get_internal_passport(db, product_id)


@router.get("/{product_id}/public", response_model=ProductPassportPublicResponse)
def get_public_passport(product_id: str, db: Session = Depends(get_db)):
    """
    Publicly accessible passport endpoint for consumers / verifiers.
    Sanitized to exclude internal serials, raw parameters, and PII.
    """
    return passport_service.get_public_passport(db, product_id)


@router.get("/{product_id}/verify", response_model=ProductPassportPublicResponse)
def verify_passport(product_id: str, db: Session = Depends(get_db)):
    """
    Public cryptographic authenticity check.
    """
    return passport_service.get_public_passport(db, product_id)

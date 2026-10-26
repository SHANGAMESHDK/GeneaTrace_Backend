import uuid
from datetime import datetime, timezone
from typing import List, Optional
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.core.exceptions import EntityNotFoundException
from backend.app.models.integration import IntegrationSource, IntegrationSourceType, IntegrationStatus
from backend.app.schemas.integration import IntegrationSourceResponse


class IntegrationService:
    @staticmethod
    def list_sources(db: Session) -> List[IntegrationSourceResponse]:
        sources = db.execute(select(IntegrationSource)).scalars().all()
        return [IntegrationSourceResponse.model_validate(s) for s in sources]

    @staticmethod
    def get_source_status(db: Session, source_id: str) -> IntegrationSourceResponse:
        source = db.execute(select(IntegrationSource).where(IntegrationSource.id == source_id)).scalar_one_or_none()
        if not source:
            source = db.execute(select(IntegrationSource).where(IntegrationSource.name == source_id)).scalar_one_or_none()
        if not source:
            raise EntityNotFoundException("IntegrationSource", source_id)
        return IntegrationSourceResponse.model_validate(source)

    @staticmethod
    def trigger_sync(db: Session, source_id: str) -> IntegrationSourceResponse:
        source = db.execute(select(IntegrationSource).where(IntegrationSource.id == source_id)).scalar_one_or_none()
        if not source:
            source = db.execute(select(IntegrationSource).where(IntegrationSource.name == source_id)).scalar_one_or_none()
        if not source:
            raise EntityNotFoundException("IntegrationSource", source_id)

        source.last_sync_at = datetime.now(timezone.utc)
        source.sync_count += 1
        db.commit()
        db.refresh(source)
        return IntegrationSourceResponse.model_validate(source)


integration_service = IntegrationService

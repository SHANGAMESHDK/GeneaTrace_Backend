import pytest
from backend.app.core.exceptions import DuplicateEntityException
from backend.app.models.batch import Batch, ComponentType
from backend.app.services.serial_service import serial_service


def test_batch_serial_allocation_100_units(db):
    batch = Batch(
        batch_code="ABC",
        component_type=ComponentType.DISPLAY,
        issuer_id="user-01",
        supplier_id="sup-01",
        facility_id="fac-01",
        planned_quantity=100,
    )
    db.add(batch)
    db.commit()
    db.refresh(batch)

    components = serial_service.allocate_batch_serials(db, batch, 100)
    db.commit()

    assert len(components) == 100
    assert components[0].component_serial == "ABC-0001"
    assert components[-1].component_serial == "ABC-0100"

    # All serials must be unique
    serials = [c.component_serial for c in components]
    assert len(set(serials)) == 100


def test_battery_serial_allocation(db):
    batch = Batch(
        batch_code="BTR",
        component_type=ComponentType.BATTERY,
        issuer_id="user-01",
        supplier_id="sup-01",
        facility_id="fac-01",
        planned_quantity=50,
    )
    db.add(batch)
    db.commit()

    components = serial_service.allocate_batch_serials(db, batch, 50)
    db.commit()

    assert len(components) == 50
    assert components[0].component_serial == "BTR-0001"
    assert components[-1].component_serial == "BTR-0050"

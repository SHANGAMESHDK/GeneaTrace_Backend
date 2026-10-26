import pytest
from backend.app.models.manufacturing_event import ManufacturingEvent
from backend.app.services.merkle_service import merkle_service


def test_canonical_event_hashing_deterministic():
    event_dict_1 = {
        "event_id": "EVT-TEST-001",
        "operation_id": "OP-01",
        "machine_id": "MACH-01",
        "operator_id": "OPER-01",
        "started_at": "2026-10-26T12:00:00Z",
        "completed_at": "2026-10-26T12:15:00Z",
        "event_status": "COMPLETED",
        "result": "PASS",
        "measured_parameters": {"temp": 45.2, "pressure": 1.2},
        "source_system": "MES-01",
    }
    # Reverse dictionary order
    event_dict_2 = {
        "source_system": "MES-01",
        "measured_parameters": {"pressure": 1.2, "temp": 45.2},
        "result": "PASS",
        "event_status": "COMPLETED",
        "completed_at": "2026-10-26T12:15:00Z",
        "started_at": "2026-10-26T12:00:00Z",
        "operator_id": "OPER-01",
        "machine_id": "MACH-01",
        "operation_id": "OP-01",
        "event_id": "EVT-TEST-001",
    }
    hash_1 = merkle_service.compute_event_hash(event_dict_1)
    hash_2 = merkle_service.compute_event_hash(event_dict_2)

    assert hash_1 == hash_2
    assert len(hash_1) == 64


def test_tamper_detection_in_event_verification():
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)

    event_payload = {
        "event_id": "EVT-TAMPER-001",
        "operation_id": "OP-01",
        "machine_id": "MACH-01",
        "operator_id": "OPER-01",
        "started_at": now,
        "completed_at": now,
        "event_status": "COMPLETED",
        "result": "PASS",
        "measured_parameters": {"voltage": 3.8},
        "source_system": "MES-01",
    }
    valid_hash = merkle_service.compute_event_hash(event_payload)

    # Valid event record
    event = ManufacturingEvent(
        event_id="EVT-TAMPER-001",
        operation_id="OP-01",
        machine_id="MACH-01",
        operator_id="OPER-01",
        started_at=now,
        completed_at=now,
        event_status="COMPLETED",
        result="PASS",
        measured_parameters={"voltage": 3.8},
        source_system="MES-01",
        canonical_payload_hash=valid_hash,
    )
    res_valid = merkle_service.verify_event_record(event)
    assert res_valid.is_payload_valid is True

    # Tampered event: voltage modified from 3.8 to 4.5
    event.measured_parameters = {"voltage": 4.5}
    res_tampered = merkle_service.verify_event_record(event)
    assert res_tampered.is_payload_valid is False
    assert "payload_error" in res_tampered.details


def test_merkle_tree_proof_generation_and_verification():
    leaves = [
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
        "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d",
        "2e7d2c03a9507ae265ecf5b5356885a53393a2029d24139499726b4259fb79c0",
    ]
    root, levels = merkle_service.build_merkle_tree(leaves)
    assert root is not None
    assert len(root) == 64

    # Generate proof for leaf #2
    target_leaf = leaves[2]
    proof = merkle_service.generate_proof(target_leaf, leaves)
    assert len(proof) > 0

    # Verify proof against root
    is_valid = merkle_service.verify_proof(target_leaf, proof, root)
    assert is_valid is True

    # Tampered root verification fails
    assert merkle_service.verify_proof(target_leaf, proof, "0" * 64) is False

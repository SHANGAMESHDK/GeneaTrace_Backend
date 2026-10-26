from datetime import datetime, timezone


def test_end_to_end_manufacturing_and_passport_flow(client, auth_headers):
    # 1. Create Display Batch ABC
    batch_res = client.post(
        "/api/v1/batches",
        json={
            "batch_code": "ABC",
            "component_type": "DISPLAY",
            "planned_quantity": 100,
            "supplier_id": "supplier-opti",
            "facility_id": "facility-gumi",
        },
        headers=auth_headers,
    )
    assert batch_res.status_code == 201
    batch_data = batch_res.json()
    assert batch_data["batch_code"] == "ABC"
    assert batch_data["total_serials_allocated"] == 100
    assert batch_data["serial_range_start"] == "ABC-0001"
    assert batch_data["serial_range_end"] == "ABC-0100"

    # 2. Record manufacturing event for unit ABC-0042
    now_iso = datetime.now(timezone.utc).isoformat()
    evt_res = client.post(
        "/api/v1/manufacturing/events",
        json={
            "component_serial": "ABC-0042",
            "batch_code": "ABC",
            "operation_code": "GLASS_CUTTING",
            "machine_id": "LASER-01",
            "started_at": now_iso,
            "completed_at": now_iso,
            "result": "PASS",
            "measured_parameters": {"cutting_speed_mms": 120.5},
            "source_system": "MES-01",
        },
        headers=auth_headers,
    )
    assert evt_res.status_code == 201
    evt_data = evt_res.json()
    assert evt_data["canonical_payload_hash"] is not None
    assert len(evt_data["canonical_payload_hash"]) == 64

    # 3. Assemble smartphone GT-DEV-00000851
    assembly_res = client.post(
        "/api/v1/assembly",
        json={
            "product_id": "GT-DEV-00000851",
            "product_type": "SMARTPHONE_S24_ULTRA",
            "manufacturer_id": "GENEATRACE-AUSTIN",
            "assembly_facility_id": "FAC-ASM-01",
            "raw_imei": "352849102847592",
            "components": [
                {"component_serial": "ABC-0042"},
            ],
        },
        headers=auth_headers,
    )
    assert assembly_res.status_code == 201
    asm_data = assembly_res.json()
    assert asm_data["product_id"] == "GT-DEV-00000851"
    assert asm_data["masked_imei"] == "352849******592"  # Raw IMEI never exposed

    # 4. Fetch internal passport (authenticated)
    pass_res = client.get("/api/v1/passports/GT-DEV-00000851", headers=auth_headers)
    assert pass_res.status_code == 200
    pass_data = pass_res.json()
    assert pass_data["product_id"] == "GT-DEV-00000851"
    assert len(pass_data["installed_components"]) == 1
    assert pass_data["installed_components"][0]["component_serial"] == "ABC-0042"

    # 5. Fetch public passport (sanitized, unauthenticated)
    pub_res = client.get("/api/v1/passports/GT-DEV-00000851/public")
    assert pub_res.status_code == 200
    pub_data = pub_res.json()
    assert pub_data["product_id"] == "GT-DEV-00000851"
    assert "masked_imei" not in pub_data
    assert pub_data["is_authentic"] is True

    # 6. Traceability backward query
    trace_res = client.post(
        "/api/v1/traceability/query",
        json={
            "entity_type": "product",
            "entity_id": "GT-DEV-00000851",
            "direction": "backward",
        },
    )
    assert trace_res.status_code == 200
    trace_data = trace_res.json()
    assert trace_data["entity_id"] == "GT-DEV-00000851"
    assert trace_data["query_duration_ms"] < 100.0  # Sub-100ms requirement!

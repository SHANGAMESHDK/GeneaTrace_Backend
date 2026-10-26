from datetime import datetime, timezone


def test_device_security_attestation_and_lock_workflow(client, auth_headers):
    # 1. Create product
    client.post(
        "/api/v1/batches",
        json={
            "batch_code": "ABC",
            "component_type": "DISPLAY",
            "planned_quantity": 10,
            "supplier_id": "sup-01",
            "facility_id": "fac-01",
        },
        headers=auth_headers,
    )
    client.post(
        "/api/v1/assembly",
        json={
            "product_id": "GT-DEV-00000851",
            "product_type": "SMARTPHONE",
            "manufacturer_id": "GENEATRACE",
            "assembly_facility_id": "FAC-ASM-01",
            "raw_imei": "352849102847592",
            "components": [{"component_serial": "ABC-0001"}],
        },
        headers=auth_headers,
    )

    # 2. Hardware attestation with registered component
    att_res = client.post(
        "/api/v1/security/attestations",
        json={
            "product_id": "GT-DEV-00000851",
            "reported_hardware_hash": "0xvalidhash123",
            "attestation_signature": "0xsig123",
            "reported_component_serials": {"DISPLAY": "ABC-0001"},
            "nonce": "testnonce1",
        },
    )
    assert att_res.status_code == 200
    assert att_res.json()["verification_status"] == "VERIFIED"
    assert att_res.json()["policy_decision"] == "ALLOW"

    # 3. Attestation with mismatched component flags for review
    att_mismatch = client.post(
        "/api/v1/security/attestations",
        json={
            "product_id": "GT-DEV-00000851",
            "reported_hardware_hash": "0xvalidhash123",
            "attestation_signature": "0xsig123",
            "reported_component_serials": {"DISPLAY": "UNREGISTERED-SERIAL-999"},
            "nonce": "testnonce2",
        },
    )
    assert att_mismatch.status_code == 200
    assert att_mismatch.json()["verification_status"] == "SUSPICIOUS"
    assert att_mismatch.json()["policy_decision"] == "FLAG_FOR_REVIEW"

    # 4. Evaluate IMEI mismatch: MUST NOT automatically kill device
    eval_res = client.post(
        "/api/v1/security/devices/GT-DEV-00000851/evaluate",
        json={
            "product_id": "GT-DEV-00000851",
            "detected_event": "IMEI_MISMATCH",
            "evidence_reference": "EVD-SIM-001",
        },
        headers=auth_headers,
    )
    assert eval_res.status_code == 200
    assert eval_res.json()["action_required"] is False
    assert eval_res.json()["policy_decision"] == "FLAG_FOR_REVIEW"

    # 5. Issue controlled MDM lock command
    cmd_res = client.post(
        "/api/v1/security/commands",
        json={
            "product_id": "GT-DEV-00000851",
            "command_type": "LOCK",
            "reason": "Authorized quarantine during investigation",
            "evidence_reference": "EVD-SIM-001",
            "expiry_minutes": 60,
        },
        headers=auth_headers,
    )
    assert cmd_res.status_code == 201
    cmd_data = cmd_res.json()
    assert cmd_data["status"] == "ISSUED"
    assert cmd_data["command_id"].startswith("CMD-LOCK-")
    command_id = cmd_data["command_id"]

    # 6. Report MDM execution
    report_res = client.post(
        f"/api/v1/security/commands/{command_id}/execution-report",
        json={
            "success": True,
            "mdm_agent_id": "MDM-AGENT-ANDROID-01",
            "execution_timestamp": datetime.now(timezone.utc).isoformat(),
            "telemetry": {"screen_locked": True},
        },
    )
    assert report_res.status_code == 200
    assert report_res.json()["status"] == "EXECUTED"

    # 7. Recovery workflow
    rec_res = client.post(
        "/api/v1/security/devices/GT-DEV-00000851/recovery",
        json={
            "product_id": "GT-DEV-00000851",
            "authorized_officer_reason": "Device inspected in authorized service center. Verified clean.",
        },
        headers=auth_headers,
    )
    assert rec_res.status_code == 200
    assert rec_res.json()["recovered"] is True

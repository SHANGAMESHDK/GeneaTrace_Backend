from datetime import datetime, timezone


def test_precision_recall_flow_and_deduplication(client, auth_headers):
    # 1. Create Batch ABC
    client.post(
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

    # 2. Assemble 2 phones with ABC components
    client.post(
        "/api/v1/assembly",
        json={
            "product_id": "GT-DEV-00000851",
            "product_type": "SMARTPHONE",
            "manufacturer_id": "GENEATRACE",
            "assembly_facility_id": "FAC-ASM-01",
            "components": [{"component_serial": "ABC-0001"}],
        },
        headers=auth_headers,
    )
    client.post(
        "/api/v1/assembly",
        json={
            "product_id": "GT-DEV-00000852",
            "product_type": "SMARTPHONE",
            "manufacturer_id": "GENEATRACE",
            "assembly_facility_id": "FAC-ASM-01",
            "components": [{"component_serial": "ABC-0002"}],
        },
        headers=auth_headers,
    )

    # 3. Calculate recall impact for Batch ABC
    impact_res = client.get("/api/v1/batches/ABC/recall-impact")
    assert impact_res.status_code == 200
    impact_data = impact_res.json()
    assert impact_data["batch_code"] == "ABC"
    assert impact_data["total_batch_units"] == 100
    assert impact_data["unique_affected_product_count"] == 2
    assert "GT-DEV-00000851" in impact_data["affected_product_ids"]
    assert "GT-DEV-00000852" in impact_data["affected_product_ids"]

    # 4. Initiate recall
    rec_res = client.post(
        "/api/v1/recalls",
        json={
            "batch_code": "ABC",
            "defect_category": "OPTICAL_DELAMINATION",
            "severity": "HIGH",
            "description": "Adhesive curing failure under humidity.",
        },
        headers=auth_headers,
    )
    assert rec_res.status_code == 201
    rec_data = rec_res.json()
    assert rec_data["status"] == "INITIATED"
    recall_id = rec_data["recall_id"]

    # 5. Confirm recall
    confirm_res = client.post(
        f"/api/v1/recalls/{recall_id}/confirm",
        json={"notes": "Lab test confirmed failure rate > 15%."},
        headers=auth_headers,
    )
    assert confirm_res.status_code == 200
    assert confirm_res.json()["status"] == "CONFIRMED"

    # 6. Export recall CSV
    export_res = client.get(f"/api/v1/recalls/{recall_id}/export")
    assert export_res.status_code == 200
    assert "text/csv" in export_res.headers["content-type"]
    assert "GENEATRACE PRECISION RECALL IMPACT REPORT" in export_res.text
    assert "GT-DEV-00000851" in export_res.text

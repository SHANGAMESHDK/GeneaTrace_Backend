import time
from backend.app.schemas.traceability import TraceabilityQueryRequest
from backend.app.services.graph_service import graph_service
from backend.app.services.merkle_service import merkle_service
from backend.app.services.recall_service import recall_service


def test_lineage_graph_traversal_sub_100ms_benchmark(client, auth_headers, db):
    # Setup test dataset: 1 batch with 100 components, 1 assembled product
    client.post(
        "/api/v1/batches",
        json={
            "batch_code": "BENCH",
            "component_type": "DISPLAY",
            "planned_quantity": 100,
            "supplier_id": "sup-bench",
            "facility_id": "fac-bench",
        },
        headers=auth_headers,
    )
    client.post(
        "/api/v1/assembly",
        json={
            "product_id": "GT-BENCH-001",
            "product_type": "SMARTPHONE",
            "manufacturer_id": "GENEATRACE",
            "assembly_facility_id": "FAC-ASM-01",
            "components": [{"component_serial": "BENCH-0001"}],
        },
        headers=auth_headers,
    )

    # 1. Forward Traversal Benchmark
    req_fwd = TraceabilityQueryRequest(entity_type="batch", entity_id="BENCH", direction="forward")
    t0 = time.perf_counter()
    res_fwd = graph_service.execute_traceability_query(db, req_fwd)
    t_fwd_ms = (time.perf_counter() - t0) * 1000

    print(f"\n[BENCHMARK] Forward Graph Traversal: {t_fwd_ms:.2f}ms (Engine: {res_fwd.graph_data_source})")
    assert t_fwd_ms < 100.0, f"Forward traversal took {t_fwd_ms:.2f}ms, expected sub-100ms!"

    # 2. Backward Traversal Benchmark
    req_bwd = TraceabilityQueryRequest(entity_type="product", entity_id="GT-BENCH-001", direction="backward")
    t0 = time.perf_counter()
    res_bwd = graph_service.execute_traceability_query(db, req_bwd)
    t_bwd_ms = (time.perf_counter() - t0) * 1000

    print(f"[BENCHMARK] Backward Graph Traversal: {t_bwd_ms:.2f}ms (Engine: {res_bwd.graph_data_source})")
    assert t_bwd_ms < 100.0, f"Backward traversal took {t_bwd_ms:.2f}ms, expected sub-100ms!"

    # 3. Precision Recall Calculation Benchmark
    t0 = time.perf_counter()
    res_recall = recall_service.calculate_batch_impact(db, "BENCH")
    t_recall_ms = (time.perf_counter() - t0) * 1000

    print(f"[BENCHMARK] Precision Recall Calculation: {t_recall_ms:.2f}ms")
    assert t_recall_ms < 100.0, f"Recall calculation took {t_recall_ms:.2f}ms, expected sub-100ms!"

    # 4. Merkle-DAG Hashing Benchmark (100 events)
    hashes = [merkle_service.compute_event_hash({"idx": i, "val": i * 1.5}) for i in range(100)]
    t0 = time.perf_counter()
    root, levels = merkle_service.build_merkle_tree(hashes)
    t_merkle_ms = (time.perf_counter() - t0) * 1000

    print(f"[BENCHMARK] Merkle-DAG 100-event Tree Construction: {t_merkle_ms:.2f}ms")
    assert t_merkle_ms < 50.0

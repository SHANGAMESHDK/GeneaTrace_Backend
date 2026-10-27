import uuid
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.core.permissions import UserRole
from backend.app.core.security import compute_canonical_hash, get_password_hash
from backend.app.db.postgres import SessionLocal, init_db
from backend.app.models.batch import Batch, BatchStatus, ComponentType, QualityStatus
from backend.app.models.component import Component, ComponentStatus
from backend.app.models.facility import Facility, Supplier
from backend.app.models.integration import IntegrationSource, IntegrationSourceType, IntegrationStatus
from backend.app.models.manufacturing_event import (
    EventResult,
    EventStatus,
    ManufacturingEvent,
    ManufacturingOperation,
)
from backend.app.models.product import (
    AssemblyRelationshipStatus,
    FinishedProduct,
    PassportStatus,
    ProductComponentRelationship,
    ProductManufacturingStatus,
)
from backend.app.models.recall import Recall, RecallSeverity, RecallStatus
from backend.app.models.shipment import (
    Shipment,
    ShipmentEvent,
    ShipmentEventType,
    ShipmentItem,
    ShipmentStatus,
)
from backend.app.models.user import User
from backend.app.services.blockchain_service import blockchain_service
from backend.app.services.merkle_service import merkle_service
from backend.app.services.serial_service import serial_service


def seed_database():
    init_db()
    db: Session = SessionLocal()
    print("[INFO] Starting GeneaTrace database seeding...")

    try:
        # 1. Seed Users
        users_data = [
            ("admin", "admin@geneatrace.io", "DevPassword123!", "System Administrator", UserRole.ADMINISTRATOR),
            ("manufacturer", "mfg@geneatrace.io", "DevPassword123!", "Lead Manufacturing Engineer", UserRole.MANUFACTURER),
            ("supplier", "supplier@displaycorp.com", "DevPassword123!", "Display Supplier Operator", UserRole.SUPPLIER),
            ("inspector", "quality@geneatrace.io", "DevPassword123!", "Senior Quality Inspector", UserRole.QUALITY_INSPECTOR),
            ("logistics", "logistics@globalfreight.com", "DevPassword123!", "Logistics Coordinator", UserRole.LOGISTICS_OPERATOR),
            ("recall_mgr", "recalls@geneatrace.io", "DevPassword123!", "Product Safety & Recall Manager", UserRole.RECALL_MANAGER),
            ("security_officer", "secops@geneatrace.io", "DevPassword123!", "Device Security Officer", UserRole.SECURITY_OFFICER),
            ("auditor", "audit@certauthority.org", "DevPassword123!", "Independent Lineage Auditor", UserRole.AUDITOR),
            ("verifier", "public@consumer.org", "DevPassword123!", "Public Product Verifier", UserRole.PUBLIC_VERIFIER),
        ]

        user_map = {}
        for username, email, pwd, name, role in users_data:
            existing = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
            if not existing:
                u = User(
                    username=username,
                    email=email,
                    hashed_password=get_password_hash(pwd),
                    full_name=name,
                    role=role,
                )
                db.add(u)
                db.flush()
                user_map[username] = u
            else:
                user_map[username] = existing
        db.commit()
        print(f"[OK] Seeded {len(user_map)} demonstration users.")

        # 2. Seed Facilities & Suppliers
        supplier_disp = db.execute(select(Supplier).where(Supplier.code == "SUP-DISP")).scalar_one_or_none()
        if not supplier_disp:
            supplier_disp = Supplier(code="SUP-DISP", name="OptiScreen OLED Technologies", country="South Korea")
            db.add(supplier_disp)

        supplier_bat = db.execute(select(Supplier).where(Supplier.code == "SUP-BAT")).scalar_one_or_none()
        if not supplier_bat:
            supplier_bat = Supplier(code="SUP-BAT", name="SolidVolt Energy Systems", country="Japan")
            db.add(supplier_bat)

        facility_fab = db.execute(select(Facility).where(Facility.code == "FAC-FAB-01")).scalar_one_or_none()
        if not facility_fab:
            facility_fab = Facility(code="FAC-FAB-01", name="MegaFab Precision Line A", location="Gumi, KR", facility_type="FABRICATION")
            db.add(facility_fab)

        facility_assem = db.execute(select(Facility).where(Facility.code == "FAC-ASM-01")).scalar_one_or_none()
        if not facility_assem:
            facility_assem = Facility(code="FAC-ASM-01", name="GeneaTrace Smartphone Final Assembly", location="Austin, TX, US", facility_type="ASSEMBLY")
            db.add(facility_assem)

        db.commit()

        # 3. Seed Manufacturing Operations
        operations_data = [
            ("RAW_MATERIAL_RECEIPT", "Raw Material Receipt and Inspection", 1),
            ("GLASS_CUTTING", "Laser Ultra-Thin Glass Cutting", 2),
            ("TFT_DEPOSITION", "TFT Backplane Substrate Deposition", 3),
            ("POLARIZER_LAMINATION", "High-Contrast Polarizer Film Lamination", 4),
            ("ADHESIVE_GLUING", "Optical Clear Adhesive Dispensing", 5),
            ("DISPLAY_STICKING", "High-Precision Display Panel Sticking", 6),
            ("PREHEATING_CURING", "Thermal and UV Chamber Curing", 7),
            ("ELECTRICAL_TEST", "Micro-probe Electrical and Pixel Test", 8),
            ("FINAL_INSPECTION", "Automated Optical Inspection (AOI)", 9),
            ("PCB_INSTALLATION", "Mainboard Logic Board Mounting", 10),
            ("BATTERY_INSTALLATION", "Battery Cell Mounting and Adhesive Bonding", 11),
            ("CAMERA_INSTALLATION", "Periscope Telephoto & Wide Sensor Insertion", 12),
            ("FINAL_ASSEMBLY", "Chassis Enclosure Screwing and Waterproof Sealing", 13),
            ("FUNCTIONAL_TEST", "End-of-Line RF, Sensor, and Display Functional QA", 14),
            ("PACKAGING", "Box Packing with Secure Identity Tagging", 15),
            ("DISPATCH", "Warehouse Distribution Handover", 16),
        ]

        op_map = {}
        for code, name, seq in operations_data:
            op = db.execute(select(ManufacturingOperation).where(ManufacturingOperation.operation_code == code)).scalar_one_or_none()
            if not op:
                op = ManufacturingOperation(operation_code=code, operation_name=name, sequence_number=seq)
                db.add(op)
                db.flush()
            op_map[code] = op
        db.commit()
        print(f"[OK] Seeded {len(op_map)} manufacturing operations.")

        # 4. Seed Batches and allocate 100 units per batch
        batches_def = [
            ("AAA", ComponentType.DISPLAY, 100),
            ("ABC", ComponentType.DISPLAY, 100),
            ("BTR", ComponentType.BATTERY, 100),
            ("PCB", ComponentType.PCB, 100),
            ("CAM", ComponentType.CAMERA, 100),
            ("SPK", ComponentType.SPEAKER, 100),
            ("FRM", ComponentType.FRAME, 100),
        ]

        batch_map = {}
        for b_code, c_type, qty in batches_def:
            b = db.execute(select(Batch).where(Batch.batch_code == b_code)).scalar_one_or_none()
            if not b:
                b = Batch(
                    batch_code=b_code,
                    component_type=c_type,
                    issuer_id=user_map["manufacturer"].id,
                    supplier_id="SUP-DISP" if c_type == ComponentType.DISPLAY else "SUP-BAT",
                    facility_id="FAC-FAB-01",
                    planned_quantity=qty,
                    actual_quantity=0,
                    status=BatchStatus.COMPLETED,
                    quality_status=QualityStatus.PASSED,
                )
                db.add(b)
                db.flush()
                allocated = serial_service.allocate_batch_serials(db, b, qty)
                print(f"  * Allocated batch {b_code}: {allocated[0].component_serial} through {allocated[-1].component_serial}")
            batch_map[b_code] = b
        db.commit()

        # 5. Seed Manufacturing Events for display Batch ABC
        # Build chronological events with canonical Merkle hashes
        display_components = db.execute(
            select(Component).where(Component.batch_id == batch_map["ABC"].id).order_by(Component.component_serial.asc())
        ).scalars().all()

        mfg_user = user_map["manufacturer"].username
        now = datetime.now(timezone.utc) - timedelta(days=10)

        events_created_count = 0
        for comp in display_components[:20]:  # Create full event sequence for first 20 units
            prev_hash = None
            for idx, op_code in enumerate(["GLASS_CUTTING", "TFT_DEPOSITION", "POLARIZER_LAMINATION", "ADHESIVE_GLUING", "DISPLAY_STICKING", "PREHEATING_CURING", "ELECTRICAL_TEST", "FINAL_INSPECTION"]):
                op = op_map[op_code]
                evt_id = f"EVT-ABC-{comp.component_serial.split('-')[1]}-{idx+1:02d}"
                existing_evt = db.execute(select(ManufacturingEvent).where(ManufacturingEvent.event_id == evt_id)).scalar_one_or_none()
                if not existing_evt:
                    t_start = now + timedelta(minutes=idx * 20)
                    t_end = t_start + timedelta(minutes=15)
                    payload = {
                        "event_id": evt_id,
                        "component_id": comp.id,
                        "product_id": None,
                        "batch_id": batch_map["ABC"].id,
                        "operation_id": op.id,
                        "machine_id": f"MACH-{op_code[:4]}-01",
                        "operator_id": mfg_user,
                        "started_at": t_start.isoformat(),
                        "completed_at": t_end.isoformat(),
                        "event_status": "COMPLETED",
                        "result": "PASS",
                        "measured_parameters": {"temperature_c": 68.4, "pressure_bar": 2.1, "tolerance_um": 0.04},
                        "inspection_result": "PASS",
                        "rework_reference": None,
                        "previous_event_hash": prev_hash,
                        "source_system": "MES-01",
                    }
                    can_hash = compute_canonical_hash(payload)
                    evt = ManufacturingEvent(
                        event_id=evt_id,
                        component_id=comp.id,
                        batch_id=batch_map["ABC"].id,
                        operation_id=op.id,
                        machine_id=f"MACH-{op_code[:4]}-01",
                        operator_id=mfg_user,
                        started_at=t_start,
                        completed_at=t_end,
                        event_status=EventStatus.COMPLETED,
                        result=EventResult.PASS,
                        measured_parameters={"temperature_c": 68.4, "pressure_bar": 2.1, "tolerance_um": 0.04},
                        inspection_result="PASS",
                        source_system="MES-01",
                        canonical_payload_hash=can_hash,
                        previous_event_hash=prev_hash,
                    )
                    db.add(evt)
                    prev_hash = can_hash
                    events_created_count += 1
            now += timedelta(hours=1)
        db.commit()
        print(f"[OK] Seeded {events_created_count} chronological manufacturing events with Merkle-DAG hashes.")

        # 6. Seed Finished Smartphones
        # GT-DEV-00000851 (exact specification from Master Prompt):
        # Display: ABC-0042, Battery: BTR-0018, PCB: PCB-0073, Camera: CAM-0034, Speaker: SPK-0012, Frame: FRM-0048
        target_prod_id = "GT-DEV-00000851"
        phone = db.execute(select(FinishedProduct).where(FinishedProduct.product_id == target_prod_id)).scalar_one_or_none()
        if not phone:
            phone = FinishedProduct(
                product_id=target_prod_id,
                product_type="SMARTPHONE_S24_ULTRA",
                manufacturer_id="GENEATRACE-MFG-AUSTIN",
                assembly_facility_id="FAC-ASM-01",
                manufacturing_status=ProductManufacturingStatus.SHIPPED,
                quality_status="PASSED",
                authorized_device_identity_commitment="0x9a8f4c2e1b3d5e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f",
                masked_imei="352849******712",
                passport_status=PassportStatus.PUBLISHED,
            )
            db.add(phone)
            db.flush()

            component_assignments = [
                ("ABC-0042", ComponentType.DISPLAY),
                ("BTR-0018", ComponentType.BATTERY),
                ("PCB-0073", ComponentType.PCB),
                ("CAM-0034", ComponentType.CAMERA),
                ("SPK-0012", ComponentType.SPEAKER),
                ("FRM-0048", ComponentType.FRAME),
            ]
            for serial, c_type in component_assignments:
                comp = db.execute(select(Component).where(Component.component_serial == serial)).scalar_one_or_none()
                if comp:
                    rel = ProductComponentRelationship(
                        product_id=phone.id,
                        component_id=comp.id,
                        installation_timestamp=datetime.now(timezone.utc) - timedelta(days=5),
                        relationship_status=AssemblyRelationshipStatus.ACTIVE,
                    )
                    db.add(rel)
                    comp.status = ComponentStatus.INSTALLED

        # Seed additional phones to show multiple affected products for recall analysis
        extra_phones = [
            ("GT-DEV-00000852", "ABC-0043", "BTR-0019", "PCB-0074"),
            ("GT-DEV-00000853", "ABC-0044", "BTR-0020", "PCB-0075"),
        ]
        for p_id, disp_s, bat_s, pcb_s in extra_phones:
            p_obj = db.execute(select(FinishedProduct).where(FinishedProduct.product_id == p_id)).scalar_one_or_none()
            if not p_obj:
                p_obj = FinishedProduct(
                    product_id=p_id,
                    product_type="SMARTPHONE_S24_ULTRA",
                    manufacturer_id="GENEATRACE-MFG-AUSTIN",
                    assembly_facility_id="FAC-ASM-01",
                    manufacturing_status=ProductManufacturingStatus.SHIPPED,
                    quality_status="PASSED",
                    masked_imei="352849******713",
                    passport_status=PassportStatus.PUBLISHED,
                )
                db.add(p_obj)
                db.flush()
                for s in [disp_s, bat_s, pcb_s]:
                    c_found = db.execute(select(Component).where(Component.component_serial == s)).scalar_one_or_none()
                    if c_found:
                        db.add(ProductComponentRelationship(
                            product_id=p_obj.id,
                            component_id=c_found.id,
                            installation_timestamp=datetime.now(timezone.utc) - timedelta(days=4),
                            relationship_status=AssemblyRelationshipStatus.ACTIVE,
                        ))
                        c_found.status = ComponentStatus.INSTALLED
        db.commit()
        print(f"[OK] Seeded flagship smartphone GT-DEV-00000851 with verified components.")

        # Seed Samsung Galaxy A55 5G (AAA12345678)
        target_a55 = "AAA12345678"
        phone_a55 = db.execute(select(FinishedProduct).where(FinishedProduct.product_id == target_a55)).scalar_one_or_none()
        if not phone_a55:
            phone_a55 = FinishedProduct(
                product_id=target_a55,
                product_type="SAMSUNG_GALAXY_A55_5G",
                manufacturer_id="SAMSUNG-SMART-MEGAHUB-4",
                assembly_facility_id="FAC-ASM-01",
                manufacturing_status=ProductManufacturingStatus.SHIPPED,
                quality_status="PASSED",
                authorized_device_identity_commitment="0x9f3b8a1c4e72d05f88b14a2c91e3f706a45b98cf120194bc87123985",
                masked_imei="356789******780",
                passport_status=PassportStatus.PUBLISHED,
            )
            db.add(phone_a55)
            db.flush()

            comp_a55 = db.execute(select(Component).where(Component.component_serial == "AAA-0042")).scalar_one_or_none()
            if comp_a55:
                db.add(ProductComponentRelationship(
                    product_id=phone_a55.id,
                    component_id=comp_a55.id,
                    installation_timestamp=datetime.now(timezone.utc) - timedelta(days=5),
                    relationship_status=AssemblyRelationshipStatus.ACTIVE,
                ))
                comp_a55.status = ComponentStatus.INSTALLED
            db.commit()
            print(f"[OK] Seeded showcase Samsung Galaxy A55 5G (AAA12345678).")

        # 7. Seed Shipments
        shp1 = db.execute(select(Shipment).where(Shipment.shipment_id == "SHP-2026-US-001")).scalar_one_or_none()
        if not shp1:
            shp1 = Shipment(
                shipment_id="SHP-2026-US-001",
                origin="GeneaTrace Austin Plant, TX",
                destination="Regional Distribution Hub, Chicago, IL",
                carrier="Apex Freight Logistics",
                dispatched_at=datetime.now(timezone.utc) - timedelta(days=2),
                expected_delivery=datetime.now(timezone.utc) + timedelta(days=1),
                status=ShipmentStatus.IN_TRANSIT,
            )
            db.add(shp1)
            db.flush()
            # Add phone 851 & 852
            p851 = db.execute(select(FinishedProduct).where(FinishedProduct.product_id == "GT-DEV-00000851")).scalar_one()
            p852 = db.execute(select(FinishedProduct).where(FinishedProduct.product_id == "GT-DEV-00000852")).scalar_one()
            db.add(ShipmentItem(shipment_id=shp1.id, product_id=p851.id))
            db.add(ShipmentItem(shipment_id=shp1.id, product_id=p852.id))

            # Custody event
            db.add(ShipmentEvent(
                event_id="LOG-EVT-001",
                shipment_id=shp1.id,
                event_type=ShipmentEventType.DISPATCH,
                location="Austin, TX",
                custody_party="Apex Freight Driver #441",
                timestamp=datetime.now(timezone.utc) - timedelta(days=2),
                notes="Departed sorting facility in sealed climate-controlled freight container.",
            ))

        # Seed Shipment GT-SHP-00000326 for Samsung A55 to Indiranagar Retail
        shp_a55 = db.execute(select(Shipment).where(Shipment.shipment_id == "GT-SHP-00000326")).scalar_one_or_none()
        if not shp_a55:
            shp_a55 = Shipment(
                shipment_id="GT-SHP-00000326",
                origin="Samsung Mega-Hub 4, Gumi",
                destination="Apex Retail Hub, Indiranagar, Bangalore",
                carrier="DHL Express Supply Chain Intercontinental",
                dispatched_at=datetime.now(timezone.utc) - timedelta(days=4),
                expected_delivery=datetime.now(timezone.utc) - timedelta(days=1),
                delivered_at=datetime.now(timezone.utc) - timedelta(days=1),
                status=ShipmentStatus.DELIVERED,
            )
            db.add(shp_a55)
            db.flush()
            if phone_a55:
                db.add(ShipmentItem(shipment_id=shp_a55.id, product_id=phone_a55.id))
        db.commit()
        print(f"[OK] Seeded logistics shipments and chain-of-custody events.")

        # 8. Seed Controlled Recall Scenario
        # Mark Display Batch ABC under active recall investigation
        rec = db.execute(select(Recall).where(Recall.recall_id == "RCL-2026-DISP-001")).scalar_one_or_none()
        if not rec:
            rec = Recall(
                recall_id="RCL-2026-DISP-001",
                affected_batch_id=batch_map["ABC"].id,
                defect_category="MICRO_CRACK_POLARIZER_DELAMINATION",
                severity=RecallSeverity.HIGH,
                description="Thermal stress testing revealed potential optical adhesive delamination under high humidity on display Batch ABC.",
                status=RecallStatus.INITIATED,
                created_by=user_map["recall_mgr"].id,
            )
            db.add(rec)

        # Seed Recall for Batch AAA (Samsung A55)
        rec_aaa = db.execute(select(Recall).where(Recall.recall_id == "RCL-2026-AAA")).scalar_one_or_none()
        if not rec_aaa and "AAA" in batch_map:
            rec_aaa = Recall(
                recall_id="RCL-2026-AAA",
                affected_batch_id=batch_map["AAA"].id,
                defect_category="STAGE_2_DISP_04_THERMAL_VARIANCE",
                severity=RecallSeverity.CRITICAL,
                description="Machine DISP-04 thermal lamination anomaly during Stage 2 caused AMOLED micro-delamination and green vertical lines on Batch AAA.",
                status=RecallStatus.INITIATED,
                created_by=user_map["recall_mgr"].id,
            )
            db.add(rec_aaa)
        db.commit()
        print(f"[OK] Seeded precision recall scenarios for Batch ABC & Batch AAA.")

        # 9. Seed Integration Sources
        sources = [
            ("SAP S/4HANA ERP", IntegrationSourceType.ERP, "https://erp.internal.geneatrace.io/api/v1"),
            ("Siemens Opcenter MES", IntegrationSourceType.MES, "https://mes-austin.internal.geneatrace.io/opcenter"),
            ("Ignition SCADA Telemetry", IntegrationSourceType.SCADA, "https://scada.internal.geneatrace.io/gateway"),
            ("ETQ Reliance QMS", IntegrationSourceType.QMS, "https://qms.internal.geneatrace.io/reliance"),
        ]
        for name, s_type, endpoint in sources:
            existing_s = db.execute(select(IntegrationSource).where(IntegrationSource.name == name)).scalar_one_or_none()
            if not existing_s:
                db.add(IntegrationSource(
                    name=name,
                    source_type=s_type,
                    status=IntegrationStatus.ACTIVE,
                    endpoint_url=endpoint,
                    last_sync_at=datetime.now(timezone.utc),
                    sync_count=1420,
                    error_count=0,
                ))
        db.commit()
        print("[OK] Seeded enterprise integrations (ERP, MES, SCADA, QMS).")

        # 10. Anchor demonstration Merkle-DAG checkpoint on blockchain adapter
        try:
            from backend.app.schemas.blockchain import CheckpointCreateRequest
            cp_res = blockchain_service.create_checkpoint(
                db, CheckpointCreateRequest(batch_ids=["ABC"])
            )
            print(f"[OK] Anchored Merkle root on blockchain adapter: root={cp_res.merkle_root[:18]}... (tx={cp_res.transaction_hash})")
        except Exception as e:
            print(f"  Note on blockchain checkpoint: {str(e)}")

        print("[SUCCESS] Database seeding completed successfully!")
    finally:
        db.close()


if __name__ == "__main__":
    seed_database()

"""initial_schema

Revision ID: 20260101_0001
Revises: 
Create Date: 2026-01-01 00:00:00.000000

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '20260101_0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Users
    op.create_table(
        'users',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('username', sa.String(length=100), nullable=False, unique=True),
        sa.Column('email', sa.String(length=255), nullable=False, unique=True),
        sa.Column('hashed_password', sa.String(length=255), nullable=False),
        sa.Column('full_name', sa.String(length=255), nullable=False),
        sa.Column('role', sa.String(length=50), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False, default=True),
        sa.Column('facility_id', sa.String(length=100), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_users_username', 'users', ['username'])
    op.create_index('ix_users_email', 'users', ['email'])

    # 2. Suppliers and Facilities
    op.create_table(
        'suppliers',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('code', sa.String(length=50), nullable=False, unique=True),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('contact_email', sa.String(length=255), nullable=True),
        sa.Column('country', sa.String(length=100), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        'facilities',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('code', sa.String(length=50), nullable=False, unique=True),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('location', sa.String(length=255), nullable=True),
        sa.Column('facility_type', sa.String(length=100), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )

    # 3. Batches
    op.create_table(
        'batches',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('batch_code', sa.String(length=50), nullable=False, unique=True),
        sa.Column('component_type', sa.String(length=50), nullable=False),
        sa.Column('issuer_id', sa.String(length=100), nullable=False),
        sa.Column('supplier_id', sa.String(length=100), nullable=False),
        sa.Column('facility_id', sa.String(length=100), nullable=False),
        sa.Column('planned_quantity', sa.Integer(), nullable=False, default=100),
        sa.Column('actual_quantity', sa.Integer(), nullable=False, default=0),
        sa.Column('production_start', sa.DateTime(timezone=True), nullable=False),
        sa.Column('production_end', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', sa.String(length=50), nullable=False),
        sa.Column('quality_status', sa.String(length=50), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_batches_code', 'batches', ['batch_code'])

    # 4. Components
    op.create_table(
        'components',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('component_serial', sa.String(length=100), nullable=False, unique=True),
        sa.Column('component_type', sa.String(length=50), nullable=False),
        sa.Column('batch_id', sa.String(length=36), sa.ForeignKey('batches.id', ondelete='CASCADE'), nullable=False),
        sa.Column('manufacturer_id', sa.String(length=100), nullable=False),
        sa.Column('supplier_id', sa.String(length=100), nullable=False),
        sa.Column('facility_id', sa.String(length=100), nullable=False),
        sa.Column('production_date', sa.DateTime(timezone=True), nullable=False),
        sa.Column('status', sa.String(length=50), nullable=False),
        sa.Column('quality_status', sa.String(length=50), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_components_serial', 'components', ['component_serial'])
    op.create_index('ix_components_batch_id', 'components', ['batch_id'])

    # 5. Finished Products
    op.create_table(
        'finished_products',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('product_id', sa.String(length=100), nullable=False, unique=True),
        sa.Column('product_type', sa.String(length=100), nullable=False),
        sa.Column('manufacturer_id', sa.String(length=100), nullable=False),
        sa.Column('assembly_facility_id', sa.String(length=100), nullable=False),
        sa.Column('manufacturing_status', sa.String(length=50), nullable=False),
        sa.Column('quality_status', sa.String(length=50), nullable=False),
        sa.Column('authorized_device_identity_commitment', sa.String(length=128), nullable=True),
        sa.Column('masked_imei', sa.String(length=50), nullable=True),
        sa.Column('passport_status', sa.String(length=50), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_finished_products_id', 'finished_products', ['product_id'])

    # 6. Product Component Relationships (Assembly & replacement history)
    op.create_table(
        'product_component_relationships',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('product_id', sa.String(length=36), sa.ForeignKey('finished_products.id', ondelete='CASCADE'), nullable=False),
        sa.Column('component_id', sa.String(length=36), sa.ForeignKey('components.id', ondelete='CASCADE'), nullable=False),
        sa.Column('installation_event_id', sa.String(length=100), nullable=True),
        sa.Column('installation_timestamp', sa.DateTime(timezone=True), nullable=False),
        sa.Column('removal_event_id', sa.String(length=100), nullable=True),
        sa.Column('removal_timestamp', sa.DateTime(timezone=True), nullable=True),
        sa.Column('relationship_status', sa.String(length=50), nullable=False),
        sa.Column('rework_reason', sa.String(length=255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_pcr_product_id', 'product_component_relationships', ['product_id'])
    op.create_index('ix_pcr_component_id', 'product_component_relationships', ['component_id'])

    # 7. Manufacturing Operations & Events
    op.create_table(
        'manufacturing_operations',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('operation_code', sa.String(length=50), nullable=False, unique=True),
        sa.Column('operation_name', sa.String(length=255), nullable=False),
        sa.Column('component_type', sa.String(length=50), nullable=True),
        sa.Column('sequence_number', sa.Integer(), nullable=False, default=1),
        sa.Column('facility_id', sa.String(length=100), nullable=True),
        sa.Column('machine_id', sa.String(length=100), nullable=True),
        sa.Column('configuration', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        'manufacturing_events',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('event_id', sa.String(length=100), nullable=False, unique=True),
        sa.Column('component_id', sa.String(length=36), sa.ForeignKey('components.id', ondelete='SET NULL'), nullable=True),
        sa.Column('product_id', sa.String(length=36), sa.ForeignKey('finished_products.id', ondelete='SET NULL'), nullable=True),
        sa.Column('batch_id', sa.String(length=36), sa.ForeignKey('batches.id', ondelete='SET NULL'), nullable=True),
        sa.Column('operation_id', sa.String(length=36), sa.ForeignKey('manufacturing_operations.id'), nullable=False),
        sa.Column('machine_id', sa.String(length=100), nullable=False),
        sa.Column('operator_id', sa.String(length=100), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('event_status', sa.String(length=50), nullable=False),
        sa.Column('result', sa.String(length=50), nullable=False),
        sa.Column('measured_parameters', sa.JSON(), nullable=True),
        sa.Column('inspection_result', sa.String(length=255), nullable=True),
        sa.Column('rework_reference', sa.String(length=100), nullable=True),
        sa.Column('idempotency_key', sa.String(length=100), nullable=True, unique=True),
        sa.Column('source_system', sa.String(length=100), nullable=False, default='MES-01'),
        sa.Column('canonical_payload_hash', sa.String(length=64), nullable=False),
        sa.Column('previous_event_hash', sa.String(length=64), nullable=True),
        sa.Column('signature_metadata', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_mfg_events_event_id', 'manufacturing_events', ['event_id'])
    op.create_index('ix_mfg_events_component_id', 'manufacturing_events', ['component_id'])
    op.create_index('ix_mfg_events_product_id', 'manufacturing_events', ['product_id'])
    op.create_index('ix_mfg_events_hash', 'manufacturing_events', ['canonical_payload_hash'])

    # 8. Shipments
    op.create_table(
        'shipments',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('shipment_id', sa.String(length=100), nullable=False, unique=True),
        sa.Column('origin', sa.String(length=255), nullable=False),
        sa.Column('destination', sa.String(length=255), nullable=False),
        sa.Column('carrier', sa.String(length=100), nullable=False),
        sa.Column('dispatched_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('expected_delivery', sa.DateTime(timezone=True), nullable=True),
        sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', sa.String(length=50), nullable=False),
        sa.Column('custody_metadata', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        'shipment_items',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('shipment_id', sa.String(length=36), sa.ForeignKey('shipments.id', ondelete='CASCADE'), nullable=False),
        sa.Column('product_id', sa.String(length=36), sa.ForeignKey('finished_products.id', ondelete='CASCADE'), nullable=False),
        sa.Column('added_at', sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        'shipment_events',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('event_id', sa.String(length=100), nullable=False, unique=True),
        sa.Column('shipment_id', sa.String(length=36), sa.ForeignKey('shipments.id', ondelete='CASCADE'), nullable=False),
        sa.Column('event_type', sa.String(length=50), nullable=False),
        sa.Column('location', sa.String(length=255), nullable=False),
        sa.Column('custody_party', sa.String(length=100), nullable=False),
        sa.Column('timestamp', sa.DateTime(timezone=True), nullable=False),
        sa.Column('notes', sa.String(length=500), nullable=True),
        sa.Column('source_system', sa.String(length=100), nullable=False),
        sa.Column('verification_metadata', sa.JSON(), nullable=True),
    )

    # 9. Recalls
    op.create_table(
        'recalls',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('recall_id', sa.String(length=100), nullable=False, unique=True),
        sa.Column('affected_batch_id', sa.String(length=36), sa.ForeignKey('batches.id'), nullable=False),
        sa.Column('defect_category', sa.String(length=100), nullable=False),
        sa.Column('severity', sa.String(length=50), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('status', sa.String(length=50), nullable=False),
        sa.Column('created_by', sa.String(length=36), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('confirmed_by', sa.String(length=36), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('resolved_by', sa.String(length=36), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('resolution_notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )

    # 10. Blockchain Checkpoints
    op.create_table(
        'blockchain_checkpoints',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('checkpoint_id', sa.String(length=100), nullable=False, unique=True),
        sa.Column('merkle_root', sa.String(length=66), nullable=False),
        sa.Column('chain_id', sa.Integer(), nullable=False, default=31337),
        sa.Column('contract_address', sa.String(length=42), nullable=True),
        sa.Column('transaction_hash', sa.String(length=66), nullable=True),
        sa.Column('block_number', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=50), nullable=False),
        sa.Column('error_message', sa.String(length=500), nullable=True),
        sa.Column('batch_ids', sa.JSON(), nullable=True),
        sa.Column('event_count', sa.Integer(), nullable=False, default=0),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_bc_checkpoints_root', 'blockchain_checkpoints', ['merkle_root'])

    # 11. Device Security
    op.create_table(
        'device_security_events',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('product_id', sa.String(length=36), sa.ForeignKey('finished_products.id', ondelete='CASCADE'), nullable=False),
        sa.Column('event_type', sa.String(length=100), nullable=False),
        sa.Column('evidence_reference', sa.String(length=255), nullable=False),
        sa.Column('severity', sa.String(length=50), nullable=False),
        sa.Column('verification_status', sa.String(length=50), nullable=False),
        sa.Column('policy_decision', sa.String(length=50), nullable=False),
        sa.Column('command_id', sa.String(length=36), nullable=True),
        sa.Column('notes', sa.String(length=500), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        'device_commands',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('command_id', sa.String(length=100), nullable=False, unique=True),
        sa.Column('product_id', sa.String(length=36), sa.ForeignKey('finished_products.id', ondelete='CASCADE'), nullable=False),
        sa.Column('command_type', sa.String(length=50), nullable=False),
        sa.Column('status', sa.String(length=50), nullable=False),
        sa.Column('issuer_id', sa.String(length=36), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('nonce', sa.String(length=64), nullable=False),
        sa.Column('expiry_time', sa.DateTime(timezone=True), nullable=False),
        sa.Column('signed_payload', sa.JSON(), nullable=True),
        sa.Column('reason', sa.String(length=255), nullable=False),
        sa.Column('evidence_reference', sa.String(length=255), nullable=False),
        sa.Column('execution_report', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('executed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )

    # 12. Audit Logs & Integrations
    op.create_table(
        'audit_logs',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('timestamp', sa.DateTime(timezone=True), nullable=False),
        sa.Column('action', sa.String(length=100), nullable=False),
        sa.Column('entity_type', sa.String(length=100), nullable=False),
        sa.Column('entity_id', sa.String(length=100), nullable=False),
        sa.Column('actor_id', sa.String(length=100), nullable=True),
        sa.Column('actor_role', sa.String(length=50), nullable=True),
        sa.Column('ip_address', sa.String(length=45), nullable=True),
        sa.Column('changes', sa.JSON(), nullable=True),
        sa.Column('status', sa.String(length=50), nullable=False),
        sa.Column('integrity_hash', sa.String(length=64), nullable=True),
    )

    op.create_table(
        'integration_sources',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('name', sa.String(length=100), nullable=False, unique=True),
        sa.Column('source_type', sa.String(length=50), nullable=False),
        sa.Column('status', sa.String(length=50), nullable=False),
        sa.Column('endpoint_url', sa.String(length=255), nullable=True),
        sa.Column('last_sync_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('sync_count', sa.Integer(), nullable=False, default=0),
        sa.Column('error_count', sa.Integer(), nullable=False, default=0),
        sa.Column('config_data', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        'quarantined_events',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('source_id', sa.String(length=100), nullable=False),
        sa.Column('raw_payload', sa.JSON(), nullable=False),
        sa.Column('error_reason', sa.String(length=500), nullable=False),
        sa.Column('resolved', sa.Boolean(), nullable=False, default=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('quarantined_events')
    op.drop_table('integration_sources')
    op.drop_table('audit_logs')
    op.drop_table('device_commands')
    op.drop_table('device_security_events')
    op.drop_table('blockchain_checkpoints')
    op.drop_table('recalls')
    op.drop_table('shipment_events')
    op.drop_table('shipment_items')
    op.drop_table('shipments')
    op.drop_table('manufacturing_events')
    op.drop_table('manufacturing_operations')
    op.drop_table('product_component_relationships')
    op.drop_table('finished_products')
    op.drop_table('components')
    op.drop_table('batches')
    op.drop_table('facilities')
    op.drop_table('suppliers')
    op.drop_table('users')

import hashlib
from typing import Any, Dict, List, Optional, Tuple
from backend.app.core.security import canonical_json_bytes, compute_canonical_hash
from backend.app.models.manufacturing_event import ManufacturingEvent
from backend.app.schemas.manufacturing import EventVerificationResult


class MerkleDAGService:
    @staticmethod
    def compute_event_hash(event_dict: Dict[str, Any]) -> str:
        """
        Computes canonical SHA-256 hash for a manufacturing event.
        Excludes self-hash and internal auto-generated database IDs.
        """
        clean_dict = {
            "event_id": event_dict.get("event_id"),
            "component_id": event_dict.get("component_id"),
            "product_id": event_dict.get("product_id"),
            "batch_id": event_dict.get("batch_id"),
            "operation_id": event_dict.get("operation_id"),
            "machine_id": event_dict.get("machine_id"),
            "operator_id": event_dict.get("operator_id"),
            "started_at": event_dict.get("started_at"),
            "completed_at": event_dict.get("completed_at"),
            "event_status": str(event_dict.get("event_status")),
            "result": str(event_dict.get("result")),
            "measured_parameters": event_dict.get("measured_parameters") or {},
            "inspection_result": event_dict.get("inspection_result"),
            "rework_reference": event_dict.get("rework_reference"),
            "previous_event_hash": event_dict.get("previous_event_hash"),
            "source_system": event_dict.get("source_system", "MES-01"),
        }
        return compute_canonical_hash(clean_dict)

    @staticmethod
    def hash_pair(left: str, right: str) -> str:
        """Combines two SHA-256 hashes in order and hashes them"""
        combined = (left + right).encode("utf-8")
        return hashlib.sha256(combined).hexdigest()

    @classmethod
    def build_merkle_tree(cls, leaf_hashes: List[str]) -> Tuple[str, List[List[str]]]:
        """
        Builds a binary Merkle tree over an array of SHA-256 leaf hashes.
        Returns (merkle_root, levels).
        """
        if not leaf_hashes:
            empty_root = hashlib.sha256(b"GENEATRACE_EMPTY_TREE").hexdigest()
            return empty_root, [[empty_root]]

        # Work on sorted list for determinism
        current_level = sorted(leaf_hashes)
        levels = [current_level]

        while len(current_level) > 1:
            next_level = []
            for i in range(0, len(current_level), 2):
                left = current_level[i]
                right = current_level[i + 1] if i + 1 < len(current_level) else left
                parent = cls.hash_pair(left, right)
                next_level.append(parent)
            current_level = next_level
            levels.append(current_level)

        return current_level[0], levels

    @classmethod
    def generate_proof(cls, leaf_hash: str, leaf_hashes: List[str]) -> List[Dict[str, str]]:
        """Generates audit path proof for inclusion verification"""
        if leaf_hash not in leaf_hashes:
            return []

        sorted_leaves = sorted(leaf_hashes)
        index = sorted_leaves.index(leaf_hash)
        current_level = sorted_leaves
        proof = []

        while len(current_level) > 1:
            is_right_child = (index % 2 == 1)
            sibling_index = index - 1 if is_right_child else index + 1
            if sibling_index >= len(current_level):
                sibling_index = index  # odd element paired with itself

            proof.append({
                "sibling_hash": current_level[sibling_index],
                "direction": "left" if is_right_child else "right",
            })

            # Move up
            next_level = []
            for i in range(0, len(current_level), 2):
                l = current_level[i]
                r = current_level[i + 1] if i + 1 < len(current_level) else l
                next_level.append(cls.hash_pair(l, r))
            current_level = next_level
            index //= 2

        return proof

    @classmethod
    def verify_proof(cls, leaf_hash: str, proof: List[Dict[str, str]], expected_root: str) -> bool:
        """Verifies Merkle audit path proof against expected root"""
        current = leaf_hash
        for item in proof:
            sibling = item["sibling_hash"]
            if item["direction"] == "left":
                current = cls.hash_pair(sibling, current)
            else:
                current = cls.hash_pair(current, sibling)
        return current == expected_root

    @classmethod
    def verify_event_record(
        cls, event: ManufacturingEvent, expected_previous_hash: Optional[str] = None
    ) -> EventVerificationResult:
        """
        Verifies individual event record integrity:
        1. Re-computes canonical payload hash and compares with stored hash
        2. Verifies parent linkage matches expected predecessor
        """
        payload_dict = {
            "event_id": event.event_id,
            "component_id": event.component_id,
            "product_id": event.product_id,
            "batch_id": event.batch_id,
            "operation_id": event.operation_id,
            "machine_id": event.machine_id,
            "operator_id": event.operator_id,
            "started_at": event.started_at,
            "completed_at": event.completed_at,
            "event_status": str(event.event_status),
            "result": str(event.result),
            "measured_parameters": event.measured_parameters or {},
            "inspection_result": event.inspection_result,
            "rework_reference": event.rework_reference,
            "previous_event_hash": event.previous_event_hash,
            "source_system": event.source_system,
        }
        recomputed_hash = cls.compute_event_hash(payload_dict)
        payload_valid = (recomputed_hash == event.canonical_payload_hash)

        parent_valid = True
        if expected_previous_hash is not None:
            parent_valid = (event.previous_event_hash == expected_previous_hash)

        status_str = "VALID" if (payload_valid and parent_valid) else "FAILED_VERIFICATION"
        details = {}
        if not payload_valid:
            details["payload_error"] = f"Calculated {recomputed_hash} != stored {event.canonical_payload_hash}"
        if not parent_valid:
            details["parent_error"] = f"Parent hash {event.previous_event_hash} != expected {expected_previous_hash}"

        return EventVerificationResult(
            event_id=event.event_id,
            canonical_payload_hash=event.canonical_payload_hash,
            expected_hash=recomputed_hash,
            is_payload_valid=payload_valid,
            previous_event_hash=event.previous_event_hash,
            is_parent_link_valid=parent_valid,
            verification_status=status_str,
            details=details,
        )


merkle_service = MerkleDAGService

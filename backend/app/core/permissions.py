from enum import Enum
from typing import List, Set


class UserRole(str, Enum):
    ADMINISTRATOR = "ADMINISTRATOR"
    MANUFACTURER = "MANUFACTURER"
    SUPPLIER = "SUPPLIER"
    QUALITY_INSPECTOR = "QUALITY_INSPECTOR"
    LOGISTICS_OPERATOR = "LOGISTICS_OPERATOR"
    RECALL_MANAGER = "RECALL_MANAGER"
    SECURITY_OFFICER = "SECURITY_OFFICER"
    AUDITOR = "AUDITOR"
    PUBLIC_VERIFIER = "PUBLIC_VERIFIER"


# Role hierarchy and permissions mapping
ROLE_PERMISSIONS = {
    UserRole.ADMINISTRATOR: {"*"},
    UserRole.MANUFACTURER: {
        "batches:create", "batches:read", "components:create", "components:read",
        "manufacturing:create", "manufacturing:read", "assembly:create", "assembly:read",
        "products:create", "products:read", "passports:read", "traceability:read",
        "blockchain:read", "dashboard:read"
    },
    UserRole.SUPPLIER: {
        "batches:read", "components:create", "components:read", "traceability:read"
    },
    UserRole.QUALITY_INSPECTOR: {
        "manufacturing:inspect", "manufacturing:read", "components:read", "batches:read",
        "passports:read", "traceability:read", "dashboard:read"
    },
    UserRole.LOGISTICS_OPERATOR: {
        "shipments:create", "shipments:read", "shipments:event", "products:read", "traceability:read"
    },
    UserRole.RECALL_MANAGER: {
        "recalls:create", "recalls:confirm", "recalls:resolve", "recalls:read",
        "batches:read", "components:read", "products:read", "shipments:read",
        "traceability:read", "dashboard:read"
    },
    UserRole.SECURITY_OFFICER: {
        "security:attestation", "security:evaluate", "security:command", "security:read",
        "security:recovery", "products:read", "dashboard:read"
    },
    UserRole.AUDITOR: {
        "audit:read", "passports:read", "traceability:read", "blockchain:read",
        "recalls:read", "security:read", "dashboard:read"
    },
    UserRole.PUBLIC_VERIFIER: {
        "passports:public_read", "passports:verify"
    },
}


def has_permission(user_role: str, permission: str) -> bool:
    role_enum = UserRole(user_role) if isinstance(user_role, str) else user_role
    permissions = ROLE_PERMISSIONS.get(role_enum, set())
    return "*" in permissions or permission in permissions

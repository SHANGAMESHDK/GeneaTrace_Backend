import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
import bcrypt
import jwt
from backend.app.core.config import settings


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        # Standard bcrypt
        if hashed_password.startswith(("$2a$", "$2b$", "$2y$")):
            return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
        # Fallback verification for SHA-256 prefixed passwords in test environments
        if hashed_password.startswith("sha256$"):
            _, salt, h = hashed_password.split("$")
            computed = hashlib.sha256((plain_password + salt).encode("utf-8")).hexdigest()
            return computed == h
        return False
    except Exception:
        return False


def get_password_hash(password: str) -> str:
    try:
        salt = bcrypt.gensalt(rounds=12)
        return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")
    except Exception:
        salt = "geneatracedevsalt"
        h = hashlib.sha256((password + salt).encode("utf-8")).hexdigest()
        return f"sha256${salt}${h}"


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire, "iat": datetime.now(timezone.utc)})
    encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return encoded_jwt


def decode_access_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        return payload
    except jwt.PyJWTError:
        return None


def canonical_json_bytes(data: Dict[str, Any]) -> bytes:
    """
    Serializes a dict deterministically for hashing:
    - Sorts keys recursively
    - Handles datetimes as ISO-8601 strings
    - Omit calculated hash fields if present
    - No extra whitespace
    """
    def _normalize(val: Any) -> Any:
        if isinstance(val, dict):
            return {k: _normalize(v) for k, v in sorted(val.items()) if k not in ("canonical_payload_hash", "id")}
        elif isinstance(val, (list, tuple)):
            return [_normalize(x) for x in val]
        elif isinstance(val, datetime):
            return val.astimezone(timezone.utc).isoformat()
        elif isinstance(val, float):
            return round(val, 6)
        return val

    normalized = _normalize(data)
    return json.dumps(normalized, sort_keys=True, separators=(',', ':')).encode("utf-8")


def compute_canonical_hash(payload: Dict[str, Any]) -> str:
    """Computes SHA-256 hash of canonical payload bytes"""
    raw_bytes = canonical_json_bytes(payload)
    return hashlib.sha256(raw_bytes).hexdigest()


def mask_imei(imei: Optional[str]) -> Optional[str]:
    """
    Masks IMEI for privacy.
    E.g., '352849102847592' -> '352849******592'
    Never stores or exposes raw IMEI in public endpoints.
    """
    if not imei or len(imei) < 8:
        return None
    return f"{imei[:6]}{'*' * (len(imei) - 9)}{imei[-3:]}"


def compute_identity_commitment(device_id: str, secret_salt: str) -> str:
    """Cryptographic commitment for device identity (salted SHA-256)"""
    return hashlib.sha256(f"{device_id}:{secret_salt}".encode("utf-8")).hexdigest()

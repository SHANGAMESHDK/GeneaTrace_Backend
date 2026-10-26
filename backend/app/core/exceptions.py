from typing import Any, Dict, Optional
from fastapi import HTTPException, status


class GeneaTraceException(HTTPException):
    def __init__(
        self,
        status_code: int,
        error_code: str,
        message: str,
        details: Optional[Dict[str, Any]] = None,
        retryable: bool = False,
    ):
        super().__init__(
            status_code=status_code,
            detail={
                "error_code": error_code,
                "message": message,
                "details": details or {},
                "retryable": retryable,
            },
        )


class EntityNotFoundException(GeneaTraceException):
    def __init__(self, entity_name: str, identifier: str):
        super().__init__(
            status_code=status.HTTP_404_NOT_FOUND,
            error_code="ENTITY_NOT_FOUND",
            message=f"{entity_name} with identifier '{identifier}' was not found.",
        )


class DuplicateEntityException(GeneaTraceException):
    def __init__(self, entity_name: str, identifier: str):
        super().__init__(
            status_code=status.HTTP_409_CONFLICT,
            error_code="DUPLICATE_ENTITY",
            message=f"{entity_name} with identifier '{identifier}' already exists.",
        )


class InvalidOperationException(GeneaTraceException):
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            error_code="INVALID_OPERATION",
            message=message,
            details=details,
        )


class CryptographicIntegrityException(GeneaTraceException):
    def __init__(self, stage: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            error_code="INTEGRITY_VERIFICATION_FAILED",
            message=f"Integrity check failed at stage '{stage}': {message}",
            details=details,
        )


class AuthorizationException(GeneaTraceException):
    def __init__(self, message: str = "Access forbidden"):
        super().__init__(
            status_code=status.HTTP_403_FORBIDDEN,
            error_code="FORBIDDEN",
            message=message,
        )


class ServiceUnavailableException(GeneaTraceException):
    def __init__(self, service_name: str, message: str):
        super().__init__(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            error_code="SERVICE_UNAVAILABLE",
            message=f"External or dependent service '{service_name}' is currently unavailable: {message}",
            retryable=True,
        )

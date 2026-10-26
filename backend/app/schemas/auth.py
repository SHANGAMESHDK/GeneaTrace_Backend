from typing import Optional
from pydantic import BaseModel, EmailStr
from backend.app.core.permissions import UserRole


class LoginRequest(BaseModel):
    username: str
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user_role: str
    username: str


class TokenData(BaseModel):
    user_id: Optional[str] = None
    username: Optional[str] = None
    role: Optional[UserRole] = None


class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str
    full_name: str
    role: UserRole = UserRole.PUBLIC_VERIFIER
    facility_id: Optional[str] = None


class UserResponse(BaseModel):
    id: str
    username: str
    email: str
    full_name: str
    role: UserRole
    is_active: bool
    facility_id: Optional[str] = None

    class Config:
        from_attributes = True

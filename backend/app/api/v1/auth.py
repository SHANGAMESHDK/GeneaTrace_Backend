from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, require_role
from backend.app.core.exceptions import DuplicateEntityException
from backend.app.core.permissions import UserRole
from backend.app.core.security import create_access_token, get_password_hash, verify_password
from backend.app.db.postgres import get_db
from backend.app.models.user import User
from backend.app.schemas.auth import LoginRequest, Token, UserCreate, UserResponse

router = APIRouter(prefix="/auth", tags=["Authentication"])


@router.post("/login", response_model=Token)
def login(login_req: LoginRequest, db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.username == login_req.username)).scalar_one_or_none()
    if not user or not verify_password(login_req.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Inactive account")

    token_str = create_access_token(data={"sub": user.id, "username": user.username, "role": user.role.value})
    return Token(
        access_token=token_str,
        token_type="bearer",
        expires_in=60 * 24 * 60,
        user_role=user.role.value,
        username=user.username,
    )


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register_user(
    user_in: UserCreate,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_role([UserRole.ADMINISTRATOR])),
):
    existing = db.execute(
        select(User).where((User.username == user_in.username) | (User.email == user_in.email))
    ).scalar_one_or_none()
    if existing:
        raise DuplicateEntityException("User", user_in.username)

    new_user = User(
        username=user_in.username,
        email=user_in.email,
        hashed_password=get_password_hash(user_in.password),
        full_name=user_in.full_name,
        role=user_in.role,
        facility_id=user_in.facility_id,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user

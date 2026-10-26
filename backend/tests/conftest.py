import os
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Set test environment
os.environ["APP_ENV"] = "test"
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["BLOCKCHAIN_ENABLED"] = "false"
os.environ["NEO4J_ENABLED"] = "false"

from backend.app.core.config import settings
from backend.app.core.security import create_access_token
from backend.app.db.postgres import get_db
from backend.app.main import app
from backend.app.models.base import Base
from backend.app.models.user import User
from backend.app.core.permissions import UserRole

# In-memory SQLite engine for fast, isolated tests
test_engine = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def db():
    connection = test_engine.connect()
    transaction = connection.begin()
    session = TestingSessionLocal(bind=connection)

    yield session

    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture
def client(db):
    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def test_admin_user(db) -> User:
    user = User(
        username="admin_test",
        email="admin_test@geneatrace.io",
        hashed_password="hashed_pw_test",
        full_name="Admin Tester",
        role=UserRole.ADMINISTRATOR,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def admin_token(test_admin_user: User) -> str:
    return create_access_token(
        data={"sub": test_admin_user.id, "username": test_admin_user.username, "role": test_admin_user.role.value}
    )


@pytest.fixture
def auth_headers(admin_token: str) -> dict:
    return {"Authorization": f"Bearer {admin_token}"}

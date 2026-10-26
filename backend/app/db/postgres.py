from typing import Generator
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import NullPool, QueuePool
from backend.app.core.config import settings
from backend.app.core.logging import logger
from backend.app.models.base import Base


def get_engine():
    db_url = settings.DATABASE_URL
    # Ensure psycopg 3 driver syntax if postgresql:// is provided
    if db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+psycopg://", 1)

    connect_args = {}
    is_sqlite = db_url.startswith("sqlite")

    if is_sqlite:
        connect_args["check_same_thread"] = False
        engine = create_engine(db_url, connect_args=connect_args)
    else:
        # Detect Supabase session/transaction pooler (usually port 6543 or pgbouncer in host)
        is_supabase_pooler = ":6543" in db_url or "pooler" in db_url

        if is_supabase_pooler:
            # NullPool and prepare_threshold=None are required for PgBouncer transaction pooling
            engine = create_engine(
                db_url,
                poolclass=NullPool,
                connect_args={"sslmode": "require", "prepare_threshold": None},
            )
        else:
            # QueuePool with pool_pre_ping for resilient connections
            engine = create_engine(
                db_url,
                poolclass=QueuePool,
                pool_size=settings.DB_POOL_SIZE,
                max_overflow=settings.DB_MAX_OVERFLOW,
                pool_timeout=settings.DB_POOL_TIMEOUT,
                pool_recycle=settings.DB_POOL_RECYCLE,
                pool_pre_ping=True,
            )
    return engine


engine = get_engine()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def init_db():
    """Initializes tables (especially useful in test or dev environments)"""
    if "sqlite" in str(engine.url):
        Base.metadata.create_all(bind=engine)
    else:
        # Schema is managed via Alembic; run create_all safely with fallback
        try:
            Base.metadata.create_all(bind=engine, checkfirst=True)
        except Exception:
            pass


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency for database sessions"""
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def check_postgres_connection() -> dict:
    """Readiness and health check for the relational database"""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"status": "healthy", "database": "connected"}
    except Exception as e:
        logger.error(f"PostgreSQL connection check failed: {str(e)}")
        return {"status": "unhealthy", "database": "disconnected", "error": str(e)}

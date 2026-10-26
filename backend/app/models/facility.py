from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column
from backend.app.models.base import Base, TimestampMixin, UUIDMixin


class Supplier(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "suppliers"

    code: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    contact_email: Mapped[str] = mapped_column(String(255), nullable=True)
    country: Mapped[str] = mapped_column(String(100), nullable=True)


class Facility(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "facilities"

    code: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    location: Mapped[str] = mapped_column(String(255), nullable=True)
    facility_type: Mapped[str] = mapped_column(String(100), nullable=False)  # FABRICATION, ASSEMBLY, TESTING, WAREHOUSE

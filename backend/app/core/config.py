import os
from typing import Any, List, Optional
from pydantic_settings import BaseSettings
from pydantic import Field, field_validator


class Settings(BaseSettings):
    APP_NAME: str = "GeneaTrace Backend"
    APP_ENV: str = Field(default="development", env="APP_ENV")
    DEBUG: bool = Field(default=False, env="DEBUG")
    PORT: int = Field(default=8000, env="PORT")
    HOST: str = Field(default="0.0.0.0", env="HOST")

    # Security
    JWT_SECRET_KEY: str = Field(
        default="geneatrace-insecure-dev-secret-replace-in-production-min32bytes",
        env="JWT_SECRET_KEY",
    )
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 hours

    # CORS
    CORS_ORIGINS: Any = Field(
        default=["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"],
        env="CORS_ORIGINS",
    )

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v: Any) -> List[str]:
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("[") and v.endswith("]"):
                inner = v[1:-1].strip()
                if not inner:
                    return ["*"]
                try:
                    import json
                    parsed = json.loads(v)
                    if isinstance(parsed, list):
                        return [str(item).strip() for item in parsed]
                except Exception:
                    pass
                return [part.strip().strip("'\"") for part in inner.split(",") if part.strip()]
            elif "," in v:
                return [part.strip().strip("'\"") for part in v.split(",") if part.strip()]
            return [v.strip("'\"")]
        elif isinstance(v, list):
            return [str(i) for i in v]
        return ["*"]

    # Relational Database (PostgreSQL / Supabase / SQLite for local tests)
    DATABASE_URL: str = Field(
        default="postgresql://postgres:postgres@localhost:5432/geneatrace",
        env="DATABASE_URL",
    )
    DB_POOL_SIZE: int = Field(default=10, env="DB_POOL_SIZE")
    DB_MAX_OVERFLOW: int = Field(default=20, env="DB_MAX_OVERFLOW")
    DB_POOL_TIMEOUT: int = Field(default=30, env="DB_POOL_TIMEOUT")
    DB_POOL_RECYCLE: int = Field(default=300, env="DB_POOL_RECYCLE")

    # Neo4j Graph Database
    NEO4J_URI: str = Field(default="bolt://localhost:7687", env="NEO4J_URI")
    NEO4J_USERNAME: str = Field(default="neo4j", env="NEO4J_USERNAME")
    NEO4J_PASSWORD: str = Field(default="geneatracepassword", env="NEO4J_PASSWORD")
    NEO4J_ENABLED: bool = Field(default=True, env="NEO4J_ENABLED")

    # Blockchain
    BLOCKCHAIN_RPC_URL: Optional[str] = Field(default=None, env="BLOCKCHAIN_RPC_URL")
    BLOCKCHAIN_CHAIN_ID: int = Field(default=31337, env="BLOCKCHAIN_CHAIN_ID")
    BLOCKCHAIN_CONTRACT_ADDRESS: Optional[str] = Field(default=None, env="BLOCKCHAIN_CONTRACT_ADDRESS")
    BLOCKCHAIN_PRIVATE_KEY: Optional[str] = Field(default=None, env="BLOCKCHAIN_PRIVATE_KEY")
    BLOCKCHAIN_ENABLED: bool = Field(default=False, env="BLOCKCHAIN_ENABLED")

    # Logging
    LOG_LEVEL: str = Field(default="INFO", env="LOG_LEVEL")

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True
        extra = "allow"


settings = Settings()

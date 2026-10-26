from typing import Any, Dict, List, Optional
from neo4j import GraphDatabase, Driver
from backend.app.core.config import settings
from backend.app.core.logging import logger


class Neo4jManager:
    _driver: Optional[Driver] = None
    _is_connected: bool = False

    @classmethod
    def get_driver(cls) -> Optional[Driver]:
        if not settings.NEO4J_ENABLED:
            return None
        if cls._driver is None:
            try:
                cls._driver = GraphDatabase.driver(
                    settings.NEO4J_URI,
                    auth=(settings.NEO4J_USERNAME, settings.NEO4J_PASSWORD),
                    connection_timeout=2.0,
                    max_connection_lifetime=300,
                )
                cls._driver.verify_connectivity()
                cls._is_connected = True
                logger.info("Connected successfully to Neo4j database")
            except Exception as e:
                cls._is_connected = False
                logger.warning(
                    f"Neo4j connection could not be established ({str(e)}). "
                    "GeneaTrace will use high-performance PostgreSQL recursive traversal fallback."
                )
        return cls._driver if cls._is_connected else None

    @classmethod
    def check_connection(cls) -> Dict[str, Any]:
        if not settings.NEO4J_ENABLED:
            return {"status": "disabled", "graph_database": "disabled", "using_fallback": True}
        try:
            driver = cls.get_driver()
            if driver:
                driver.verify_connectivity()
                return {"status": "healthy", "graph_database": "connected", "using_fallback": False}
        except Exception as e:
            pass
        return {
            "status": "fallback_active",
            "graph_database": "offline",
            "using_fallback": True,
            "message": "PostgreSQL recursive lineage fallback is operational."
        }

    @classmethod
    def close(cls):
        if cls._driver:
            cls._driver.close()
            cls._driver = None
            cls._is_connected = False


neo4j_manager = Neo4jManager

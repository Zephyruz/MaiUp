from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

settings = get_settings()
database_url = settings.database_url
if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql+psycopg://", 1)
elif database_url.startswith("postgresql://"):
    database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
engine = create_engine(database_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def ensure_local_owner_columns() -> None:
    """Upgrade the pre-cloud local SQLite database without deleting player data."""
    if engine.dialect.name != "sqlite":
        return
    with engine.begin() as connection:
        inspector = inspect(connection)
        upgrades = (
            ("player_imports", "ix_player_import_owner_created", "created_at"),
            (
                "player_score_snapshots",
                "ix_player_score_snapshot_owner_imported",
                "imported_at",
            ),
        )
        for table_name, index_name, ordered_column in upgrades:
            if not inspector.has_table(table_name):
                continue
            columns = {column["name"] for column in inspector.get_columns(table_name)}
            if "owner_id" not in columns:
                connection.execute(
                    text(
                        f"ALTER TABLE {table_name} ADD COLUMN owner_id "
                        "VARCHAR(64) NOT NULL DEFAULT 'local-development'"
                    )
                )
            connection.execute(
                text(
                    f"CREATE INDEX IF NOT EXISTS {index_name} "
                    f"ON {table_name} (owner_id, {ordered_column})"
                )
            )


def get_db() -> Generator[Session, None, None]:
    with SessionLocal() as session:
        yield session

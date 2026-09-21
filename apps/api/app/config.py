from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_ROOT = PROJECT_ROOT / "data"


@dataclass(frozen=True)
class Settings:
    database_url: str
    dxrating_url: str
    intl_constants_url: str
    intl_constants_version: str
    current_intl_version: str
    intl_config_path: Path
    intl_overrides_path: Path
    raw_catalog_dir: Path
    import_asset_dir: Path
    access_keys: str
    require_access_key: bool
    cors_origins: tuple[str, ...]
    enable_image_import: bool
    sync_catalog_on_start: bool


def get_settings() -> Settings:
    config_path = DATA_ROOT / "config" / "international.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    constant_snapshot = config["constantSnapshot"]
    default_db = (PROJECT_ROOT / "apps" / "api" / "maiup.db").as_posix()
    return Settings(
        database_url=os.getenv("MAIUP_DATABASE_URL", f"sqlite:///{default_db}"),
        dxrating_url=os.getenv(
            "MAIUP_DXRATING_URL",
            "https://miruku.dxrating.net/api/v1/dxdata",
        ),
        intl_constants_url=os.getenv(
            "MAIUP_INTL_CONSTANTS_URL",
            constant_snapshot["url"],
        ),
        intl_constants_version=constant_snapshot["version"],
        current_intl_version=os.getenv(
            "MAIUP_CURRENT_INTL_VERSION",
            config["currentVersion"],
        ),
        intl_config_path=config_path,
        intl_overrides_path=DATA_ROOT / "overrides" / "international_chart_constants.json",
        raw_catalog_dir=DATA_ROOT / "catalog" / "raw",
        import_asset_dir=DATA_ROOT / "imports",
        access_keys=os.getenv("MAIUP_ACCESS_KEYS", ""),
        require_access_key=os.getenv("MAIUP_REQUIRE_ACCESS_KEY", "false").casefold()
        in {"1", "true", "yes"},
        cors_origins=tuple(
            origin.strip()
            for origin in os.getenv(
                "MAIUP_CORS_ORIGINS",
                "http://localhost:3000,http://127.0.0.1:3000",
            ).split(",")
            if origin.strip()
        ),
        enable_image_import=os.getenv("MAIUP_ENABLE_IMAGE_IMPORT", "true").casefold()
        in {"1", "true", "yes"},
        sync_catalog_on_start=os.getenv("MAIUP_SYNC_CATALOG_ON_START", "false").casefold()
        in {"1", "true", "yes"},
    )

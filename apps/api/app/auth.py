from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, HTTPException

from app.config import get_settings


@dataclass(frozen=True)
class Principal:
    owner_id: str
    display_name: str


def _configured_keys() -> dict[str, str]:
    result: dict[str, str] = {}
    for item in get_settings().access_keys.split(","):
        label, separator, key = item.strip().partition(":")
        if separator and label.strip() and key.strip():
            result[label.strip()] = key.strip()
    return result


def _owner_id(label: str) -> str:
    return hashlib.sha256(f"maiup-owner:{label}".encode()).hexdigest()[:32]


def require_principal(
    authorization: Annotated[str | None, Header()] = None,
) -> Principal:
    settings = get_settings()
    configured = _configured_keys()
    if not configured and not settings.require_access_key:
        return Principal(owner_id="local-development", display_name="本机开发")

    prefix = "Bearer "
    supplied = (
        authorization[len(prefix) :].strip()
        if authorization and authorization.startswith(prefix)
        else ""
    )
    for label, expected in configured.items():
        if supplied and hmac.compare_digest(supplied, expected):
            return Principal(owner_id=_owner_id(label), display_name=label)
    raise HTTPException(status_code=401, detail="访问码无效或尚未填写")


CurrentPrincipal = Annotated[Principal, Depends(require_principal)]

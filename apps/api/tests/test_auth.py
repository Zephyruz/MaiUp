from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.auth import require_principal


def test_access_keys_create_stable_separate_owners(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAIUP_ACCESS_KEYS", "alice:alpha-secret,bob:beta-secret")
    monkeypatch.setenv("MAIUP_REQUIRE_ACCESS_KEY", "true")

    alice = require_principal("Bearer alpha-secret")
    bob = require_principal("Bearer beta-secret")

    assert alice.display_name == "alice"
    assert bob.display_name == "bob"
    assert alice.owner_id != bob.owner_id
    assert require_principal("Bearer alpha-secret").owner_id == alice.owner_id


def test_invalid_access_key_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAIUP_ACCESS_KEYS", "alice:alpha-secret")
    monkeypatch.setenv("MAIUP_REQUIRE_ACCESS_KEY", "true")

    with pytest.raises(HTTPException) as error:
        require_principal("Bearer wrong")

    assert error.value.status_code == 401

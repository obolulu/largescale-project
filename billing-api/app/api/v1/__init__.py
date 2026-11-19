"""Version 1 of the public API, mounted at /api/v1.

Phase 2 adds routers here: auth, usage, bills, payments.
"""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok", "version": "v1"}

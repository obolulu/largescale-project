"""Version 1 of the public API, mounted at /api/v1."""

from fastapi import APIRouter

from app.api.v1 import auth, bills, payments, usage

router = APIRouter()


@router.get("/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok", "version": "v1"}


router.include_router(auth.router)
router.include_router(usage.router)
router.include_router(bills.router)
router.include_router(payments.router)

from fastapi import FastAPI

from app.api import v1
from app.errors import install_error_handlers

app = FastAPI(
    title="Mobile Provider Billing API",
    version="1.0.0",
    description=(
        "SE4458 midterm billing service. All routes are versioned under `/api/v1`.\n\n"
        "Protected routes need `Authorization: Bearer <JWT>` from `POST /api/v1/auth/login`. "
        "Subscribers can only act on the subscriber number in their own token."
    ),
)

install_error_handlers(app)
app.include_router(v1.router, prefix="/api/v1")

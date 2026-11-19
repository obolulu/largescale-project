from fastapi import FastAPI

from app.api import v1

app = FastAPI(
    title="Mobile Provider Billing API",
    version="1.0.0",
    description="SE4458 midterm billing service. Swagger UI is served at /docs.",
)

app.include_router(v1.router, prefix="/api/v1")

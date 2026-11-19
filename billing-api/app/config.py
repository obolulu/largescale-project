from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings, read from environment variables or a .env file."""

    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore")

    database_url: str = "postgresql+psycopg://billing:billing_dev_password@localhost:5432/billing"
    jwt_secret: str = "local-dev-only-secret-change-me-in-cloud-0001"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60
    # The gateway's validate-jwt policy checks these too.
    jwt_issuer: str = "billing-api"
    jwt_audience: str = "billing-clients"


@lru_cache
def get_settings() -> Settings:
    return Settings()

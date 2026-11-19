"""Reject database credentials that bypass the API policy trivially."""

from urllib.parse import unquote, urlsplit
import secrets

from .policy import AccessPolicy


def database_password(database_url: str, *, policy: AccessPolicy, setting: str) -> str:
    message = f"{setting} must use an explicit username and a distinct database password of at least 32 printable non-space ASCII characters; default pg0/peer credentials are not accepted"
    try:
        parts = urlsplit(database_url)
        if parts.scheme not in {"postgres", "postgresql", "pg0"} or not parts.hostname:
            raise ValueError(message)
        username = unquote(parts.username or "")
        password = unquote(parts.password or "")
        if not username or len(password) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in password):
            raise ValueError(message)
        if password in {policy.router_key, policy.worker_key, policy.management_key}:
            raise ValueError(message)
        # Force validation of a malformed authority/port without exposing its URL.
        parts.port
        return password
    except (ValueError, UnicodeError):
        raise ValueError(message) from None


def validate_database_config(database_url: str, config, *, policy: AccessPolicy) -> tuple[str, ...]:
    passwords = [database_password(database_url, policy=policy, setting="HINDSIGHT_API_DATABASE_URL")]
    for attr, setting in (
        ("read_database_url", "HINDSIGHT_API_READ_DATABASE_URL"),
        ("migration_database_url", "HINDSIGHT_API_MIGRATION_DATABASE_URL"),
    ):
        value = getattr(config, attr, None)
        if value:
            passwords.append(database_password(value, policy=policy, setting=setting))
    return tuple(passwords)


async def verify_password_authentication(database_url: str) -> None:
    import asyncpg

    try:
        connection = await asyncpg.connect(database_url, password="moco-invalid-" + secrets.token_urlsafe(32), timeout=5)
    except asyncpg.InvalidPasswordError:
        return
    except Exception:
        raise RuntimeError("Could not verify database password authentication; memory service was not started") from None
    else:
        await connection.close()
        raise RuntimeError("Database accepts an incorrect password; trust/peer authentication cannot protect private memory")


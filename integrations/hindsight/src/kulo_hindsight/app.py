"""Start the existing Hindsight API with Kulo's in-process access policy."""

from __future__ import annotations

from importlib.metadata import version

from .policy import AccessPolicy

SUPPORTED_HINDSIGHT_VERSION = "1.2.1"


def secure_app(memory, *, policy: AccessPolicy, initialize_memory: bool = True, database_url: str | None = None):
    from hindsight_api.api import create_app as create_hindsight_app
    from hindsight_api.config import get_config

    from .database import validate_database_config, verify_password_authentication
    from .extensions import KuloOperationValidator, KuloTenantExtension
    from .middleware import KuloAccessMiddleware

    if not isinstance(memory.tenant_extension, KuloTenantExtension):
        raise ValueError("KuloTenantExtension must be installed on the Hindsight engine")
    if not isinstance(memory._operation_validator, KuloOperationValidator):
        raise ValueError("KuloOperationValidator must be installed on the Hindsight engine")
    if memory.tenant_extension.policy != policy or memory._operation_validator.policy != policy:
        raise ValueError("Hindsight transport and engine must use the same Kulo memory policy")
    # An embedded engine clears db_url until initialize() resolves pg0 to TCP.
    # The entrypoint retains the configured URL for the pre-start credential check.
    validate_database_config(database_url if database_url is not None else memory.db_url, get_config(), policy=policy)
    app = create_hindsight_app(
        memory=memory,
        http_api_enabled=True,
        mcp_api_enabled=False,
        initialize_memory=initialize_memory,
    )
    app.add_middleware(KuloAccessMiddleware, policy=policy)
    from contextlib import asynccontextmanager

    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def authenticated_database_lifespan(instance):
        # pg0 is resolved to a PostgreSQL URI during the upstream startup.
        async with original_lifespan(instance):
            config = get_config()
            urls = {memory.db_url}
            urls.update(value for value in (config.read_database_url, config.migration_database_url) if value)
            for url in urls:
                await verify_password_authentication(url)
            yield

    app.router.lifespan_context = authenticated_database_lifespan
    return app


def create_app(*, load_environment: bool = True):
    from hindsight_api.config import get_config, load_dotenv_for_entrypoint

    if load_environment:
        load_dotenv_for_entrypoint()
    if version("hindsight-api-slim") != SUPPORTED_HINDSIGHT_VERSION:
        raise RuntimeError(f"Kulo memory authorization requires hindsight-api-slim {SUPPORTED_HINDSIGHT_VERSION}")
    policy = AccessPolicy.from_env()
    config = get_config()
    from .database import validate_database_config

    passwords = validate_database_config(config.database_url, config, policy=policy)
    config.configure_logging()
    _redact_logging(tuple(value for value in (policy.router_key, policy.worker_key, policy.management_key, config.llm_api_key, *passwords) if value))

    from hindsight_api import MemoryEngine

    from .extensions import KuloOperationValidator, KuloTenantExtension

    memory = MemoryEngine(
        tenant_extension=KuloTenantExtension({}, policy=policy),
        operation_validator=KuloOperationValidator({}, policy=policy),
        run_migrations=config.run_migrations_on_startup,
    )
    return secure_app(memory, policy=policy, database_url=config.database_url)


def _redact_logging(secrets: tuple[str, ...]) -> None:
    import logging
    import traceback
    from urllib.parse import quote

    values = {value for secret in secrets for value in (secret, quote(secret, safe=""))}

    class RedactCredentials(logging.Filter):
        def filter(self, record):
            def redact(value):
                if isinstance(value, str):
                    for secret in values:
                        value = value.replace(secret, "[REDACTED]")
                elif isinstance(value, tuple):
                    value = tuple(redact(item) for item in value)
                elif isinstance(value, dict):
                    value = {key: redact(item) for key, item in value.items()}
                return value

            # Uvicorn's access formatter unpacks the original five arguments.
            # Keep their structure instead of flattening the rendered message.
            record.msg, record.args = redact(record.msg), redact(record.args)
            if record.exc_info:
                exception = "".join(traceback.format_exception(*record.exc_info))
                for value in values:
                    exception = exception.replace(value, "[REDACTED]")
                record.exc_text, record.exc_info = exception, None
            return True

    # Upstream pg0 logs its connection URI. Redact on handlers, including
    # non-propagating loggers, before constructing/starting the engine.
    loggers = [logging.getLogger(), *[logger for logger in logging.Logger.manager.loggerDict.values() if isinstance(logger, logging.Logger)]]
    handlers = {handler for logger in loggers for handler in logger.handlers}
    for handler in handlers:
        handler.addFilter(RedactCredentials())


def main():
    import uvicorn
    from hindsight_api.config import get_config, load_dotenv_for_entrypoint

    load_dotenv_for_entrypoint()
    config = get_config()
    uvicorn.run("kulo_hindsight.app:create_app", factory=True, host=config.host or "127.0.0.1", port=config.port)


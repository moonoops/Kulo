"""Run one Kulo-owned service from its private configuration, without dotenv discovery."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import stat

OWNER = "kulo-managed-hindsight-v1"


def load_runtime(file: Path) -> dict[str, str]:
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError("Managed service configuration must be a private regular file")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise ValueError("Managed service configuration belongs to another user")
    value = json.loads(file.read_text())
    env = value.get("env")
    if value.get("owner") != OWNER or not isinstance(env, dict):
        raise ValueError("Invalid managed service configuration")
    if any(not isinstance(key, str) or not isinstance(item, str) or not key.startswith(("KULO_HINDSIGHT_", "HINDSIGHT_API_")) or "\0" in item for key, item in env.items()):
        raise ValueError("Invalid managed service environment")
    if env.get("HINDSIGHT_API_HOST") != "127.0.0.1":
        raise ValueError("Managed memory must bind to loopback")
    return env


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--stop-database", action="store_true")
    args = parser.parse_args()
    env = load_runtime(args.config)
    for key in list(os.environ):
        if key.startswith(("KULO_HINDSIGHT_", "HINDSIGHT_API_")):
            del os.environ[key]
    os.environ.update(env)
    if args.stop_database:
        from hindsight_api.pg0 import EmbeddedPostgres, parse_pg0_url

        parsed = parse_pg0_url(env["HINDSIGHT_API_DATABASE_URL"])
        if not parsed.is_pg0:
            raise ValueError("Managed database must use pg0")
        pg = EmbeddedPostgres(name=parsed.instance_name, username=parsed.username, password=parsed.password)
        asyncio.run(pg.stop())
        return
    from hindsight_api.config import clear_config_cache, get_config
    from .app import create_app
    import uvicorn

    clear_config_cache()
    app = create_app(load_environment=False)
    config = get_config()
    # create_app installed redaction on the configured handlers; don't replace them.
    uvicorn.run(app, host="127.0.0.1", port=config.port, access_log=False, log_config=None)


if __name__ == "__main__":
    main()

"""Fail-closed admission in Hindsight's own ASGI process, without proxying requests."""

from __future__ import annotations

import re

from starlette.responses import JSONResponse

from .policy import AccessPolicy

_BANK_PATH = re.compile(r"/v1/default/banks/([^/]+)(/.*)?\Z")
_DOC_ID = r"(?!export\Z)[^/%\\\x00-\x20]+"
_PAGE_ID = r"(?!(?:tree|search|export|folders|nodes)\Z)[^/%\\\x00-\x20]+"
_NODE_ID = r"(?!export\Z)[^/%\\\x00-\x20]+"
_MENTAL_MODEL_ID = r"(?!export\Z)[^/%\\\x00-\x20]+"
_MEMORY_ID = r"(?!(?:list|recall|dry-run-extract|export)\Z)[^/%\\\x00-\x20]+"
_OP_ID = r"[^/%\\\x00-\x20]+"

# Keep this surface aligned with Moco's reviewed Hindsight 1.2.1 memory tools.
# Single-object regexes explicitly exclude reserved collection/export subpaths.
_READ_ROUTES = (
    ("POST", re.compile(r"/memories/recall\Z")),
    ("POST", re.compile(r"/reflect\Z")),
    ("GET", re.compile(r"/documents\Z")),
    ("GET", re.compile(rf"/documents/{_DOC_ID}\Z")),
    ("GET", re.compile(rf"/memories/{_MEMORY_ID}\Z")),
    ("GET", re.compile(r"/(?:knowledge-base|pages)/(?:tree|search)\Z")),
    ("GET", re.compile(rf"/(?:knowledge-base/pages|pages)/{_PAGE_ID}\Z")),
    ("GET", re.compile(r"/mental-models\Z")),
    ("GET", re.compile(rf"/mental-models/{_MENTAL_MODEL_ID}\Z")),
    ("GET", re.compile(rf"/operations/{_OP_ID}\Z")),
)
_WRITE_ROUTES = (
    ("POST", re.compile(r"/memories\Z")),
    ("POST", re.compile(r"/knowledge-base/(?:folders|pages)\Z")),
    ("POST", re.compile(r"/pages(?:/folders)?\Z")),
    ("PATCH", re.compile(rf"/(?:knowledge-base|pages)/nodes/{_NODE_ID}\Z")),
)
# Memory invalidation and Mental Model creation/refresh are restricted to Router (private bank) or manager.
_PRIVATE_CURATION_WRITE_ROUTES = (
    ("PATCH", re.compile(rf"/memories/{_MEMORY_ID}\Z")),
    ("POST", re.compile(r"/mental-models\Z")),
    ("POST", re.compile(rf"/mental-models/{_MENTAL_MODEL_ID}/refresh\Z")),
)
_MANAGEMENT_ROUTES = (
    ("GET", re.compile(r"/config\Z")),
    ("PATCH", re.compile(r"/config\Z")),
    ("DELETE", re.compile(rf"/documents/{_DOC_ID}\Z")),
    ("DELETE", re.compile(rf"/operations/{_OP_ID}\Z")),
)


class MocoAccessMiddleware:
    def __init__(self, app, *, policy: AccessPolicy):
        self.app = app
        self.policy = policy

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        if scope["type"] != "http":
            return

        authorization = [value for key, value in scope.get("headers", []) if key.lower() == b"authorization"]
        role = None
        if len(authorization) == 1:
            raw = authorization[0].decode("latin-1")
            scheme, separator, token = raw.partition(" ")
            if separator and scheme.lower() == "bearer":
                role = self.policy.role_for_key(token)
        if role is None:
            return await JSONResponse(
                {"detail": "Invalid memory credential"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )(scope, receive, send)

        path = scope.get("path", "")
        method = scope["method"]
        if path == "/v1/moco/access" and method == "GET":
            return await JSONResponse(self.policy.describe(role), headers={"Cache-Control": "no-store"})(scope, receive, send)
        if path in {"/v1/version", "/version"} and method == "GET":
            return await self.app(scope, receive, send)

        match = _BANK_PATH.fullmatch(path)
        if match:
            bank_id, suffix = match.group(1), match.group(2) or ""
            read = any(method == verb and pattern.fullmatch(suffix) for verb, pattern in _READ_ROUTES)
            write = any(method == verb and pattern.fullmatch(suffix) for verb, pattern in _WRITE_ROUTES)
            curation_write = role in {"router", "manager"} and any(
                method == verb and pattern.fullmatch(suffix) for verb, pattern in _PRIVATE_CURATION_WRITE_ROUTES
            )
            management = role == "manager" and any(method == verb and pattern.fullmatch(suffix) for verb, pattern in _MANAGEMENT_ROUTES)
            if management and self.policy.allows(role, bank_id, write=True):
                return await self.app(scope, receive, send)
            if curation_write and self.policy.allows(role, bank_id, write=True):
                return await self.app(scope, receive, send)
            if (read or write) and self.policy.allows(role, bank_id, write=write):
                return await self.app(scope, receive, send)

        # Reject before request-body parsing or any data access. This also blocks
        # global bank lists, MCP, model traces, metrics, exports, aliases and clones.
        return await JSONResponse({"detail": "Memory access denied"}, status_code=403)(scope, receive, send)

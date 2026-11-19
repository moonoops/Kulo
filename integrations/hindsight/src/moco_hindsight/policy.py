"""One fixed bank map shared by transport and engine authorization."""

from __future__ import annotations

import hmac
import os
import re
from dataclasses import dataclass, field
from typing import Literal, Mapping

Role = Literal["router", "worker", "manager"]
POLICY_VERSION = 1
_BANK_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_TOKEN = re.compile(r"[\x21-\x7e]{32,8192}\Z")


@dataclass(frozen=True)
class AccessPolicy:
    router_key: str = field(repr=False)
    worker_key: str = field(repr=False)
    private_bank: str = "moco-core"
    shared_bank: str = "moco-shared"
    schema: str = "public"
    management_key: str | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not _TOKEN.fullmatch(self.router_key) or not _TOKEN.fullmatch(self.worker_key):
            raise ValueError("Both Moco memory keys must contain 32–8192 printable non-space ASCII characters")
        if hmac.compare_digest(self.router_key, self.worker_key):
            raise ValueError("Router and Worker memory keys must be different")
        if self.management_key is not None:
            if not _TOKEN.fullmatch(self.management_key):
                raise ValueError("Management key must contain 32–8192 printable non-space ASCII characters")
            if self.management_key in (self.router_key, self.worker_key):
                raise ValueError("Management and runtime keys must be different")
        if not _BANK_ID.fullmatch(self.private_bank) or not _BANK_ID.fullmatch(self.shared_bank):
            raise ValueError("Moco bank IDs must be 1–128 ASCII letters, digits, dots, underscores or dashes, starting with a letter or digit")
        if self.private_bank.casefold() == self.shared_bank.casefold():
            raise ValueError("Private and shared bank IDs must be different")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", self.schema):
            raise ValueError("Invalid Hindsight schema name")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "AccessPolicy":
        values = os.environ if env is None else env
        return cls(
            router_key=values.get("MOCO_HINDSIGHT_ROUTER_API_KEY", ""),
            worker_key=values.get("MOCO_HINDSIGHT_WORKER_API_KEY", ""),
            private_bank=values.get("MOCO_HINDSIGHT_PRIVATE_BANK", "moco-core"),
            shared_bank=values.get("MOCO_HINDSIGHT_SHARED_BANK", "moco-shared"),
            schema=values.get("HINDSIGHT_API_DATABASE_SCHEMA", "public"),
            management_key=values.get("MOCO_HINDSIGHT_MANAGEMENT_API_KEY") or None,
        )

    def role_for_key(self, key: str | None) -> Role | None:
        candidate = key or ""
        # Evaluate both comparisons even when the first key matches.
        router = hmac.compare_digest(candidate.encode(), self.router_key.encode())
        worker = hmac.compare_digest(candidate.encode(), self.worker_key.encode())
        manager = hmac.compare_digest(candidate.encode(), (self.management_key or "").encode()) and self.management_key is not None
        return "router" if router else "worker" if worker else "manager" if manager else None

    def allows(self, role: Role, bank_id: str, *, write: bool) -> bool:
        if role == "manager":
            return bank_id in (self.private_bank, self.shared_bank)
        if role == "router":
            return bank_id == self.private_bank or (bank_id == self.shared_bank and not write)
        return bank_id == self.shared_bank

    def describe(self, role: Role) -> dict:
        return {
            "policyVersion": POLICY_VERSION,
            "role": role,
            "banks": {
                kind: {
                    "id": bank_id,
                    "read": self.allows(role, bank_id, write=False),
                    "write": self.allows(role, bank_id, write=True),
                }
                for kind, bank_id in (("private", self.private_bank), ("shared", self.shared_bank))
            },
        }


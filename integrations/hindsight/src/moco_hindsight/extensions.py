"""Official Hindsight extension slots; authorization also runs after alias resolution."""

from hindsight_api.extensions import OperationValidatorExtension, ValidationResult
from hindsight_api.extensions.tenant import AuthenticationError, Tenant, TenantContext, TenantExtension

from .policy import AccessPolicy

_SHARED_PAGE_WRITE_OPS = frozenset({
    "create_knowledge_folder",
    "create_knowledge_page",
    "create_page_folder",
    "create_page",
    "update_knowledge_page",
    "rename_knowledge_node",
    "move_knowledge_node",
})

_PRIVATE_CURATION_WRITE_OPS = frozenset({
    "create_mental_model",
    "update_mental_model",
    "update_memory_unit",
})


class MocoTenantExtension(TenantExtension):
    def __init__(self, config: dict[str, str], *, policy: AccessPolicy | None = None):
        super().__init__(config)
        self.policy = policy or AccessPolicy.from_env()

    async def authenticate(self, context) -> TenantContext:
        if self.policy.role_for_key(context.api_key) is None:
            raise AuthenticationError("Invalid memory credential")
        return TenantContext(schema_name=self.policy.schema)

    async def list_tenants(self) -> list[Tenant]:
        return [Tenant(schema=self.policy.schema)]

    async def get_allowed_config_fields(self, context, bank_id: str) -> set[str]:
        if self.policy.role_for_key(getattr(context, "api_key", None)) == "manager" and bank_id in (self.policy.private_bank, self.policy.shared_bank):
            return {"retain_extraction_mode", "store_document_text", "enable_observations", "enable_auto_consolidation", "retain_strategies", "retain_mission", "observations_mission"}
        return set()


class MocoOperationValidator(OperationValidatorExtension):
    def __init__(self, config: dict[str, str], *, policy: AccessPolicy | None = None):
        super().__init__(config)
        self.policy = policy or AccessPolicy.from_env()

    def _role(self, ctx) -> str | None:
        request = ctx.request_context
        return self.policy.role_for_key(request.api_key if request is not None else None)

    def _is_internal(self, ctx) -> bool:
        request = ctx.request_context
        return bool(request is not None and request.internal)

    def _authorize(self, ctx, *, write: bool) -> ValidationResult:
        if ctx.bank_id not in (self.policy.private_bank, self.policy.shared_bank):
            return ValidationResult.reject("Memory access denied", status_code=403)
        # Hindsight creates this flag for its own background jobs; HTTP bodies do
        # not populate RequestContext. Submission is authorized before queuing.
        if self._is_internal(ctx):
            return ValidationResult.accept()
        role = self._role(ctx)
        if role is None:
            return ValidationResult.reject("Invalid memory credential", status_code=401)
        if not self.policy.allows(role, ctx.bank_id, write=write):
            return ValidationResult.reject("Memory access denied", status_code=403)
        return ValidationResult.accept()

    async def precheck(self, ctx) -> ValidationResult:
        operation = str(ctx.operation)
        if operation not in {"recall", "reflect", "retain", "mental_model_create", "mental_model_refresh"}:
            return ValidationResult.reject("Memory operation is not available", status_code=403)
        if operation in {"mental_model_create", "mental_model_refresh"} and not self._is_internal(ctx):
            if self._role(ctx) not in {"router", "manager"}:
                return ValidationResult.reject("Mental model writes require private bank curation privilege", status_code=403)
        return self._authorize(ctx, write=operation not in {"recall", "reflect"})

    async def validate_retain(self, ctx) -> ValidationResult:
        return self._authorize(ctx, write=True)

    async def validate_recall(self, ctx) -> ValidationResult:
        return self._authorize(ctx, write=False)

    async def validate_reflect(self, ctx) -> ValidationResult:
        return self._authorize(ctx, write=False)

    async def validate_bank_read(self, ctx) -> ValidationResult:
        if str(ctx.operation) == "export_knowledge_base" and not self._is_internal(ctx) and self._role(ctx) != "manager":
            return ValidationResult.reject("Knowledge base export is disabled for runtime credentials", status_code=403)
        return self._authorize(ctx, write=False)

    async def validate_bank_write(self, ctx) -> ValidationResult:
        allowed = self._authorize(ctx, write=True)
        if not allowed.allowed:
            return allowed
        role = self._role(ctx)
        if role == "manager" or self._is_internal(ctx):
            return allowed
        operation = str(ctx.operation)
        if operation in _SHARED_PAGE_WRITE_OPS:
            return allowed
        if operation in _PRIVATE_CURATION_WRITE_OPS and role == "router":
            return allowed
        return ValidationResult.reject("Bank management is not available to memory runtime credentials", status_code=403)

    async def validate_create_bank(self, ctx) -> ValidationResult:
        return self._authorize(ctx, write=True)

    async def validate_import(self, ctx) -> ValidationResult:
        return ValidationResult.reject("Bank import is not available to memory runtime credentials", status_code=403)

    async def validate_consolidate(self, ctx) -> ValidationResult:
        return self._authorize(ctx, write=True)

    async def validate_mental_model_get(self, ctx) -> ValidationResult:
        return self._authorize(ctx, write=False)

    async def validate_mental_model_refresh(self, ctx) -> ValidationResult:
        if not self._is_internal(ctx) and self._role(ctx) not in {"router", "manager"}:
            return ValidationResult.reject("Mental model refresh requires private bank curation privilege", status_code=403)
        return self._authorize(ctx, write=True)

    async def validate_mental_model_candidate(self, ctx) -> ValidationResult:
        return self._authorize(ctx, write=True)

    async def validate_memory_update(self, ctx) -> ValidationResult:
        if not self._is_internal(ctx) and self._role(ctx) not in {"router", "manager"}:
            return ValidationResult.reject("Memory invalidation requires private bank curation privilege", status_code=403)
        return self._authorize(ctx, write=True)

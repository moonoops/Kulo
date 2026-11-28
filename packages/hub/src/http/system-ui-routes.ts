import {
  isDesktopSystemPermissions,
  type DesktopSystemPermissions,
  type UiActionInput,
} from "@kulo/protocol";
import { DeviceConnectionError } from "../devices.js";
import { UiCardError } from "../ui-cards.js";
import type { HubHttpRouteContext } from "./context.js";

/** Handles `/api/envs/:envId/system-permissions(/guide)?` routes. */
export async function handleSystemPermissionsRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, pathname, readJsonObject, sendJson, requestOrigin } = ctx;
  const systemPermissionsRoute = /^\/api\/envs\/([^/]+)\/system-permissions(\/guide)?$/.exec(pathname);
  if (!systemPermissionsRoute) return false;

  res.setHeader("cache-control", "no-store");
  if (
    req.headers["sec-fetch-site"] === "cross-site" ||
    (req.headers.origin && req.headers.origin !== requestOrigin(req))
  ) {
    throw new DeviceConnectionError("请在 Kulo 中检查和授权系统权限。", 403, "system_permissions_origin_required");
  }
  const guide = Boolean(systemPermissionsRoute[2]);
  if (req.method !== (guide ? "POST" : "GET")) {
    sendJson(res, 405, { error: "此系统权限接口不支持该操作。", code: "system_permissions_method_not_allowed" });
    return true;
  }
  let envId: string;
  try {
    envId = decodeURIComponent(systemPermissionsRoute[1]!);
  } catch {
    throw new DeviceConnectionError("设备标识无效。", 400, "system_permissions_invalid_device");
  }
  if (!envId || envId.length > 256 || /[\x00-\x1f\x7f]/.test(envId)) {
    throw new DeviceConnectionError("设备标识无效。", 400, "system_permissions_invalid_device");
  }
  let guideKind: "accessibility" | "screen" | undefined;
  if (guide) {
    const body = await readJsonObject(req, 1024);
    if (Object.keys(body).some((key) => key !== "kind") || (body.kind !== "accessibility" && body.kind !== "screen")) {
      throw new DeviceConnectionError("请选择需要授权的桌面权限。", 400, "system_permissions_invalid_request");
    }
    guideKind = body.kind;
  }
  const descriptor = hub.envManager.getEnvDescriptor(envId);
  if (!descriptor) throw new DeviceConnectionError("未找到此设备，请刷新设备列表。", 404, "system_permissions_device_not_found");
  if (!descriptor.online) throw new DeviceConnectionError("设备已离线，请连接后重新检查。", 503, "system_permissions_device_offline");
  if (descriptor.platform !== "darwin") {
    if (guide) throw new DeviceConnectionError("此设备不支持 macOS 系统权限引导。", 409, "system_permissions_unsupported");
    sendJson(res, 200, {
      platform: descriptor.platform,
      permissions: [
        { kind: "accessibility", state: "unsupported" },
        { kind: "screen", state: "unsupported" },
      ],
    } satisfies DesktopSystemPermissions);
    return true;
  }
  if (!descriptor.capabilities.includes("agent-desktop")) {
    throw new DeviceConnectionError("请在目标设备启用桌面操作后重新检查。", 409, "system_permissions_desktop_disabled");
  }
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", onClose);
  try {
    const result = await hub.envManager
      .requestComputerUse(
        envId,
        guide ? { tool: "desktop", action: "permission-guide", kind: guideKind } : { tool: "desktop", action: "permissions" },
        controller.signal,
      )
      .catch(() => {
        throw new DeviceConnectionError(
          "设备未能确认权限状态，请检查连接后重试；旧版本设备需要先更新。",
          503,
          "system_permissions_device_unavailable",
        );
      });
    if (!result.ok) {
      const updateRequired = ["INVALID_INPUT", "CLI_INVALID_OUTPUT", "INVALID_TOOL_OUTPUT"].includes(
        result.error?.code ?? "",
      );
      throw new DeviceConnectionError(
        updateRequired
          ? "目标设备尚不支持此权限操作，请更新设备后重试。"
          : guide
            ? "未能开启系统权限引导，请在目标设备检查系统设置后重试。"
            : "未能检查系统权限，请检查目标设备的桌面工具后重试。",
        502,
        updateRequired ? "system_permissions_update_required" : "system_permissions_check_failed",
      );
    }
    if (
      !isDesktopSystemPermissions(result.data) ||
      result.data.platform !== descriptor.platform ||
      (guide ? result.data.guide === undefined : result.data.guide !== undefined)
    ) {
      throw new DeviceConnectionError(
        "目标设备返回的权限状态无效，请更新设备后重新检查。",
        502,
        "system_permissions_invalid_response",
      );
    }
    if (!res.destroyed) sendJson(res, 200, result.data);
  } finally {
    res.off("close", onClose);
  }
  return true;
}

/** Handles `/api/ui/cards/:cardId(/actions)?` routes. */
export async function handleUiCardRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, pathname, readJsonBody, sendJson } = ctx;
  const uiRoute = /^\/api\/ui\/cards\/([^/]+)(\/actions)?$/.exec(pathname);
  if (!uiRoute) return false;

  const cardId = decodeURIComponent(uiRoute[1]!);
  if (req.method === "GET" && !uiRoute[2]) {
    const card = await hub.uiCards.get(cardId);
    if (!card) throw new UiCardError("ui_card_not_found", "卡片不存在。", 404);
    sendJson(res, 200, { card });
    return true;
  }
  if (req.method === "POST" && uiRoute[2]) {
    const body = (await readJsonBody(req, 128 * 1024)) as UiActionInput;
    if (!body || body.cardId !== cardId) throw new UiCardError("invalid_ui_action", "卡片操作格式无效。");
    sendJson(res, 200, await hub.submitUiAction(body, { approverPrincipalId: ctx.authority.principalId }));
    return true;
  }
  return false;
}

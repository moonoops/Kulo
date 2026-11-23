import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { ANDROID_INITIAL_ACTION_TOOLS, ANDROID_INITIAL_TOOLS } from "@kulo/protocol";

/**
 * Extension selected on mixed Computer + Android Workers/Subagents so the initial Android tools
 * remain deferred on Computer Workers while staying resident on pure Android Workers.
 */
export function createComputerMixedAndroidTierExtension() {
  return defineExtension({
    name: "kulo-computer-mixed-android-tier",
    wraps: ANDROID_INITIAL_TOOLS.map((name) => ({
      tool: name,
      wrap: (tool: ToolRegistration): ToolRegistration => ({ ...tool, deferred: true }),
    })),
  });
}

/**
 * Extension selected on read-only Android Workers/Subagents so mutating core phone actions
 * remain deferred (and still rejected at runtime by `scope.readOnly`) while read-only tools stay resident.
 */
export function createReadOnlyAndroidTierExtension() {
  return defineExtension({
    name: "kulo-readonly-android-tier",
    wraps: ANDROID_INITIAL_ACTION_TOOLS.map((name) => ({
      tool: name,
      wrap: (tool: ToolRegistration): ToolRegistration => ({ ...tool, deferred: true }),
    })),
  });
}

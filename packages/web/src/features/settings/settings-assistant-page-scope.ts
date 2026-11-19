import type { SettingsAssistantModule } from "@moco/protocol";

export interface SettingsAssistantPageScope {
  active: boolean;
  module: SettingsAssistantModule;
  generation: number;
}

export function advanceSettingsAssistantPageScope(
  previous: SettingsAssistantPageScope,
  active: boolean,
  module: SettingsAssistantModule,
): SettingsAssistantPageScope {
  return previous.active === active && previous.module === module
    ? previous
    : { active, module, generation: previous.generation + 1 };
}

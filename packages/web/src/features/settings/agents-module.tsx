import { useI18n } from "../../moco-i18n";
import { useEffect, useState } from "react";
import { Tabs } from "@heroui/react";
import type { EnvNodeDescriptor, MocoSettingsView, ProjectView, SlotSummary } from "@moco/protocol";
import { ConcurrencyModule } from "./concurrency-module";
import { WorkersModule } from "./workers-module";

export function AgentsModule({ settings, slots, envs, projects, onSettingsUpdated, onDirtyChange }: {
  settings: MocoSettingsView;
  slots?: SlotSummary;
  envs?: EnvNodeDescriptor[];
  projects?: Pick<ProjectView, "id" | "name">[];
  onSettingsUpdated: (settings: MocoSettingsView) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const [agentsDirty, setAgentsDirty] = useState(false);
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const dirty = agentsDirty || runtimeDirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  return <Tabs defaultSelectedKey="agents" className="flex min-w-0 flex-1 flex-col gap-6">
    <Tabs.ListContainer className="w-fit max-w-full min-w-0 shrink-0">
      <Tabs.List aria-label={t("智能体设置", "Agents")} className="w-max">
        <Tabs.Tab id="agents" className="w-auto shrink-0 whitespace-nowrap">{t("智能体", "Agents")}<Tabs.Indicator /></Tabs.Tab>
        <Tabs.Tab id="runtime" className="w-auto shrink-0 whitespace-nowrap">{t("运行设置", "Runtime")}<Tabs.Indicator /></Tabs.Tab>
      </Tabs.List>
    </Tabs.ListContainer>
    <Tabs.Panel id="agents" shouldForceMount className="mt-0 min-w-0 flex-1 p-0 data-[inert]:hidden">
      <WorkersModule settings={settings} envs={envs} projects={projects} onSettingsUpdated={onSettingsUpdated} onDirtyChange={setAgentsDirty} />
    </Tabs.Panel>
    <Tabs.Panel id="runtime" shouldForceMount className="mt-0 min-w-0 flex-1 p-0 data-[inert]:hidden">
      <ConcurrencyModule settings={settings} slots={slots} onSettingsUpdated={onSettingsUpdated} onDirtyChange={setRuntimeDirty} />
    </Tabs.Panel>
  </Tabs>;
}

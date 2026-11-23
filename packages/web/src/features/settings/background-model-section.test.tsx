import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackgroundModelSection } from "./background-model-section";
import { toProviderModelItem, type ProviderModelGroup } from "./settings-helpers";

const groups: ProviderModelGroup[] = [
  {
    providerId: "api-deepseek",
    label: "DeepSeek",
    models: [
      toProviderModelItem({ id: "deepseek-chat", name: "DeepSeek Chat", reasoning: false }),
      toProviderModelItem({ id: "deepseek-reasoner", name: "DeepSeek Reasoner", reasoning: true }),
    ],
  },
];

describe("BackgroundModelSection", () => {
  it("renders concise single-row auto mode with help popover trigger and no model combobox", () => {
    const html = renderToStaticMarkup(
      <BackgroundModelSection
        groups={groups}
        connected
        modelRevision={1}
        providersSignature="api-deepseek:1:api_key:2"
        initialView={{
          backgroundModel: { mode: "auto", running: true, revision: 1 },
          localHost: true,
        }}
      />,
    );
    expect(html).toContain("后台处理模型");
    expect(html).toContain('aria-label="后台处理模型说明"');
    expect(html).toContain("跟随默认模型");
    expect(html).not.toContain('data-slot="combo-box"');
    expect(html).not.toContain("思考强度");
  });

  it("renders provider + model combobox (without thinking effort) for kulo-provider and surfaces unavailable fallback warnings", () => {
    const okHtml = renderToStaticMarkup(
      <BackgroundModelSection
        groups={groups}
        connected
        modelRevision={2}
        providersSignature="api-deepseek:1:api_key:2"
        initialView={{
          backgroundModel: {
            mode: "kulo-provider",
            providerId: "api-deepseek",
            modelId: "deepseek-chat",
            running: true,
            revision: 2,
          },
          localHost: true,
        }}
      />,
    );
    expect(okHtml).toContain("DeepSeek");
    expect(okHtml).toContain('data-slot="combo-box"');
    expect(okHtml).not.toContain("思考强度");

    const staleHtml = renderToStaticMarkup(
      <BackgroundModelSection
        groups={groups}
        connected
        modelRevision={3}
        providersSignature="api-deepseek:1:api_key:2"
        initialView={{
          backgroundModel: {
            mode: "kulo-provider",
            providerId: "api-removed",
            modelId: "old-mini",
            running: false,
            error: "已选后台模型不可用，当前临时回退至默认模型",
            revision: 3,
          },
          localHost: true,
        }}
      />,
    );
    expect(staleHtml).toContain("api-removed（不可用）");
    expect(staleHtml).toContain("old-mini（未添加）");
    expect(staleHtml).toContain("已选后台模型不可用，当前临时回退至默认模型");
    expect(staleHtml).toContain("切回默认");
  });

  it("renders local/host managed runtime states, restart action when stopped, and clickable cancel during deploy", () => {
    const runningLocalHtml = renderToStaticMarkup(
      <BackgroundModelSection
        groups={groups}
        connected
        modelRevision={4}
        providersSignature="api-deepseek:1:api_key:2"
        initialView={{
          backgroundModel: {
            mode: "local-managed",
            engine: "omlx",
            modelId: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
            running: true,
            revision: 4,
          },
          localHost: true,
        }}
      />,
    );
    expect(runningLocalHtml).toContain("本机托管（oMLX）");
    expect(runningLocalHtml).toContain("mlx-community/Qwen3-4B-Instruct-2507-4bit");
    expect(runningLocalHtml).toContain("运行中");
    expect(runningLocalHtml).toContain("切回默认");
    expect(runningLocalHtml).not.toContain("重新启动");

    const remoteStoppedHtml = renderToStaticMarkup(
      <BackgroundModelSection
        groups={groups}
        connected
        modelRevision={5}
        providersSignature="api-deepseek:1:api_key:2"
        initialView={{
          backgroundModel: {
            mode: "local-managed",
            engine: "ollama",
            modelId: "qwen3:4b",
            running: false,
            error: "ollama 进程已退出",
            revision: 5,
          },
          localHost: false,
        }}
      />,
    );
    expect(remoteStoppedHtml).toContain("主机托管（Ollama）");
    expect(remoteStoppedHtml).toContain("未运行");
    expect(remoteStoppedHtml).toContain("重新启动");
    expect(remoteStoppedHtml).toContain("ollama 进程已退出");

    const deployingHtml = renderToStaticMarkup(
      <BackgroundModelSection
        groups={groups}
        connected
        modelRevision={6}
        providersSignature="api-deepseek:1:api_key:2"
        initialView={{
          backgroundModel: {
            mode: "auto",
            engine: "omlx",
            modelId: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
            running: false,
            job: {
              id: "amb-1",
              operation: "deploy",
              status: "running",
              progress: "正在拉起 omlx 并加载 mlx-community/Qwen3-4B-Instruct-2507-4bit…",
              updatedAt: Date.now(),
            },
            revision: 6,
          },
          localHost: true,
        }}
      />,
    );
    expect(deployingHtml).toContain("正在拉起 omlx");
    expect(deployingHtml).toContain("取消并切回默认");
    const cancelBtn = deployingHtml.match(/<button\b[^>]*>取消并切回默认<\/button>/)?.[0] ?? "";
    expect(cancelBtn).not.toContain("disabled");
  });
});

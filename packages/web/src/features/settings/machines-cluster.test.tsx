import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClusterStatusBanner } from "../cluster/cluster-status-banner";
import type { ClusterFailoverController } from "../cluster/use-cluster-failover";

function baseController(overrides: Partial<ClusterFailoverController> = {}): ClusterFailoverController {
  return {
    status: null,
    busy: false,
    hasFailoverOffer: false,
    hasFailbackOffer: false,
    hasConflictNotice: false,
    hasBanner: false,
    confirm: null,
    confirmError: null,
    requestPromote: () => {},
    requestHandover: () => {},
    executeConfirm: async () => {},
    cancelConfirm: () => {},
    dismissFailback: () => {},
    dismissConflictNotice: async () => {},
    refresh: async () => {},
    ...overrides,
  };
}

describe("ClusterStatusBanner", () => {
  it("renders nothing when cluster is healthy", () => {
    const html = renderToStaticMarkup(<ClusterStatusBanner controller={baseController()} />);
    expect(html).toBe("");
  });

  it("renders restrained offline failover warning banner with explicit confirmation button", () => {
    const html = renderToStaticMarkup(
      <ClusterStatusBanner
        controller={baseController({
          hasFailoverOffer: true,
          hasBanner: true,
          status: {
            enabled: true,
            hubId: "hub-1",
            nodeId: "node-b",
            role: "standby",
            epoch: 1,
            primaryNodeId: "node-a",
            preferredPrimaryNodeId: "node-a",
            primaryOnline: false,
            primaryName: "Mac mini",
            failoverOffer: {
              offlinePrimaryNodeId: "node-a",
              offlinePrimaryName: "Mac mini",
              offlineSince: Date.now() - 20_000,
              candidates: [
                {
                  nodeId: "node-b",
                  name: "MacBook Pro",
                  urls: ["http://192.168.1.20:7788"],
                  reachable: true,
                  isSelf: true,
                  canPromote: true,
                },
              ],
            },
          },
        })}
      />,
    );
    expect(html).toContain("Mac mini");
    expect(html).toContain("切至备用主机");
    // No technical jargon in user-facing UI
    expect(html).not.toMatch(/epoch|WAL|X25519|generation/i);
  });

  it("renders dismissible failback banner when preferred primary recovers and catches up", () => {
    const html = renderToStaticMarkup(
      <ClusterStatusBanner
        controller={baseController({
          hasFailbackOffer: true,
          hasBanner: true,
          status: {
            enabled: true,
            hubId: "hub-1",
            nodeId: "node-b",
            role: "primary",
            epoch: 2,
            primaryNodeId: "node-b",
            preferredPrimaryNodeId: "node-a",
            primaryOnline: true,
            primaryName: "MacBook Pro",
            failbackOffer: {
              preferredPrimaryNodeId: "node-a",
              preferredPrimaryName: "Mac mini",
              syncedAt: Date.now(),
              ready: true,
            },
          },
        })}
      />,
    );
    expect(html).toContain("Mac mini");
    expect(html).toContain("切回主机");
    expect(html).toContain("暂不");
  });
});

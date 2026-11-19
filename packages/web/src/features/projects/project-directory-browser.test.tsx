import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectDirectoryListing } from "@kulo/protocol";
import { ProjectDirectoryBrowser } from "./create-project-dialog";

const listing: ProjectDirectoryListing = {
  deviceId: "remote", path: "/projects", parentPath: "/",
  entries: [
    { name: ".git", path: "/projects/.git" },
    { name: "Kulo", path: "/projects/Kulo" },
    { name: ".Trash", path: "/projects/.Trash" },
    { name: "release.v2", path: "/projects/release.v2" },
  ],
};

describe("project directory browsing", () => {
  it("hides dot directories from local or remote listings while preserving visible folders", () => {
    const html = renderToStaticMarkup(<ProjectDirectoryBrowser listing={listing} browsing={false} creating={false} onBrowse={() => {}} />);
    expect(html).not.toContain(".git");
    expect(html).not.toContain(".Trash");
    expect(html).toContain('aria-label="Kulo"');
    expect(html).toContain('aria-label="release.v2"');
    expect(html).toContain('aria-label="上一级目录"');
  });

  it("shows an empty state when only hidden directories exist", () => {
    const html = renderToStaticMarkup(<ProjectDirectoryBrowser listing={{ ...listing, entries: listing.entries.filter((entry) => entry.name.startsWith(".")) }}
      browsing={false} creating={false} onBrowse={() => {}} />);
    expect(html).toContain("没有可见子目录");
    expect(html).not.toContain(".git");
    expect(html).not.toContain(".Trash");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IdentityRead } from "@kulo/protocol";
import { createIdentitySaveReview, ReviewDiffView } from "./identity-document-editor";

describe("identity document review", () => {
  it("shows the active factory preset as deletions on the first identity agreement save", () => {
    const preset: IdentityRead = {
      file: "identity-agreement.md",
      content: "# 身份约定\nKulo 出厂身份与准则\n",
      exists: false,
      configured: true,
      version: { directoryRevision: 1, sha256: null },
      lastBackup: null,
    };
    const review = createIdentitySaveReview(preset, "# 身份约定\n自定义身份\n");
    const before = renderToStaticMarkup(<ReviewDiffView value={review.before} other={review.after} />);
    expect(before).toContain("<del>Kulo 出厂身份与准则");
    expect(review.expected).toEqual(preset.version);
  });

  it("treats an uninitialized relationship file as empty before its first save", () => {
    const uninitialized: IdentityRead = {
      file: "relationship.md",
      content: "# Working Relationship\n模板说明\n",
      exists: false,
      configured: true,
      version: { directoryRevision: 1, sha256: null },
      lastBackup: null,
    };
    expect(createIdentitySaveReview(uninitialized, "偏好直接回答").before).toBe("");
    expect(createIdentitySaveReview({ ...uninitialized, exists: true }, "偏好直接回答").before).toBe(uninitialized.content);
  });
});

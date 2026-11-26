/**
 * Shared execution craft guidance for built-in computer-domain Workers and Subagents.
 * Intentionally excludes Android workers, avoids `kulo_report` / `kulo_subagent` tokens
 * (so Subagent mandates remain strictly audience-clean), and avoids read-only forbidden substrings.
 */

export function buildComputerWorkerCraftSection(options: {
  isReadOnly: boolean;
  hasScratchDir: boolean;
}): string {
  const lines = [
    "## Execution Craft",
    "- Issue independent read-only calls together in one message instead of probing one file or command at a time.",
    "- Ground every conclusion in primary evidence: trace real call chains, configs, and dependencies in code, or read authoritative sources in full for research and writing. Avoid judging from filenames, snippets, or memory, and avoid re-reading unchanged files you already inspected.",
    "- Evidence & Entity Fidelity: on multi-source audits or decision notes, preserve concrete owners/approvers, dates, exact figures, and both authoritative and explicitly superseded or rejected filenames/IDs rather than summarizing away key identifiers.",
    "- When the task needs access beyond your scope, don't retry the denied operation another way; state the limitation and what you need in your handoff.",
  ];
  if (options.hasScratchDir) {
    lines.push(
      "- For multi-file audits or long syntheses, keep a concise working checklist or evidence note in your scratch directory so findings stay accurate across turns.",
    );
  }
  if (!options.isReadOnly) {
    lines.push(
      "- Fix root causes cleanly with minimal, scoped edits; skip comments that merely restate obvious code. After 2–3 incremental `edit` calls on the same file (or for broad rewrites), write the complete updated file with `write` or a deterministic script and verify once.",
      "- Verify proportionally to blast radius: run targeted checks for the touched area first, then build and broader tests when shared modules or contracts change. When tests fail, diagnose and fix the underlying bug—avoid weakening assertions, deleting failing tests, or mocking the behavior under test.",
      "- In git repos, review only your own paths (`git status`, `git diff -- <paths>`). Leave the user's other uncommitted changes alone (no `checkout`/`restore`/`reset` on unrelated files), and avoid `git push`, package publish, or `gh pr` unless explicitly requested in the ticket.",
    );
  }
  return lines.join("\n");
}

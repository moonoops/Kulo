type PdfPageScroll = Pick<HTMLElement, "scrollTop" | "scrollLeft" | "closest">;

/** Page navigation starts at the new page's beginning; zoom and container changes keep the current reading position. */
export function resetPdfPageScroll(page: PdfPageScroll | null, previousPage: number, nextPage: number): void {
  if (!page || previousPage === nextPage) return;
  page.scrollTop = 0;
  page.scrollLeft = 0;
  const preview = page.closest<HTMLElement>(".moco-artifact-live-preview");
  if (preview) { preview.scrollTop = 0; preview.scrollLeft = 0; }
}

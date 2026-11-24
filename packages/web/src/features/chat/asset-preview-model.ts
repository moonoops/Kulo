export interface PreviewSize { width: number; height: number }
export interface PreviewPan { x: number; y: number }

export const PREVIEW_PADDING = 24;
export const MAX_PREVIEW_SCALE = 8;

export function fitPreviewScale(image: PreviewSize, viewport: PreviewSize): number {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(1, Math.max(1, viewport.width - PREVIEW_PADDING * 2) / image.width,
    Math.max(1, viewport.height - PREVIEW_PADDING * 2) / image.height);
}

export function constrainPreviewScale(scale: number, fitScale: number): number {
  return Math.min(MAX_PREVIEW_SCALE, Math.max(Math.min(fitScale, 0.1), scale));
}

export function previewPanLimits(image: PreviewSize, viewport: PreviewSize, scale: number): PreviewPan {
  return {
    x: Math.max(0, (image.width * scale - Math.max(1, viewport.width - PREVIEW_PADDING * 2)) / 2),
    y: Math.max(0, (image.height * scale - Math.max(1, viewport.height - PREVIEW_PADDING * 2)) / 2),
  };
}

export function constrainPreviewPan(pan: PreviewPan, image: PreviewSize, viewport: PreviewSize, scale: number): PreviewPan {
  const limits = previewPanLimits(image, viewport, scale);
  return {
    x: limits.x > 0 ? Math.max(-limits.x, Math.min(limits.x, pan.x)) : 0,
    y: limits.y > 0 ? Math.max(-limits.y, Math.min(limits.y, pan.y)) : 0,
  };
}

export interface AssetImageLoadState {
  forSrc: string | undefined;
  useOriginal: boolean;
  failed: boolean;
  attempt: number;
}

export function initialAssetImageLoadState(src: string | undefined): AssetImageLoadState {
  return { forSrc: src, useOriginal: false, failed: false, attempt: 0 };
}

export function normalizeAssetImageLoadState(
  state: AssetImageLoadState,
  src: string | undefined,
): AssetImageLoadState {
  return state.forSrc === src ? state : initialAssetImageLoadState(src);
}

export function resolveAssetImageDisplaySrc(
  src: string | undefined,
  thumbSrc: string | undefined,
  state: AssetImageLoadState,
): string | undefined {
  if (!src) return undefined;
  const effective = normalizeAssetImageLoadState(state, src);
  return effective.useOriginal ? src : (thumbSrc ?? src);
}

export function transitionAssetImageError(
  state: AssetImageLoadState,
  src: string | undefined,
  thumbSrc: string | undefined,
): { next: AssetImageLoadState; fellBackToOriginal: boolean } {
  const effective = normalizeAssetImageLoadState(state, src);
  const hasThumbFallback = Boolean(src && thumbSrc && thumbSrc !== src);
  if (!effective.useOriginal && hasThumbFallback) {
    return {
      next: { forSrc: src, useOriginal: true, failed: false, attempt: effective.attempt },
      fellBackToOriginal: true,
    };
  }
  return {
    next: { forSrc: src, useOriginal: effective.useOriginal, failed: true, attempt: effective.attempt },
    fellBackToOriginal: false,
  };
}

export function transitionAssetImageRetry(
  state: AssetImageLoadState,
  src: string | undefined,
): AssetImageLoadState {
  const effective = normalizeAssetImageLoadState(state, src);
  return { forSrc: src, useOriginal: false, failed: false, attempt: effective.attempt + 1 };
}

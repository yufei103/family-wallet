const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const JPEG_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const QUALITIES = Object.freeze([0.82, 0.72, 0.62, 0.52, 0.42]);
const COVER_OUTPUT = Object.freeze({ width: 400, height: 500 });

export const MEDIA_LIMITS = Object.freeze({
  cover: Object.freeze({ maxDataUrlLength: 80_000, maxLongEdge: 512, label: '封面图片' }),
  receipt: Object.freeze({ maxDataUrlLength: 180_000, maxLongEdge: 1280, label: '凭证图片' })
});

export const COVER_RENDER_MODES = Object.freeze({ FULL:'full', CROP:'crop' });

function mediaLimit(kind) {
  const limit = MEDIA_LIMITS[kind];
  if (!limit) throw new Error('媒体类型无效，仅支持 cover 或 receipt');
  return limit;
}

function decodeBase64(payload) {
  try {
    return atob(payload);
  } catch {
    throw new Error('JPEG Data URL 格式无效');
  }
}

function inspectJpegDataUrl(value) {
  if (typeof value !== 'string' || !value.startsWith(JPEG_PREFIX)) {
    throw new Error('JPEG Data URL 格式无效');
  }
  const payload = value.slice(JPEG_PREFIX.length);
  if (!payload || payload.length % 4 !== 0 || !JPEG_BASE64.test(payload)) {
    throw new Error('JPEG Data URL 格式无效');
  }

  const bytes = decodeBase64(payload);
  if (
    bytes.length < 5
    || bytes.charCodeAt(0) !== 0xff
    || bytes.charCodeAt(1) !== 0xd8
    || bytes.charCodeAt(2) !== 0xff
    || bytes.charCodeAt(bytes.length - 2) !== 0xff
    || bytes.charCodeAt(bytes.length - 1) !== 0xd9
  ) {
    throw new Error('JPEG 内容无效');
  }

  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return {
    dataUrlLength: value.length,
    estimatedBytes: ((payload.length / 4) * 3) - padding
  };
}

/**
 * Validate a persisted optional media value. Only a real JPEG Data URL within
 * the per-kind string cap is accepted; remote URLs and other image MIME types
 * are intentionally rejected.
 */
export function normaliseMediaDataUrl(value, kind) {
  const limit = mediaLimit(kind);
  if (value === null || value === undefined) return null;

  const metadata = inspectJpegDataUrl(value);
  if (metadata.dataUrlLength > limit.maxDataUrlLength) {
    throw new Error(`${limit.label}过大（最多 ${limit.maxDataUrlLength} 个字符）`);
  }
  return { kind, dataUrl: value, ...metadata };
}

function positiveDimension(value) {
  return Number.isFinite(value) && value > 0;
}

/** Return the initial source crop and output size before fallback reductions. */
export function planMediaDimensions(sourceWidth, sourceHeight, kind) {
  const limit = mediaLimit(kind);
  if (!positiveDimension(sourceWidth) || !positiveDimension(sourceHeight)) {
    throw new Error('图片尺寸无效');
  }

  if (kind === 'cover') {
    const cropSize = Math.min(sourceWidth, sourceHeight);
    const outputSize = Math.max(1, Math.round(Math.min(cropSize, limit.maxLongEdge)));
    return {
      sourceX: (sourceWidth - cropSize) / 2,
      sourceY: (sourceHeight - cropSize) / 2,
      sourceWidth: cropSize,
      sourceHeight: cropSize,
      width: outputSize,
      height: outputSize
    };
  }

  const scale = Math.min(1, limit.maxLongEdge / Math.max(sourceWidth, sourceHeight));
  return {
    sourceX: 0,
    sourceY: 0,
    sourceWidth,
    sourceHeight,
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Normalise interactive 4:5 crop state in output-canvas coordinates.
 * Clamping guarantees every edge of the crop frame remains covered.
 */
export function normaliseCoverEditState(sourceWidth, sourceHeight, state = {}) {
  if (!positiveDimension(sourceWidth) || !positiveDimension(sourceHeight)) throw new Error('图片尺寸无效');
  const mode = state.mode === COVER_RENDER_MODES.CROP ? COVER_RENDER_MODES.CROP : COVER_RENDER_MODES.FULL;
  const zoom = mode === COVER_RENDER_MODES.CROP ? clamp(Number(state.zoom) || 1, 1, 3) : 1;
  if (mode === COVER_RENDER_MODES.FULL) return { mode, zoom, offsetX:0, offsetY:0, maxOffsetX:0, maxOffsetY:0 };

  const baseScale = Math.max(COVER_OUTPUT.width / sourceWidth, COVER_OUTPUT.height / sourceHeight);
  const renderedWidth = sourceWidth * baseScale * zoom;
  const renderedHeight = sourceHeight * baseScale * zoom;
  const maxOffsetX = Math.max(0, (renderedWidth - COVER_OUTPUT.width) / 2);
  const maxOffsetY = Math.max(0, (renderedHeight - COVER_OUTPUT.height) / 2);
  return {
    mode,
    zoom,
    offsetX:clamp(Number(state.offsetX) || 0, -maxOffsetX, maxOffsetX),
    offsetY:clamp(Number(state.offsetY) || 0, -maxOffsetY, maxOffsetY),
    maxOffsetX,
    maxOffsetY
  };
}

/** Return a testable Canvas draw plan for a final 4:5 cover. */
export function planCoverRender(sourceWidth, sourceHeight, state = {}) {
  const edit = normaliseCoverEditState(sourceWidth, sourceHeight, state);
  if (edit.mode === COVER_RENDER_MODES.FULL) {
    const scale = Math.min(COVER_OUTPUT.width / sourceWidth, COVER_OUTPUT.height / sourceHeight);
    const destinationWidth = sourceWidth * scale;
    const destinationHeight = sourceHeight * scale;
    return {
      mode:edit.mode,
      sourceX:0,
      sourceY:0,
      sourceWidth,
      sourceHeight,
      destinationX:(COVER_OUTPUT.width - destinationWidth) / 2,
      destinationY:(COVER_OUTPUT.height - destinationHeight) / 2,
      destinationWidth,
      destinationHeight,
      width:COVER_OUTPUT.width,
      height:COVER_OUTPUT.height,
      background:'#f3f7f6'
    };
  }

  const scale = Math.max(COVER_OUTPUT.width / sourceWidth, COVER_OUTPUT.height / sourceHeight) * edit.zoom;
  const cropWidth = COVER_OUTPUT.width / scale;
  const cropHeight = COVER_OUTPUT.height / scale;
  return {
    mode:edit.mode,
    sourceX:clamp(((sourceWidth - cropWidth) / 2) - (edit.offsetX / scale), 0, sourceWidth - cropWidth),
    sourceY:clamp(((sourceHeight - cropHeight) / 2) - (edit.offsetY / scale), 0, sourceHeight - cropHeight),
    sourceWidth:cropWidth,
    sourceHeight:cropHeight,
    destinationX:0,
    destinationY:0,
    destinationWidth:COVER_OUTPUT.width,
    destinationHeight:COVER_OUTPUT.height,
    width:COVER_OUTPUT.width,
    height:COVER_OUTPUT.height
  };
}

function scaledCoverPlan(initial, width, height) {
  const scaleX = width / initial.width;
  const scaleY = height / initial.height;
  return {
    ...initial,
    width,
    height,
    destinationX:(initial.destinationX ?? 0) * scaleX,
    destinationY:(initial.destinationY ?? 0) * scaleY,
    destinationWidth:(initial.destinationWidth ?? initial.width) * scaleX,
    destinationHeight:(initial.destinationHeight ?? initial.height) * scaleY
  };
}

function candidatePlans(initial, kind) {
  if (kind === 'cover') {
    const square = initial.width === initial.height;
    const longEdge = Math.max(initial.width, initial.height);
    const sizes = (square ? [512, 448, 384, 320, 256, 192] : [500, 450, 400, 350, 300, 250])
      .map(size => Math.min(longEdge, size))
      .filter((size, index, values) => index === 0 || size !== values[index - 1]);
    return sizes.map(size => {
      const scale = size / longEdge;
      return scaledCoverPlan(initial, Math.max(1, Math.round(initial.width * scale)), Math.max(1, Math.round(initial.height * scale)));
    });
  }

  const seen = new Set();
  return [1, 0.85, 0.7, 0.55, 0.42, 0.32].map(scale => {
    const width = Math.max(1, Math.round(initial.width * scale));
    const height = Math.max(1, Math.round(initial.height * scale));
    return { ...initial, width, height };
  }).filter(plan => {
    const key = `${plan.width}x${plan.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function defaultDecodeImage(file) {
  let bitmapError;
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => {
          if (typeof bitmap.close === 'function') bitmap.close();
        }
      };
    } catch (error) {
      bitmapError = error;
    }
  }

  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    if (bitmapError) throw bitmapError;
    throw new Error('当前环境不支持浏览器图片解码');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    if (typeof image.decode === 'function') await image.decode();
    else await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('图片解码失败'));
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(objectUrl)
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function defaultCreateCanvas(width, height) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('当前环境不支持 Canvas 图片压缩');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Decode and compress a browser File entirely in memory. Dependencies are
 * injectable so dimension/fallback behavior can be verified without DOM APIs.
 */
export async function compressItemMedia(file, kind, dependencies = {}) {
  const limit = mediaLimit(kind);
  if (file === null || file === undefined) return null;
  if (!Number.isFinite(file.size) || file.size < 0) throw new Error('来源图片无效');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('来源图片不可超过 8 MiB');
  const sourceType = String(file.type ?? '').toLowerCase();
  if (!INPUT_TYPES.has(sourceType)) {
    throw new Error('仅支持 JPG、PNG 或 WebP 来源图片');
  }

  const decodeImage = dependencies.decodeImage ?? defaultDecodeImage;
  const createCanvas = dependencies.createCanvas ?? defaultCreateCanvas;
  const decoded = await decodeImage(file);
  try {
    const sourceWidth = decoded?.width ?? decoded?.naturalWidth;
    const sourceHeight = decoded?.height ?? decoded?.naturalHeight;
    const source = decoded?.source ?? decoded;
    const initial = kind === 'cover' && dependencies.renderPlan
      ? planCoverRender(sourceWidth, sourceHeight, dependencies.renderPlan)
      : planMediaDimensions(sourceWidth, sourceHeight, kind);

    for (const plan of candidatePlans(initial, kind)) {
      for (const quality of QUALITIES) {
        const canvas = createCanvas(plan.width, plan.height);
        if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.toDataURL !== 'function') {
          throw new Error('Canvas 压缩器无效');
        }
        const context = canvas.getContext('2d');
        if (!context || typeof context.drawImage !== 'function') throw new Error('Canvas 2D 不可用');
        if ((plan.background || sourceType === 'image/png' || sourceType === 'image/webp') && typeof context.fillRect === 'function') {
          context.fillStyle = plan.background || '#ffffff';
          context.fillRect(0, 0, plan.width, plan.height);
        }
        context.drawImage(
          source,
          plan.sourceX,
          plan.sourceY,
          plan.sourceWidth,
          plan.sourceHeight,
          plan.destinationX ?? 0,
          plan.destinationY ?? 0,
          plan.destinationWidth ?? plan.width,
          plan.destinationHeight ?? plan.height
        );
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const metadata = inspectJpegDataUrl(dataUrl);
        if (metadata.dataUrlLength <= limit.maxDataUrlLength) {
          return {
            kind,
            dataUrl,
            ...metadata,
            width: plan.width,
            height: plan.height,
            quality
          };
        }
      }
    }

    throw new Error(`无法压缩到${limit.label}安全上限`);
  } finally {
    if (typeof decoded?.close === 'function') decoded.close();
  }
}

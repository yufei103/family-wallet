const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const JPEG_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const QUALITIES = Object.freeze([0.82, 0.72, 0.62, 0.52, 0.42]);

export const MEDIA_LIMITS = Object.freeze({
  cover: Object.freeze({ maxDataUrlLength: 80_000, maxLongEdge: 512, label: '封面图片' }),
  receipt: Object.freeze({ maxDataUrlLength: 180_000, maxLongEdge: 1280, label: '凭证图片' })
});

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

function candidatePlans(initial, kind) {
  if (kind === 'cover') {
    const sizes = [512, 448, 384, 320, 256, 192]
      .map(size => Math.min(initial.width, size))
      .filter((size, index, values) => index === 0 || size !== values[index - 1]);
    return sizes.map(size => ({ ...initial, width: size, height: size }));
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
    const initial = planMediaDimensions(sourceWidth, sourceHeight, kind);

    for (const plan of candidatePlans(initial, kind)) {
      for (const quality of QUALITIES) {
        const canvas = createCanvas(plan.width, plan.height);
        if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.toDataURL !== 'function') {
          throw new Error('Canvas 压缩器无效');
        }
        const context = canvas.getContext('2d');
        if (!context || typeof context.drawImage !== 'function') throw new Error('Canvas 2D 不可用');
        if ((sourceType === 'image/png' || sourceType === 'image/webp') && typeof context.fillRect === 'function') {
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, plan.width, plan.height);
        }
        context.drawImage(
          source,
          plan.sourceX,
          plan.sourceY,
          plan.sourceWidth,
          plan.sourceHeight,
          0,
          0,
          plan.width,
          plan.height
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

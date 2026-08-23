import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_LIMITS,
  compressItemMedia,
  normaliseMediaDataUrl,
  planMediaDimensions
} from './item-media.js';

const JPEG_PREFIX = 'data:image/jpeg;base64,';

function jpegDataUrl(byteLength = 6) {
  if (byteLength < 5) throw new Error('JPEG fixture 至少需要 5 bytes');
  const bytes = Buffer.alloc(byteLength, 0x41);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[byteLength - 2] = 0xff;
  bytes[byteLength - 1] = 0xd9;
  return `${JPEG_PREFIX}${bytes.toString('base64')}`;
}

test('cover 与 receipt 使用独立 Data URL 长度上限并返回大小元数据', () => {
  assert.equal(MEDIA_LIMITS.cover.maxDataUrlLength, 80_000);
  assert.equal(MEDIA_LIMITS.receipt.maxDataUrlLength, 180_000);

  const tiny = jpegDataUrl();
  assert.deepEqual(normaliseMediaDataUrl(tiny, 'cover'), {
    kind: 'cover',
    dataUrl: tiny,
    dataUrlLength: tiny.length,
    estimatedBytes: 6
  });

  const betweenCaps = jpegDataUrl(60_000);
  assert.throws(() => normaliseMediaDataUrl(betweenCaps, 'cover'), /封面图片过大/);
  assert.equal(normaliseMediaDataUrl(betweenCaps, 'receipt').dataUrl, betweenCaps);
});

test('严格拒绝格式错误、非 JPEG、伪造 JPEG 内容与超限 Data URL', () => {
  assert.throws(() => normaliseMediaDataUrl('not-a-data-url', 'cover'), /JPEG Data URL 格式无效/);
  assert.throws(() => normaliseMediaDataUrl('data:image/png;base64,iVBORw0KGgo=', 'cover'), /JPEG Data URL 格式无效/);
  assert.throws(() => normaliseMediaDataUrl('data:image/jpeg;base64,%%%%', 'cover'), /JPEG Data URL 格式无效/);
  assert.throws(() => normaliseMediaDataUrl('data:image/jpeg;base64,QUJDRA==', 'cover'), /JPEG 内容无效/);
  assert.throws(() => normaliseMediaDataUrl(jpegDataUrl(140_000), 'receipt'), /凭证图片过大/);
});

test('媒体为空时保留为 null，未知 kind 始终拒绝', () => {
  assert.equal(normaliseMediaDataUrl(null, 'cover'), null);
  assert.equal(normaliseMediaDataUrl(undefined, 'receipt'), null);
  assert.throws(() => normaliseMediaDataUrl('', 'cover'), /JPEG Data URL 格式无效/);
  assert.throws(() => normaliseMediaDataUrl(null, 'avatar'), /媒体类型无效/);
});

test('cover 对横图和竖图做居中正方形裁切并限制约 512px', () => {
  assert.deepEqual(planMediaDimensions(1600, 900, 'cover'), {
    sourceX: 350,
    sourceY: 0,
    sourceWidth: 900,
    sourceHeight: 900,
    width: 512,
    height: 512
  });
  assert.deepEqual(planMediaDimensions(800, 1200, 'cover'), {
    sourceX: 0,
    sourceY: 200,
    sourceWidth: 800,
    sourceHeight: 800,
    width: 512,
    height: 512
  });
});

test('receipt 保持横竖比例且最长边不超过 1280px', () => {
  assert.deepEqual(planMediaDimensions(2000, 1000, 'receipt'), {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: 2000,
    sourceHeight: 1000,
    width: 1280,
    height: 640
  });
  assert.deepEqual(planMediaDimensions(1000, 2000, 'receipt'), {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: 1000,
    sourceHeight: 2000,
    width: 640,
    height: 1280
  });
});

test('压缩拒绝超过 8 MiB 或非 JPG/PNG/WebP 的来源文件', async () => {
  const unused = {
    decodeImage: async () => { throw new Error('不应解码'); },
    createCanvas: () => { throw new Error('不应创建 canvas'); }
  };
  await assert.rejects(
    compressItemMedia({ size: (8 * 1024 * 1024) + 1, type: 'image/jpeg' }, 'cover', unused),
    /来源图片不可超过 8 MiB/
  );
  await assert.rejects(
    compressItemMedia({ size: 12, type: 'image/gif' }, 'receipt', unused),
    /仅支持 JPG、PNG 或 WebP/
  );
});

test('压缩通过可注入解码/canvas 假件逐步降低质量与尺寸直到满足上限', async () => {
  const attempts = [];
  let closed = false;
  const source = { tag: 'decoded-image' };
  const result = await compressItemMedia(
    { size: 1024, type: 'image/png' },
    'cover',
    {
      decodeImage: async () => ({ source, width: 1600, height: 900, close: () => { closed = true; } }),
      createCanvas: (width, height) => ({
        getContext: type => {
          assert.equal(type, '2d');
          return {
            drawImage: (...args) => attempts.push({ width, height, args })
          };
        },
        toDataURL: (type, quality) => {
          assert.equal(type, 'image/jpeg');
          attempts.at(-1).quality = quality;
          return width === 512 ? jpegDataUrl(60_000) : jpegDataUrl(20_000);
        }
      })
    }
  );

  assert.equal(result.kind, 'cover');
  assert.ok(result.dataUrlLength <= MEDIA_LIMITS.cover.maxDataUrlLength);
  assert.equal(result.width, 448);
  assert.equal(result.height, 448);
  assert.equal(result.quality, 0.82);
  assert.equal(closed, true);
  assert.deepEqual(attempts.slice(0, 5).map(attempt => [attempt.width, attempt.height, attempt.quality]), [
    [512, 512, 0.82],
    [512, 512, 0.72],
    [512, 512, 0.62],
    [512, 512, 0.52],
    [512, 512, 0.42]
  ]);
  assert.deepEqual(attempts.at(-1).args.slice(1), [350, 0, 900, 900, 0, 0, 448, 448]);
});

test('createImageBitmap 拒绝时回退到 Image/object URL 解码并在完成后清理', async () => {
  const originalDescriptors = new Map(
    ['createImageBitmap', 'Image', 'URL'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  );
  const file = { size: 1024, type: 'image/png' };
  const calls = [];

  try {
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: async (input, options) => {
        calls.push(['createImageBitmap', input, options]);
        throw new Error('Safari bitmap decode failed');
      }
    });
    Object.defineProperty(globalThis, 'Image', {
      configurable: true,
      writable: true,
      value: class FakeImage {
        naturalWidth = 1200;
        naturalHeight = 600;

        set src(value) {
          calls.push(['src', value]);
        }

        async decode() {
          calls.push(['decode']);
        }
      }
    });
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      writable: true,
      value: {
        createObjectURL(input) {
          calls.push(['createObjectURL', input]);
          return 'blob:item-media-fallback';
        },
        revokeObjectURL(value) {
          calls.push(['revokeObjectURL', value]);
        }
      }
    });

    const result = await compressItemMedia(file, 'receipt', {
      createCanvas: (width, height) => ({
        getContext: () => ({ drawImage: () => calls.push(['drawImage', width, height]) }),
        toDataURL: () => jpegDataUrl()
      })
    });

    assert.equal(result.width, 1200);
    assert.equal(result.height, 600);
    assert.deepEqual(calls[0], ['createImageBitmap', file, { imageOrientation: 'from-image' }]);
    assert.deepEqual(calls.filter(([name]) => name === 'createObjectURL'), [['createObjectURL', file]]);
    assert.deepEqual(calls.filter(([name]) => name === 'src'), [['src', 'blob:item-media-fallback']]);
    assert.equal(calls.filter(([name]) => name === 'decode').length, 1);
    assert.deepEqual(calls.filter(([name]) => name === 'revokeObjectURL'), [
      ['revokeObjectURL', 'blob:item-media-fallback']
    ]);
  } finally {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('PNG/WebP 转 JPEG 时在 drawImage 前铺白底，JPEG 与无 fillRect context 保持兼容', async () => {
  async function paintEvents(type, supportsFillRect = true) {
    const events = [];
    await compressItemMedia(
      { size: 1024, type },
      'receipt',
      {
        decodeImage: async () => ({ source: {}, width: 20, height: 10 }),
        createCanvas: (width, height) => ({
          getContext: () => {
            const context = {
              set fillStyle(value) { events.push(['fillStyle', value]); },
              drawImage: () => events.push(['drawImage'])
            };
            if (supportsFillRect) {
              context.fillRect = (...args) => events.push(['fillRect', ...args]);
            }
            return context;
          },
          toDataURL: () => jpegDataUrl()
        })
      }
    );
    return events;
  }

  for (const type of ['image/png', 'image/webp']) {
    assert.deepEqual(await paintEvents(type), [
      ['fillStyle', '#ffffff'],
      ['fillRect', 0, 0, 20, 10],
      ['drawImage']
    ]);
  }
  assert.deepEqual(await paintEvents('image/jpeg'), [['drawImage']]);
  assert.deepEqual(await paintEvents('image/png', false), [['drawImage']]);
});

test('所有压缩候选仍超限时安全失败并释放解码资源', async () => {
  let closed = false;
  await assert.rejects(
    compressItemMedia(
      { size: 1024, type: 'image/webp' },
      'receipt',
      {
        decodeImage: async () => ({ source: {}, width: 1000, height: 2000, close: () => { closed = true; } }),
        createCanvas: (width, height) => ({
          getContext: () => ({ drawImage: () => {} }),
          toDataURL: () => jpegDataUrl(140_000)
        })
      }
    ),
    /无法压缩到凭证图片安全上限/
  );
  assert.equal(closed, true);
});

// Vanilla adaptation of MZM LoginDotMatrix's travelling-wave equations.
// No React/runtime dependency; the wallet owns colors and auth visibility.
export const MAX_DPR = 1.5;
export const MAX_DOTS = 900;
export const FRAME_INTERVAL = 1000 / 30;
export const PIXEL_BUDGET = 1_400_000;
const TIME_SCALE = 0.00028;

export function matrixGeometry(width, height, deviceDpr = 1) {
  const rawDpr = Math.min(deviceDpr, MAX_DPR);
  const dpr = rawDpr * Math.min(1, Math.sqrt(PIXEL_BUDGET / (width * height * rawDpr * rawDpr)));
  let spacing = Math.max(width < 640 ? 24 : 28, Math.sqrt(width * height / MAX_DOTS));
  // Round-to-grid edges can otherwise exceed MZM's approximate dot budget.
  while (Math.round(width / spacing) * Math.round(height / spacing) > MAX_DOTS) spacing += 0.5;
  return { dpr, spacing, pixelWidth: Math.max(1, Math.floor(width * dpr)), pixelHeight: Math.max(1, Math.floor(height * dpr)) };
}

export function drawMatrix(context, { width, height, spacing, timestamp, reducedMotion, color }) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = color;
  const time = reducedMotion ? 0 : timestamp * TIME_SCALE;
  for (let y = spacing * 0.5; y < height; y += spacing) {
    for (let x = spacing * 0.5; x < width; x += spacing) {
      const field = Math.sin(x * 0.012 + time * 1.7) * Math.cos(y * 0.014 - time)
        + Math.sin((x + y) * 0.007 - time * 1.3) * 0.45;
      const strength = (field + 1.45) / 2.9;
      const travellingWave = (Math.sin(x * 0.018 - y * 0.006 - time * 3.2) + 1) / 2;
      const highlight = travellingWave * travellingWave * travellingWave;
      const driftX = reducedMotion ? 0 : Math.sin(y * 0.011 + time * 1.4) * 3.2;
      const driftY = reducedMotion ? 0 : Math.cos(x * 0.009 - time * 1.1) * 1.8;
      context.beginPath();
      context.arc(x + driftX, y + field * 1.8 + driftY, 0.8 + strength * 1.05 + highlight * 0.7, 0, Math.PI * 2);
      context.globalAlpha = 0.1 + strength * 0.22 + highlight * 0.16;
      context.fill();
    }
  }
  context.globalAlpha = 1;
}

export function mountLoginDotMatrix(canvas, gate) {
  const context = canvas?.getContext('2d');
  if (!context || !gate) return () => {};
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0;
  let lastFrame = 0;
  let geometry;
  let width = 0;
  let height = 0;
  let color;
  let disposed = false;
  let pageHidden = false;
  const visible = () => !disposed && !pageHidden && !document.hidden && !gate.hidden && width && height;
  const stop = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
  const draw = timestamp => {
    if (!visible()) return;
    drawMatrix(context, { width, height, spacing: geometry.spacing, timestamp, reducedMotion: reducedMotion.matches, color });
    canvas.dataset.rendered = 'true';
  };
  const animate = timestamp => {
    if (!visible() || reducedMotion.matches) { stop(); return; }
    if (timestamp - lastFrame >= FRAME_INTERVAL) { draw(timestamp); lastFrame = timestamp; }
    frame = requestAnimationFrame(animate);
  };
  const refresh = () => {
    stop();
    if (disposed || pageHidden || document.hidden || gate.hidden) return;
    const rect = canvas.getBoundingClientRect();
    width = Math.floor(rect.width);
    height = Math.floor(rect.height);
    if (!width || !height) return;
    geometry = matrixGeometry(width, height, devicePixelRatio || 1);
    canvas.width = geometry.pixelWidth;
    canvas.height = geometry.pixelHeight;
    context.setTransform(geometry.dpr, 0, 0, geometry.dpr, 0, 0);
    color = getComputedStyle(canvas).color;
    draw(performance.now());
    if (!reducedMotion.matches) frame = requestAnimationFrame(animate);
  };
  const hide = () => { pageHidden = true; stop(); };
  const show = () => { pageHidden = false; refresh(); };
  const resizeObserver = new ResizeObserver(refresh);
  resizeObserver.observe(canvas);
  const observer = new MutationObserver(refresh);
  observer.observe(gate, { attributes: true, attributeFilter: ['hidden'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  reducedMotion.addEventListener('change', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  refresh();
  return () => {
    disposed = true;
    stop();
    resizeObserver.disconnect();
    observer.disconnect();
    reducedMotion.removeEventListener('change', refresh);
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
  };
}

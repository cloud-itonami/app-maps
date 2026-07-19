import { test } from '@playwright/test';

test('kami debug', async ({ page }) => {
  const logs: string[] = [];
  const errors: string[] = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('/', { waitUntil: 'load', timeout: 20_000 });
  await page.waitForTimeout(6000);

  const debug = await page.evaluate(() => {
    const canvas = document.getElementById('kami-map-canvas') as HTMLCanvasElement | null;
    const mapError = document.querySelector('[data-testid="map-error"]');
    let webgl2Renderer: string | null = null;
    let webgl2Ok = false;
    if (canvas) {
      try {
        const gl = canvas.getContext('webgl2');
        webgl2Ok = !!gl;
        webgl2Renderer = gl ? (gl.getParameter(gl.RENDERER) as string) : 'null context';
      } catch (e: any) { webgl2Renderer = 'error: ' + e.message; }
    }
    return {
      canvasPresent: !!canvas,
      canvasWidth: canvas?.width ?? null,
      canvasHeight: canvas?.height ?? null,
      canvasClientWidth: canvas?.clientWidth ?? null,
      canvasClientHeight: canvas?.clientHeight ?? null,
      mapErrorText: mapError?.textContent?.trim() ?? null,
      webgl2Ok,
      webgl2Renderer,
      webgpuAvailable: 'gpu' in navigator && navigator.gpu !== null,
    };
  });

  // Check kami-map WASM reachable
  const wasmRes = await page.request.get('/kami-map/kami_map.js');
  const tileRes = await page.request.get('https://tiles.openfreemap.org/planet/stable/5/28/12.png');

  console.log('\n=== KAMI state ===\n' + JSON.stringify(debug, null, 2));
  console.log(`\nkami_map.js: HTTP ${wasmRes.status()}`);
  console.log(`tile fetch: HTTP ${tileRes.status()} content-type=${tileRes.headers()['content-type']}`);
  console.log('\n=== Console ===');
  for (const l of logs) console.log(l);
  if (errors.length) { console.log('\n=== Page errors ==='); for (const e of errors) console.log(e); }
});

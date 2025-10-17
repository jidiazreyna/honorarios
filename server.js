// server.js — llena Inicio = fecha de corte, Cierre = fecha de cálculo y Monto = capital + intereses
// en la calculadora P 14290 del BCRA (sin API). Lee "Monto total" y lo devuelve al front.

const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BCRA_URL = 'https://www.bcra.gob.ar/BCRAyVos/calculadora-intereses-tasa-justicia.asp';
const app = express();
app.use(express.json());

// ===== Entorno Playwright/Render =====
// En Render conviene instalar browsers en /opt/render/.cache/ms-playwright durante el build.
// No intentamos instalar en runtime. Si falta Chromium, devolvemos error claro.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  // En Render: usar ruta de cache persistente
  if (process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/render/.cache/ms-playwright';
  } else {
    // Local: dentro de node_modules (0)
    process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  }
}

// ===== Static / index.html =====
const ROOT = __dirname;
app.use(express.static(ROOT));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));

// ---------- utils ----------
function parseARnum(str) {
  return parseFloat(String(str).replace(/\./g, '').replace(',', '.'));
}
const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Forzar value + eventos (sirve para type="date" y máscaras)
async function forceSetValue(page, locator, value) {
  await locator.evaluate((el, val) => {
    el.focus();
    el.value = val;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }, value);
}

// ==== FECHAS ====
// Busca y setea fecha por varias estrategias; which: "inicio" | "cierre"
// Escribe SIEMPRE en ISO YYYY-MM-DD (lo que aceptan los <input type="date">)
async function setFecha(page, which, isoValue) {
  const isInicio = which === 'inicio';

  // 1) Intento por ID/NAME conocidos
  const selKNOWN = isInicio
    ? '#FechaInicio, input[name="FechaInicio" i]'
    : '#FechaCierre, input[name="FechaCierre" i], #FechaFin, input[name="FechaFin" i]';

  const known = page.locator(selKNOWN).first();
  if (await known.count()) {
    await known.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await known.fill(isoValue, { timeout: 2500 });
      const got = await known.inputValue({ timeout: 600 }).catch(() => '');
      if (got === isoValue) return true;
    } catch {}
    await forceSetValue(page, known, isoValue);
    return true;
  }

  // 2) Por <label> “Seleccionar fecha de inicio/cierre”
  const okByLabel = await page.evaluate((args) => {
    const { which, val } = args;
    const normalize = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const labelNeedle = which === 'inicio' ? 'seleccionar fecha de inicio' : 'seleccionar fecha de cierre';
    const labels = Array.from(document.querySelectorAll('label'));
    for (const lb of labels) {
      if (normalize(lb.textContent).includes(labelNeedle)) {
        const forId = lb.getAttribute('for');
        let el = (forId && document.getElementById(forId))
          || lb.parentElement?.querySelector('input')
          || lb.nextElementSibling?.querySelector?.('input')
          || lb.nextElementSibling;
        if (el && el.tagName === 'INPUT') {
          el.focus();
          el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
          return true;
        }
      }
    }
    return false;
  }, { which, val: isoValue });
  if (okByLabel) return true;

  // 3) Último recurso: por índice de input[type=date] (0 = inicio, 1 = cierre)
  const idx = isInicio ? 0 : 1;
  const tryIndex = await page.evaluate((args) => {
    const { i, val } = args;
    const dates = Array.from(document.querySelectorAll('input[type="date"], input[placeholder*="dd/mm" i]'));
    if (dates[i]) {
      const el = dates[i];
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return true;
    }
    return false;
  }, { i: idx, val: isoValue });
  return tryIndex;
}

// ==== MONTO ====
// setea el monto buscando #Monto/name=Monto o por su <label> “Ingresar un monto”
async function setMonto(page, valor) {
  const selMonto = '#Monto, input[name="Monto" i], input[type="text"]:not([placeholder*="dd/mm"])';
  const loc = page.locator(selMonto).first();
  if (await loc.count()) {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await loc.fill(String(valor), { timeout: 2500 });
      const got = await loc.inputValue({ timeout: 600 }).catch(() => '');
      if (got) return true;
    } catch {}
    await forceSetValue(page, loc, String(valor));
    return true;
  }
  // por label
  const ok = await page.evaluate((val) => {
    const normalize = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const labels = Array.from(document.querySelectorAll('label'));
    for (const lb of labels) {
      if (normalize(lb.textContent).includes('ingresar un monto')) {
        const forId = lb.getAttribute('for');
        let el = (forId && document.getElementById(forId))
          || lb.parentElement?.querySelector('input')
          || lb.nextElementSibling?.querySelector?.('input')
          || lb.nextElementSibling;
        if (el && el.tagName === 'INPUT') {
          el.focus();
          el.value = String(val);
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
          return true;
        }
      }
    }
    return false;
  }, String(valor));
  return ok;
}

// Click en “Calcular”
async function clickCalcular(page) {
  try { await page.getByRole('button', { name: /^calcular$/i }).click({ timeout: 5000 }); return; } catch {}
  try { await page.click('text=/^\\s*Calcular\\s*$/i', { timeout: 5000 }); return; } catch {}
  const done = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button,input[type="submit"],a'))
      .find(el => /calcular/i.test(el.textContent || el.value || ''));
    if (btn) { btn.scrollIntoView(); btn.click(); return true; }
    return false;
  });
  if (!done) throw new Error('No encontré el botón "Calcular".');
}

// === Leer resultados: { intereses, total } — preferimos SIEMPRE “Monto total”
async function extraerMontos(page) {
  // espera a que aparezcan las cajas de resultado
  await page.waitForSelector('.alert-success, .alert.alert-success', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const res = await page.evaluate(() => {
    const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const getAmount = (text) => {
      const m = String(text || '').match(/\$\s*([\d\.\,]+)/);
      return m ? m[1] : null;
    };

    const alerts = Array.from(document.querySelectorAll('.alert-success, .alert.alert-success'))
      .map((el, idx) => {
        const text = el.innerText || '';
        return {
          idx,
          text,
          normText: norm(text),
          amountRaw: getAmount(text),
        };
      });

    const totalByText = alerts.find(a => a.normText.includes('monto total'))?.amountRaw || null;
    const interesesByText = alerts.find(a => a.normText.includes('monto de intereses'))?.amountRaw || null;

    return { alerts, totalByText, interesesByText };
  });

  const toNum = (s) => (s == null ? null : parseFloat(String(s).replace(/\./g, '').replace(',', '.')));

  const amounts = (res.alerts || [])
    .map((a) => ({ idx: a.idx, value: toNum(a.amountRaw) }))
    .filter((a) => Number.isFinite(a.value));

  let total = toNum(res.totalByText);
  let intereses = toNum(res.interesesByText);

  // Fallback por posición: en la calculadora del BCRA, la 2ª caja es "Monto total"
  if (total == null) {
    const secondBox = amounts.find((a) => a.idx === 1);
    if (secondBox) total = secondBox.value;
  }
  if (intereses == null) {
    const firstBox = amounts.find((a) => a.idx === 0);
    if (firstBox) intereses = firstBox.value;
  }

  // Último fallback: mayor de todos los importes como total
  if (amounts.length) {
    const sorted = [...amounts].sort((a, b) => b.value - a.value).map((a) => a.value);
    if (total == null) total = sorted[0];
    if (intereses == null && sorted.length > 1) {
      const uniqueSorted = Array.from(new Set(sorted));
      const candidate = uniqueSorted.find((val) => val !== total);
      if (candidate != null) intereses = candidate;
      else if (uniqueSorted.length > 1) intereses = uniqueSorted[1];
    }
  }

  if (total == null) throw new Error('No pude leer el “Monto total” en la página del BCRA.');
  return { intereses: intereses ?? null, total };
}

// ===== Lanzar navegador con flags para Render =====
async function launchBrowser() {
  // (opcional) log para diagnóstico
  try { console.log('Chromium path:', chromium.executablePath?.()); } catch {}
  return await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-zygote',
      '--single-process'
    ]
  });
}

// ---------- endpoint principal ----------
app.post('/api/bcra', async (req, res) => {
  const { capital, intereses, corteISO, calculoISO } = req.body || {};
  if (!(capital >= 0) || !(intereses >= 0) || !corteISO || !calculoISO) {
    return res.status(400).json({ error: 'Parámetros inválidos.' });
  }

  // Mapeo pedido:
  const fechaInicioISO = corteISO;      // inicio = fecha de corte (planilla)
  const fechaCierreISO = calculoISO;    // cierre = fecha de cálculo (hasta)
  const montoTotal     = Number(capital) + Number(intereses); // cap + int

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ locale: 'es-AR' });
    await page.goto(BCRA_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });

    // Cerrar banners (si aparecen)
    try { await page.getByRole('button', { name: /aceptar|entendido|continuar/i }).click({ timeout: 1500 }); } catch {}

    // === Completar fechas ===
    const okInicio = await setFecha(page, 'inicio', fechaInicioISO);
    const okCierre = await setFecha(page, 'cierre', fechaCierreISO);
    if (!okInicio) throw new Error('No pude completar la “fecha de inicio”.');
    if (!okCierre) throw new Error('No pude completar la “fecha de cierre”.');

    // === Completar monto (cap + int) ===
    const okMonto = await setMonto(page, String(montoTotal));
    if (!okMonto) throw new Error('No pude completar el “monto”.');

    // === Calcular ===
    await clickCalcular(page);

    // === Leer resultados (preferimos TOTAL) ===
    const { intereses: mInt, total: mTot } = await extraerMontos(page);
    const elegido = (mTot != null) ? mTot : mInt;

    // Para compatibilidad, el frontend espera "interes"; enviamos el TOTAL.
    res.json({ ok: true, interes: elegido, detalle: { intereses: mInt, total: mTot } });

  } catch (err) {
    console.error('BCRA error:', err);
    res.status(500).json({
      error: String(err && err.message ? err.message : err),
      hint: 'Verificá que en el build se haya ejecutado "npx playwright install chromium" y que PLAYWRIGHT_BROWSERS_PATH esté configurada.'
    });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
});

// ===== Endpoints de salud y diagnóstico =====
app.get('/health', (_req, res) => res.type('text/plain').send('ok'));

app.get('/diag', async (_req, res) => {
  const out = {};
  try {
    out.node = process.version;
    out.env = {
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD,
      NODE_ENV: process.env.NODE_ENV,
      RENDER: !!process.env.RENDER || !!process.env.RENDER_EXTERNAL_URL
    };
    try { out.execPath = chromium.executablePath?.(); } catch {}
    if (out.execPath) out.execExists = fs.existsSync(out.execPath);
    let ok = false;
    try {
      const b = await chromium.launch({
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process']
      });
      await b.close();
      ok = true;
    } catch (e) { out.launchError = String(e); }
    out.canLaunch = ok;
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e), partial: out });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));

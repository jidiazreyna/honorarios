// server.js — llena Inicio = fecha de corte, Cierre = fecha de cálculo y
// Monto = capital + intereses en la calculadora P 14290 del BCRA (sin API).
// Lee "Monto total" y lo devuelve al front. Listo para Render con fallback
// de binario (headless_shell -> chrome).

const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BCRA_URL = 'https://www.bcra.gob.ar/BCRAyVos/calculadora-intereses-tasa-justicia.asp';
const app = express();
app.use(express.json());

// ===== Entorno Playwright/Render =====
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  if (process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/render/.cache/ms-playwright';
  } else {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '0'; // local: dentro de node_modules
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
async function setFecha(page, which, isoValue) {
  const isInicio = which === 'inicio';
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

  if (total == null) {
    const secondBox = amounts.find((a) => a.idx === 1);
    if (secondBox) total = secondBox.value;
  }
  if (intereses == null) {
    const firstBox = amounts.find((a) => a.idx === 0);
    if (firstBox) intereses = firstBox.value;
  }

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

// ===== Resolver binario: headless_shell si existe; si no, chrome =====
function resolveExecutablePath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/render/.cache/ms-playwright';
  // Buscar cualquier revisión (no fijamos 1194 por si cambia)
  const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).map(n => path.join(dir, n)) : []);
  const tryPaths = [];

  // Preferir headless_shell
  list(base).forEach(p => {
    if (p.includes('chromium_headless_shell-')) {
      tryPaths.push(path.join(p, 'chrome-linux', 'headless_shell'));
    }
  });
  // Luego chrome normal
  list(base).forEach(p => {
    if (p.includes('chromium-')) {
      tryPaths.push(path.join(p, 'chrome-linux', 'chrome'));
    }
  });

  for (const p of tryPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ===== Lanzar navegador con fallback de ejecutable =====
async function launchBrowser() {
  const execPath = resolveExecutablePath();
  console.log('Chromium detectado:', execPath || '(ninguno — usaremos el default de Playwright si existe)');

  return await chromium.launch({
    headless: true,
    ...(execPath ? { executablePath: execPath } : {}),
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

  const fechaInicioISO = corteISO;   // inicio = fecha de corte (planilla)
  const fechaCierreISO = calculoISO; // cierre = fecha de cálculo (hasta)
  const montoTotal     = Number(capital) + Number(intereses); // cap + int

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ locale: 'es-AR' });
    await page.goto(BCRA_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });

    try { await page.getByRole('button', { name: /aceptar|entendido|continuar/i }).click({ timeout: 1500 }); } catch {}

    const okInicio = await setFecha(page, 'inicio', fechaInicioISO);
    const okCierre = await setFecha(page, 'cierre', fechaCierreISO);
    if (!okInicio) throw new Error('No pude completar la “fecha de inicio”.');
    if (!okCierre) throw new Error('No pude completar la “fecha de cierre”.');

    const okMonto = await setMonto(page, String(montoTotal));
    if (!okMonto) throw new Error('No pude completar el “monto”.');

    await clickCalcular(page);

    const { intereses: mInt, total: mTot } = await extraerMontos(page);
    const elegido = (mTot != null) ? mTot : mInt;

    // Para compatibilidad con el front: devolvemos en campo "interes" el TOTAL.
    res.json({ ok: true, interes: elegido, detalle: { intereses: mInt, total: mTot } });

  } catch (err) {
    console.error('BCRA error:', err);
    res.status(500).json({
      error: String(err && err.message ? err.message : err),
      hint: 'Si persiste, comprobá que en el build se ejecutó "npx playwright install chromium chromium-headless-shell" y que PLAYWRIGHT_BROWSERS_PATH apunta al cache.'
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
      NODE_ENV: process.env.NODE_ENV,
      RENDER: !!process.env.RENDER || !!process.env.RENDER_EXTERNAL_URL
    };
    out.execResolved = resolveExecutablePath();
    if (out.execResolved) out.execExists = fs.existsSync(out.execResolved);
    let ok = false;
    try {
      const b = await chromium.launch({
        headless: true,
        ...(out.execResolved ? { executablePath: out.execResolved } : {}),
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

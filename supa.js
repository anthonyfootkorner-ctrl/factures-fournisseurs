'use strict';
/* Client Supabase minimal (sans bibliothèque externe) + adaptateur des routes de l'interface vers l'API sécurisée.
   Seule la clé PUBLIQUE est présente ici : toutes les données sont protégées par la connexion et les règles d'accès. */

const SB = (() => {
  const C = window.FACTURES_CONFIG;
  const KEY = 'sf_session';
  let session = null;
  try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  const save = s => { session = s; try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch (e) {} };

  async function authCall(path, body) {
    const r = await fetch(`${C.url}/auth/v1/${path}`, { method: 'POST', headers: { apikey: C.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description === 'Invalid login credentials' || j.msg === 'Invalid login credentials' ? 'Identifiants incorrects' : (j.error_description || j.msg || j.message || 'Connexion impossible'));
    return j;
  }
  function store(j) { save({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600) }); }
  async function login(email, password) { store(await authCall('token?grant_type=password', { email, password })); }
  let refreshing = null;
  async function token() {
    if (!session) return null;
    if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
    if (!refreshing) refreshing = authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token }).then(store).catch(() => save(null)).finally(() => { refreshing = null; });
    await refreshing;
    return session && session.access_token;
  }
  async function logout() {
    const t = await token();
    if (t) await fetch(`${C.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: C.key, Authorization: `Bearer ${t}` } }).catch(() => {});
    save(null);
  }
  async function headers(extra) {
    const t = await token();
    if (!t) { const e = new Error('Authentification requise'); e.status = 401; throw e; }
    return Object.assign({ apikey: C.key, Authorization: `Bearer ${t}` }, extra || {});
  }
  async function rpc(fn, params) {
    const r = await fetch(`${C.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: await headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(params || {}) });
    const txt = await r.text();
    let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
    if (!r.ok) { const e = new Error((j && (j.message || j.error)) || `Erreur ${r.status}`); e.status = r.status === 401 ? 401 : r.status; throw e; }
    return j;
  }
  async function fn(name, body, anonymous) {
    const h = anonymous ? { apikey: C.key, Authorization: `Bearer ${C.key}` } : await headers();
    const r = await fetch(`${C.url}/functions/v1/${name}`, { method: 'POST', headers: Object.assign(h, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
    return j;
  }
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  async function signedUrl(bucket, path, download) {
    const r = await fetch(`${C.url}/storage/v1/object/sign/${bucket}/${enc(path)}`, { method: 'POST', headers: await headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: 3600 }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error || 'Fichier inaccessible');
    return `${C.url}/storage/v1${j.signedURL}` + (download ? `&download=${encodeURIComponent(download === true ? '' : download)}` : '');
  }
  function upload(bucket, path, file, onProgress) {
    return headers({}).then(h => new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open('POST', `${C.url}/storage/v1/object/${bucket}/${enc(path)}`);
      for (const [k, v] of Object.entries(h)) x.setRequestHeader(k, v);
      x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      x.setRequestHeader('x-upsert', 'false');
      if (onProgress) x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
      x.onload = () => x.status < 300 ? res() : rej(new Error('Envoi refusé : ' + ((JSON.parse(x.responseText || '{}').message) || x.status)));
      x.onerror = () => rej(new Error('Échec réseau'));
      x.send(file);
    }));
  }
  async function select(table, params) {
    const r = await fetch(`${C.url}/rest/v1/${table}?${params}`, { headers: await headers() });
    if (!r.ok) { const e = new Error(`Lecture impossible (${r.status})`); e.status = r.status; throw e; }
    return r.json();
  }
  return { login, logout, rpc, fn, select, signedUrl, upload, hasSession: () => !!session, config: C };
})();

// ------------------------------------------------------------------ montants
function parseAmount(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  let s = String(raw).replace(/(eur|usd|gbp|chf|€|\$|£)/gi, '').replace(/[  ' ]/g, '').trim();
  let neg = false;
  if (/^-/.test(s)) { neg = true; s = s.slice(1); }
  if (!/^[\d.,]+$/.test(s)) return NaN;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc >= 0 && ld >= 0) { const dec = lc > ld ? ',' : '.'; s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.'); }
  else if (lc >= 0 || ld >= 0) {
    const sep = lc >= 0 ? ',' : '.'; const parts = s.split(sep);
    if (parts.length > 2) { if (parts.slice(1).every(p => p.length === 3)) s = parts.join(''); else return NaN; }
    else if (parts[1].length === 3) s = parts.join('');
    else if (parts[1].length <= 2) s = parts[0] + '.' + parts[1];
    else return NaN;
  }
  const v = Math.round(parseFloat(s) * 100);
  return isNaN(v) ? NaN : (neg ? -v : v);
}
function amountOrFail(raw, label) {
  const v = parseAmount(raw);
  if (Number.isNaN(v)) throw new Error(`${label || 'Montant'} invalide : ${raw}`);
  return v;
}
async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeKey(name) {
  return (name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120)) || 'fichier';
}
function uuid() { return crypto.randomUUID(); }

// ------------------------------------------------------------------ adaptateur : routes historiques → API Supabase
async function apiRoute(method, url, body) {
  const [path, query] = url.split('?');
  const q = Object.fromEntries(new URLSearchParams(query || ''));
  const demo = q.demo === '1';
  let m;
  const R = (re) => (m = path.match(re));
  if (method === 'GET' && R(/^\/api\/lookups$/)) return SB.rpc('lookups', { p_demo: demo });
  if (method === 'GET' && R(/^\/api\/dashboard$/)) return SB.rpc('dashboard', { p: q });
  if (method === 'GET' && R(/^\/api\/invoices$/)) return SB.rpc('invoices_list', { p: q });
  if (method === 'GET' && R(/^\/api\/invoices\/(\d+)$/)) return SB.rpc('invoice_detail', { p_id: +m[1] });
  if (method === 'PATCH' && R(/^\/api\/invoices\/(\d+)$/)) {
    const ch = {};
    for (const [k, v] of Object.entries(body)) ch[k] = ['amount_ht', 'amount_tva', 'amount_ttc'].includes(k) ? amountOrFail(v) : (v === '' ? null : v);
    for (const k of ['amount_ht', 'amount_tva', 'amount_ttc']) if (ch[k] !== undefined && ch[k] !== null && ch[k] < 0) throw new Error('Les montants sont saisis en positif (le type « avoir » porte le sens)');
    return SB.rpc('invoice_update', { p_id: +m[1], p_changes: ch });
  }
  if (method === 'POST' && R(/^\/api\/invoices\/(\d+)\/(validate|reject|reopen)$/)) return SB.rpc('invoice_set_status', { p_id: +m[1], p_action: m[2], p_reason: (body && body.reason) || null });
  if (method === 'POST' && R(/^\/api\/invoices\/bulk$/)) return SB.rpc('invoices_validate_bulk', { p_ids: body.ids });
  if (method === 'POST' && R(/^\/api\/invoices\/(\d+)\/acknowledge$/)) return SB.rpc('invoice_acknowledge', { p_id: +m[1], p_code: body.code, p_comment: body.comment });
  if (method === 'POST' && R(/^\/api\/invoices\/(\d+)\/duplicate$/)) return SB.rpc('invoice_duplicate', { p_id: +m[1], p_action: body.action });
  if (method === 'POST' && R(/^\/api\/invoices\/(\d+)\/dispute$/)) return SB.rpc('invoice_dispute', { p_id: +m[1], p_dispute: !!body.dispute, p_reason: body.reason || null });
  if (method === 'POST' && R(/^\/api\/invoices\/(\d+)\/supplier$/)) return SB.rpc('invoice_set_supplier', { p_id: +m[1], p_supplier_id: body.supplier_id || null, p_add_alias: !!body.add_alias, p_create: body.create || null });
  if (method === 'POST' && R(/^\/api\/invoices\/(\d+)\/comments$/)) return SB.rpc('invoice_comment', { p_id: +m[1], p_body: body.body });
  if (method === 'POST' && R(/^\/api\/invoices\/(\d+)\/payments$/)) return SB.rpc('payment_add', { p_invoice: +m[1], p_date: body.date, p_amount: amountOrFail(body.amount, 'Montant de paiement'), p_method: body.method || null, p_reference: body.reference || null, p_comment: body.comment || null });
  if (method === 'DELETE' && R(/^\/api\/payments\/(\d+)$/)) return SB.rpc('payment_delete', { p_id: +m[1] });
  if (method === 'POST' && R(/^\/api\/payments\/(\d+)\/proof$/)) {
    const buf = await body.arrayBuffer();
    const p = `${m[1]}/${uuid()}_${safeKey(body.name)}`;
    await SB.upload('justificatifs', p, body);
    return SB.rpc('payment_set_proof', { p_id: +m[1], p_path: p, p_filename: body.name, p_mime: body.type, p_size: body.size, p_sha: await sha256Hex(buf) });
  }
  if (method === 'POST' && R(/^\/api\/invoices\/(\d+)\/allocations$/)) return SB.rpc('allocation_add', { p_credit: +m[1], p_invoice: +body.invoice_id, p_amount: amountOrFail(body.amount) });
  if (method === 'DELETE' && R(/^\/api\/allocations\/(\d+)$/)) return SB.rpc('allocation_delete', { p_id: +m[1] });
  if (method === 'GET' && R(/^\/api\/suppliers$/)) return supplierList(q);
  if (method === 'GET' && R(/^\/api\/suppliers\/(\d+)$/)) return SB.rpc('supplier_detail', { p_id: +m[1] });
  if (method === 'POST' && R(/^\/api\/suppliers$/)) return SB.rpc('supplier_create', { p: body }).then(id => ({ id }));
  if (method === 'PATCH' && R(/^\/api\/suppliers\/(\d+)$/)) return SB.rpc('supplier_update', { p_id: +m[1], p: body });
  if (method === 'POST' && R(/^\/api\/suppliers\/(\d+)\/approve$/)) return SB.rpc('supplier_approve', { p_id: +m[1] });
  if (method === 'POST' && R(/^\/api\/suppliers\/(\d+)\/bank$/)) return SB.rpc('supplier_bank', { p_id: +m[1], p_iban: body.iban, p_bic: body.bic || null, p_comment: body.comment, p_confirm: !!body.confirm });
  if (method === 'POST' && R(/^\/api\/suppliers\/(\d+)\/merge$/)) return SB.rpc('supplier_merge', { p_id: +m[1], p_target: +body.target_id, p_confirm: body.confirm }).then(n => ({ moved: n }));
  if (method === 'POST' && R(/^\/api\/batches$/)) return SB.rpc('batch_create', { p_label: body.label || null }).then(id => ({ id }));
  if (method === 'GET' && R(/^\/api\/batches$/)) return SB.rpc('batches_list', { p_demo: demo });
  if (method === 'GET' && R(/^\/api\/batches\/(\d+)$/)) return SB.rpc('batch_detail', { p_id: +m[1] });
  if (method === 'POST' && R(/^\/api\/import-items\/(\d+)\/retry$/)) return SB.rpc('import_retry', { p_id: +m[1] });
  if (method === 'POST' && R(/^\/api\/import-items\/(\d+)\/mapping$/)) return SB.rpc('import_mapping', { p_id: +m[1], p_mapping: body });
  if (method === 'GET' && R(/^\/api\/settings$/)) return SB.rpc('settings_get');
  if (method === 'PUT' && R(/^\/api\/settings$/)) return SB.rpc('settings_update', { p: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])) });
  if (method === 'POST' && R(/^\/api\/companies$/)) return SB.rpc('company_create', { p: body }).then(id => ({ id }));
  if (method === 'DELETE' && R(/^\/api\/companies\/(\d+)$/)) return SB.rpc('company_delete', { p_id: +m[1] });
  if (method === 'POST' && R(/^\/api\/categories$/)) return SB.rpc('category_create', { p_name: body.name });
  if (method === 'DELETE' && R(/^\/api\/categories\/(\d+)$/)) return SB.rpc('category_delete', { p_id: +m[1] });
  if (method === 'POST' && R(/^\/api\/users$/)) return SB.fn('utilisateurs', { action: 'creer', ...body });
  if (method === 'PATCH' && R(/^\/api\/users\/([0-9a-f-]{36})$/)) {
    if (body.password) return SB.fn('utilisateurs', { action: 'mot_de_passe', user_id: m[1], password: body.password });
    return SB.rpc('user_update', { p_user: m[1], p: body });
  }
  if (method === 'POST' && R(/^\/api\/admin\/demo$/)) return SB.rpc(body.action === 'load' ? 'demo_load' : 'demo_clear');
  if (method === 'GET' && R(/^\/api\/audit$/)) return SB.rpc('audit_list', { p_entity: q.entity || null });
  throw new Error('Route inconnue : ' + method + ' ' + path);
}

async function supplierList(q) {
  // Lecture directe de la vue (protégée par les règles d'accès)
  const params = new URLSearchParams({ select: '*', is_demo: `eq.${q.demo === '1'}`, status: q.status ? `eq.${q.status}` : 'neq.fusionne', order: 'status.desc,name.asc' });
  if (q.search) {
    const s = q.search.replace(/[(),*]/g, ' ').trim();
    params.set('or', `(name.ilike.*${s}*,siren.ilike.*${s}*,siret.ilike.*${s}*,vat.ilike.*${s}*,trade_name.ilike.*${s}*)`);
  }
  const rows = await SB.select('suppliers_v', params.toString());
  const order = { propose: 0, actif: 1 };
  return rows.sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name, 'fr'));
}

// ------------------------------------------------------------------ export Excel (XLSX minimal, généré dans le navigateur)
const XLSX_MINI = (() => {
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const te = new TextEncoder();
  function zip(files) {
    const parts = [], central = []; let offset = 0;
    for (const [name, content] of files) {
      const nb = te.encode(name), data = te.encode(content), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
      parts.push(new Uint8Array(h.buffer), nb, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), nb);
      offset += 30 + nb.length + data.length;
    }
    const csize = central.reduce((s, p) => s + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  const col = i => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  function build(header, rows, moneyCols) {
    const cell = (v, r, c) => {
      const ref = col(c) + (r + 1);
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'number') return `<c r="${ref}"${moneyCols.has(c) ? ' s="1"' : ''}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    };
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>` +
      [header, ...rows].map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, r, c)).join('')}</row>`).join('') + `</sheetData></worksheet>`;
    return zip([
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Factures" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>'],
      ['xl/worksheets/sheet1.xml', sheet],
    ]);
  }
  return { build };
})();

const EXPORT_COLS = [
  ['id', 'N° interne'], ['doc_type', 'Type'], ['supplier_name', 'Fournisseur'], ['supplier_siret', 'SIRET'], ['supplier_vat', 'TVA intracom.'],
  ['company_name', 'Société facturée'], ['reference', 'Référence'], ['invoice_date', 'Date facture'], ['due_date', 'Échéance'], ['due_rule', 'Règle d\'échéance'],
  ['payment_terms', 'Conditions'], ['amount_ht', 'HT'], ['amount_tva', 'TVA'], ['amount_ttc', 'TTC'], ['currency', 'Devise'], ['paid', 'Payé'],
  ['credited', 'Avoirs imputés'], ['balance', 'Solde'], ['validation_status', 'Validation'], ['payment_status', 'Paiement'], ['situation', 'Situation'],
  ['days_late', 'Jours de retard'], ['duplicate_status', 'Doublon'], ['order_ref', 'Commande / BL'], ['payment_method', 'Mode de règlement'], ['iban', 'IBAN (lu)'], ['anomalies', 'Anomalies'],
];
const MONEY_KEYS = new Set(['amount_ht', 'amount_tva', 'amount_ttc', 'paid', 'credited', 'balance']);
function noFormula(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }  // protection contre l'injection de formules

async function exportInvoices(p, fmt) {
  const rows = await SB.rpc('invoices_export', { p });
  const val = (r, k) => k === 'anomalies' ? (r.anomalies || []).map(a => a.message).join(' | ') : r[k];
  const name = `factures_${new Date().toISOString().slice(0, 10)}`;
  let blob;
  if (fmt === 'csv') {
    const cell = (k, v) => { if (v === null || v === undefined) return ''; if (MONEY_KEYS.has(k)) return (v / 100).toFixed(2).replace('.', ','); const s = noFormula(String(v)); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [EXPORT_COLS.map(c => c[1]).join(';'), ...rows.map(r => EXPORT_COLS.map(([k]) => cell(k, val(r, k))).join(';'))];
    blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  } else {
    const money = new Set(EXPORT_COLS.map((c, i) => MONEY_KEYS.has(c[0]) ? i : -1).filter(i => i >= 0));
    blob = XLSX_MINI.build(EXPORT_COLS.map(c => c[1]), rows.map(r => EXPORT_COLS.map(([k]) => {
      const v = val(r, k);
      if (MONEY_KEYS.has(k) && v !== null && v !== undefined) return v / 100;
      return typeof v === 'string' ? noFormula(v) : v;
    })), money);
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${name}.${fmt}`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return rows.length;
}

async function openStored(bucket, path, filename) {
  const url = await SB.signedUrl(bucket, path, filename || true);
  const a = document.createElement('a');
  a.href = url; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

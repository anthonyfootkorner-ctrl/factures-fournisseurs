'use strict';
/* Suivi des factures fournisseurs — interface (JavaScript natif, aucune dépendance).
   Toutes les données issues des documents sont insérées via textContent : jamais interprétées comme du HTML. */

// ------------------------------------------------------------------ utilitaires
const S = { user: null, demo: false, lookups: { companies: [], suppliers: [], categories: [] }, reviewQueue: [] };
try { S.demo = localStorage.getItem('sf_demo') === '1'; } catch (e) {}

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'style') e.style.cssText = v;  // via le DOM : compatible avec la CSP (pas d'attribut style en ligne)
    else if (k === 'checked') e.checked = !!v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const $ = (s, r = document) => r.querySelector(s);
// append()/replaceChildren() natifs convertissent null en texte « null » : on filtre les valeurs vides.
for (const m of ['append', 'replaceChildren']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false)); };
}
const canWrite = () => S.user && (S.user.role === 'admin' || S.user.role === 'finance');
const isAdmin = () => S.user && S.user.role === 'admin';

async function api(method, url, body, opts = {}) {
  try { return await apiRoute(method, url, body); }
  catch (e) {
    if (e.status === 401 && !opts.quiet) { await SB.logout(); S.user = null; render(); }
    throw e;
  }
}
function toast(msg, err) {
  const t = el('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 8000 : 3500);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); throw e; }
}
function qs(o) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v !== null && v !== undefined) p.set(k, v);
  if (S.demo) p.set('demo', '1');
  return p.toString();
}
const nf = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function money(c, cur) { if (c === null || c === undefined) return '—'; return nf.format(c / 100) + (cur ? ' ' + cur : ''); }
function moneyIn(c) { return c === null || c === undefined ? '' : nf.format(c / 100); }
// Dates seules (AAAA-MM-JJ) affichées telles quelles ; horodatages convertis à l'heure locale (Paris).
function d(iso) {
  if (!iso) return '—';
  if (String(iso).length > 10) { const x = new Date(iso); if (!isNaN(x)) return x.toLocaleDateString('fr-FR'); }
  const [y, m, dd] = String(iso).slice(0, 10).split('-'); return `${dd}/${m}/${y}`;
}
function dt(iso) {
  if (!iso) return '—';
  const x = new Date(iso);
  if (isNaN(x)) return d(iso);
  return x.toLocaleDateString('fr-FR') + ' ' + x.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
const todo = () => el('span', { class: 'todo' }, 'À compléter');

const L = {
  validation: { a_verifier: ['À vérifier', 'b-warn'], validee: ['Validée', 'b-ok'], rejetee: ['Rejetée', 'b-bad'] },
  payment: { non_payee: ['Non payée', ''], partielle: ['Partiellement payée', 'b-info'], payee: ['Payée', 'b-ok'] },
  payment_avoir: { non_payee: ['Non imputé', ''], partielle: ['Partiellement imputé', 'b-info'], payee: ['Imputé', 'b-ok'] },
  situation: { a_echeance: ['À échéance', 'b-info'], en_retard: ['En retard', 'b-bad'], litige: ['En litige', 'b-bad'], soldee: ['Soldée', 'b-ok'], sans_echeance: ['Sans échéance', 'b-warn'] },
  duplicate: { aucun: ['—', ''], suspect: ['Doublon potentiel', 'b-bad'], confirme: ['Doublon confirmé', 'b-bad'], ecarte: ['Non-doublon', ''] },
  doc_type: { facture: ['Facture', ''], avoir: ['Avoir', 'b-info'], autre: ['Autre document', 'b-warn'] },
  item: { en_attente: ['En attente', ''], traitement: ['Traitement…', 'b-info'], termine: ['Terminé', 'b-ok'], erreur: ['Erreur', 'b-bad'], doublon: ['Doublon exact', 'b-warn'], correspondance: ['Colonnes à confirmer', 'b-warn'], ignore: ['Ignoré', ''] },
  supplier: { actif: ['Actif', 'b-ok'], propose: ['Proposition à valider', 'b-warn'], fusionne: ['Fusionné', ''] },
  role: { admin: 'Administrateur', finance: 'Finance', lecture: 'Lecture seule' },
  src: { document: ['lu', 'Valeur lue dans le document'], calcul: ['calculé', 'Valeur calculée'], saisie: ['saisi', 'Valeur saisie / corrigée par un utilisateur'], referentiel: ['réf.', 'Valeur issue du référentiel'] },
};
function badge(map, key) { const v = (L[map] || {})[key] || [key, '']; return el('span', { class: 'badge ' + v[1] }, v[0]); }

function modal(title, body, actions) {
  const bg = el('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) bg.remove(); } });
  const close = () => bg.remove();
  const box = el('div', { class: 'modal', role: 'dialog' }, el('h2', {}, title), body,
    el('div', { class: 'actions' }, el('button', { onclick: close }, 'Annuler'), ...(actions || []).map(a => {
      const b = el('button', { class: a.cls || 'primary', onclick: async () => { b.disabled = true; try { await a.fn(close); } catch (e) { b.disabled = false; } } }, a.label);
      return b;
    })));
  bg.appendChild(box); document.body.appendChild(bg);
  const f = box.querySelector('input,textarea,select'); if (f) f.focus();
  return close;
}
function confirmBox(title, text, label, fn, cls = 'danger') {
  modal(title, el('p', {}, text), [{ label, cls, fn: async close => { await fn(); close(); } }]);
}
function promptBox(title, text, label, fn, opts = {}) {
  const ta = el(opts.input ? 'input' : 'textarea', { placeholder: opts.placeholder || '' });
  modal(title, el('div', {}, el('p', {}, text), ta), [{ label, cls: opts.cls || 'primary', fn: async close => { await act(() => fn(ta.value)); close(); } }]);
}

function workerState(last) {
  if (!last) return { label: 'jamais connecté', cls: 'b-bad', ok: false };
  const age = (Date.now() - new Date(last).getTime()) / 1000;
  if (age < 120) return { label: 'en ligne', cls: 'b-ok', ok: true };
  return { label: 'hors ligne depuis le ' + new Date(last).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }), cls: 'b-warn', ok: false };
}
function signedImg(path, alt, cls) {
  const img = el('img', { alt, class: cls || null });
  SB.signedUrl('pieces', path).then(u => { img.src = u; }).catch(() => { img.alt = alt + ' — aperçu indisponible'; });
  return img;
}
function changeOwnPassword() {
  const a = el('input', { type: 'password', autocomplete: 'new-password' }), b = el('input', { type: 'password', autocomplete: 'new-password' });
  modal('Changer mon mot de passe', el('div', {}, el('label', { class: 'f' }, 'Nouveau mot de passe (10 caractères minimum)', a), el('label', { class: 'f' }, 'Confirmation', b)),
    [{ label: 'Enregistrer', fn: async close => { if (a.value !== b.value) { toast('Les mots de passe ne correspondent pas', true); throw new Error(); }
      await act(() => SB.fn('utilisateurs', { action: 'mot_de_passe', password: a.value }), 'Mot de passe modifié'); close(); } }]);
}

// ------------------------------------------------------------------ squelette & routage
const NAV = [
  ['#/', 'Tableau de bord'], ['#/synthese', 'Synthèse'], ['#/factures', 'Factures'], ['#/a-verifier', 'À vérifier'],
  ['#/fournisseurs', 'Fournisseurs'], ['#/banque', 'Banque'], ['#/encaissements', 'Suivi encaissements web'], ['#/imports', 'Imports'], ['#/parametres', 'Paramètres'],
];
let reviewCount = null;
const ICONS = {
  '#/': 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  '#/synthese': 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  '#/factures': 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h6',
  '#/a-verifier': 'M9 11l3 3 7-7M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  '#/fournisseurs': 'M3 21V8l9-5 9 5v13M9 21v-6h6v6M3 21h18',
  '#/banque': 'M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18',
  '#/encaissements': 'M2 7h20v12H2zM2 11h20M6 15h4',
  '#/imports': 'M12 3v12M7 10l5 5 5-5M4 21h16',
  '#/parametres': 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  facture: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h6', paye: 'M20 6L9 17l-5-5', reste: 'M12 7v5l3 3M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
};
function icon(key, cls) {
  return svg('svg', { viewBox: '0 0 24 24', class: cls || 'ico', fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    svg('path', { d: ICONS[key] || ICONS['#/'] }));
}

async function boot() {
  S.user = null;
  if (SB.hasSession()) {
    try {
      S.user = await SB.rpc('me');
      if (!S.user) { await SB.logout(); return renderLogin('Ce compte n\'a pas (ou plus) accès à l\'application.'); }
    } catch (e) { await SB.logout(); }
  }
  render();
}
window.addEventListener('hashchange', () => render());
document.addEventListener('DOMContentLoaded', boot);

async function loadLookups() {
  S.lookups = await api('GET', '/api/lookups?' + qs({}));
}

let currentTimer = null;
let bannerTimer = null;
// Bandeau d'avancement des imports, visible sur toutes les pages tant qu'un traitement est en cours (actualisé toutes les 15 s).
async function refreshProgressBanner(box) {
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
  if (!document.body.contains(box)) return;
  let prog = null;
  try { prog = await api('GET', '/api/progress?' + qs({}), undefined, { quiet: true }); } catch (e) { return; }
  const lots = (prog.lots || []).filter(l => l.restants > 0);
  if (!lots.length || location.hash.startsWith('#/imports/')) { box.replaceChildren(); }
  else {
    const ws = workerState(prog.worker_last_seen);
    box.replaceChildren(el('div', { class: 'panel progress-banner' },
      el('div', { class: 'row', style: 'align-items:center;margin-bottom:6px' }, el('strong', {}, 'Import en cours'), el('span', { class: 'grow' }),
        el('span', { class: 'small' }, 'Poste de traitement : ', el('span', { class: 'badge ' + ws.cls }, ws.label))),
      lots.map(l => el('a', { href: '#/imports/' + l.id, class: 'progress-link' }, progressBlock(l, { title: l.label || ('Lot #' + l.id) })))));
  }
  bannerTimer = setTimeout(() => refreshProgressBanner(box), 15000);
}
async function render() {
  if (currentTimer) { clearInterval(currentTimer); currentTimer = null; }
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
  const app = $('#app');
  if (!S.user) return renderLogin();
  await loadLookups().catch(() => {});
  const hash = location.hash || '#/';
  const main = el('main', { class: 'main' });
  const nav = el('nav', { class: 'topnav' }, NAV.map(([h, label]) => {
    const active = h === '#/' ? hash === '#/' || hash === '' : hash.startsWith(h);
    const a = el('a', { href: h, class: active ? 'active' : '' }, el('span', { class: 'lbl' }, label));
    if (h === '#/a-verifier') a.appendChild(el('span', { class: 'count', id: 'review-count', style: 'display:none' }));
    return a;
  }));
  const demoBtn = el('button', { class: 'small', onclick: () => { S.demo = !S.demo; try { localStorage.setItem('sf_demo', S.demo ? '1' : '0'); } catch (e) {} render(); } },
    S.demo ? 'Revenir aux données réelles' : 'Voir les données de démo');
  // Menu du compte (déroulant) à droite de l'en-tête
  const menu = el('div', { class: 'acct-menu', hidden: true }, el('div', { class: 'who' }, S.user.name), el('div', { class: 'muted small' }, L.role[S.user.role]),
    demoBtn, el('button', { class: 'small', onclick: changeOwnPassword }, 'Mot de passe'),
    el('button', { class: 'small', onclick: async () => { await SB.logout(); S.user = null; render(); } }, 'Se déconnecter'));
  const acctBtn = el('button', { class: 'acct', title: S.user.name, onclick: e => { e.stopPropagation(); menu.hidden = !menu.hidden; } },
    svg('svg', { viewBox: '0 0 24 24', class: 'ico', fill: 'none', 'stroke-width': '1.8', 'stroke-linecap': 'round' },
      svg('circle', { cx: '12', cy: '8', r: '4' }), svg('path', { d: 'M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6' })));
  menu.addEventListener('click', e => e.stopPropagation());
  if (!window.__acctMenuClose) {  // un clic ailleurs referme le menu du compte (écouteur posé une seule fois)
    window.__acctMenuClose = true;
    document.addEventListener('click', () => { const m = document.querySelector('.acct-menu'); if (m) m.hidden = true; });
  }
  const header = el('header', { class: 'topbar' },
    el('div', { class: 'topmain' },
      el('a', { href: '#/', class: 'brand', title: 'Tableau de bord' }, el('img', { src: 'logo-blanc.png', alt: 'Foot Korner', class: 'brand-logo' }),
        el('span', { class: 'brand-name' }, 'Foot Korner', el('small', {}, 'Factures fournisseurs'))),
      nav,
      el('div', { class: 'acct-wrap' }, S.demo ? el('span', { class: 'demo-pill' }, 'Démo') : null, acctBtn, menu)));
  app.replaceChildren(el('div', { class: 'layout top' }, header, main));
  const act0 = nav.querySelector('a.active'); if (act0 && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = act0.offsetLeft - 14;  // menu défilant : page active visible
  if (S.demo) main.appendChild(el('div', { class: 'demo-banner' }, 'MODE DÉMONSTRATION — données fictives, séparées des données réelles'));
  const banner = el('div');
  main.appendChild(banner);
  const view = el('div');
  main.appendChild(view);
  updateReviewCount();
  refreshProgressBanner(banner);
  const parts = hash.slice(2).split('?')[0].split('/');
  try {
    if (parts[0] === '' ) await viewDashboard(view);
    else if (parts[0] === 'factures' && parts[1]) await viewInvoice(view, +parts[1]);
    else if (parts[0] === 'factures') await viewInvoices(view, {});
    else if (parts[0] === 'a-verifier') await viewReview(view);
    else if (parts[0] === 'fournisseurs' && parts[1]) await viewSupplier(view, +parts[1]);
    else if (parts[0] === 'fournisseurs') await viewSuppliers(view);
    else if (parts[0] === 'imports' && parts[1]) await viewBatch(view, +parts[1]);
    else if (parts[0] === 'imports') await viewImports(view);
    else if (parts[0] === 'parametres') await viewSettings(view);
    else if (parts[0] === 'banque') await viewBank(view);
    else if (parts[0] === 'synthese') await viewSynthese(view);
    else if (parts[0] === 'encaissements') await viewEncaissements(view);
    else view.appendChild(el('p', {}, 'Page introuvable'));
  } catch (e) { view.appendChild(el('div', { class: 'callout bad' }, e.message)); }
}
async function updateReviewCount() {
  try {
    const r = await api('GET', '/api/invoices?' + qs({ validation: 'a_verifier', per_page: 1 }));
    const c = $('#review-count');
    if (c && r.total) { c.textContent = r.total; c.style.display = ''; }
  } catch (e) {}
}
function getHashParams() { const q = (location.hash.split('?')[1] || ''); return Object.fromEntries(new URLSearchParams(q)); }

// ------------------------------------------------------------------ connexion
function renderLogin(info) {
  const email = el('input', { type: 'email', autocomplete: 'username' });
  const pw = el('input', { type: 'password', autocomplete: 'current-password' });
  const msg = el('div', { class: 'small', style: 'color:var(--bad);min-height:18px' });
  const submit = async e => {
    e.preventDefault();
    try { await SB.login(email.value.trim(), pw.value); await boot(); }
    catch (err) { msg.textContent = err.message; }
  };
  $('#app').replaceChildren(el('div', { class: 'login' }, el('form', { class: 'panel', onsubmit: submit },
    el('h1', {}, 'Suivi des factures fournisseurs'),
    info ? el('div', { class: 'callout' }, info) : null,
    el('label', { class: 'f' }, 'E-mail', email), el('label', { class: 'f' }, 'Mot de passe', pw), msg,
    el('button', { class: 'primary', type: 'submit' }, 'Se connecter'),
    el('p', { class: 'small muted', style: 'margin-top:14px' }, 'Mot de passe oublié : demandez à un administrateur de le réinitialiser. ',
      el('a', { href: '#', onclick: e => { e.preventDefault(); renderSetup(); } }, 'Première installation')))));
  email.focus();
}
function renderSetup() {
  const code = el('input', { autocomplete: 'off' }), name = el('input'), email = el('input', { type: 'email' }), pw = el('input', { type: 'password' }), pw2 = el('input', { type: 'password' });
  const msg = el('div', { class: 'small', style: 'color:var(--bad);min-height:18px' });
  const submit = async e => {
    e.preventDefault();
    if (pw.value !== pw2.value) { msg.textContent = 'Les mots de passe ne correspondent pas'; return; }
    try { await SB.fn('utilisateurs', { action: 'installer', code: code.value, name: name.value, email: email.value, password: pw.value }, true);
      await SB.login(email.value.trim(), pw.value); boot(); }
    catch (err) { msg.textContent = err.message; }
  };
  $('#app').replaceChildren(el('div', { class: 'login' }, el('form', { class: 'panel', onsubmit: submit },
    el('h1', {}, 'Première installation'), el('p', { class: 'muted' }, 'Créez le compte administrateur avec le code d\'installation à usage unique.'),
    el('label', { class: 'f' }, 'Code d\'installation', code), el('label', { class: 'f' }, 'Nom', name), el('label', { class: 'f' }, 'E-mail', email),
    el('label', { class: 'f' }, 'Mot de passe (10 caractères minimum)', pw), el('label', { class: 'f' }, 'Confirmation', pw2), msg,
    el('button', { class: 'primary', type: 'submit' }, 'Créer le compte'), ' ',
    el('button', { type: 'button', onclick: () => renderLogin() }, 'Retour'))));
}

// ------------------------------------------------------------------ graphiques SVG
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); kids.flat().forEach(k => k && e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k)); return e; }
function shortMoney(c) { const v = c / 100; if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + ' M'; if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + ' k'; return Math.round(v) + ''; }
function barChart(items, opts = {}) {
  // items: [{label, values:[{v, cls, title}]}] — barres empilées
  const W = 720, H = opts.h || 220, padL = 46, padB = 34, padT = 10;
  const max = Math.max(1, ...items.map(i => i.values.reduce((s, x) => s + Math.max(0, x.v), 0)));
  const bw = (W - padL - 10) / Math.max(1, items.length);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  for (let t = 0; t <= 4; t++) {
    const y = padT + (H - padT - padB) * (1 - t / 4);
    g.appendChild(svg('line', { x1: padL, x2: W - 6, y1: y, y2: y, class: 'grid' }));
    g.appendChild(svg('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end' }, shortMoney(max * t / 4)));
  }
  items.forEach((it, i) => {
    let y = H - padB;
    const x = padL + i * bw + bw * 0.15;
    it.values.forEach(val => {
      const h = Math.max(0, val.v) / max * (H - padT - padB);
      if (h > 0) { const r = svg('rect', { x, y: y - h, width: bw * 0.7, height: h, class: val.cls || 'bar' }); r.appendChild(svg('title', {}, val.title || '')); g.appendChild(r); }
      y -= h;
    });
    g.appendChild(svg('text', { x: x + bw * 0.35, y: H - padB + 14, 'text-anchor': 'middle' }, it.label));
    if (it.sub) g.appendChild(svg('text', { x: x + bw * 0.35, y: H - padB + 27, 'text-anchor': 'middle' }, it.sub));
  });
  return g;
}

// ------------------------------------------------------------------ synthèse : facturé, payé, reste à régler par semaine d'échéance
function isoDate(x) { return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }
function periodePreset(k) {
  const t = new Date(), y = t.getFullYear(), m = t.getMonth();
  if (k === 'mois') return [new Date(y, m, 1), new Date(y, m + 1, 0)];
  if (k === 'mois_prec') return [new Date(y, m - 1, 1), new Date(y, m, 0)];
  if (k === 'trimestre') { const q = Math.floor(m / 3) * 3; return [new Date(y, q, 1), new Date(y, q + 3, 0)]; }
  if (k === 'annee') return [new Date(y, 0, 1), new Date(y, 11, 31)];
  if (k === '12mois') return [new Date(y, m - 11, 1), new Date(y, m + 1, 0)];
  return null;
}
const FAMILLES = { textile: 'Textile', charges_fixes: 'Charges fixes', autre: 'Autres' };
function famLabels(v) { return (v || '').split(',').filter(Boolean).map(k => FAMILLES[k] || k); }
// Colonne de filtres (droite) : familles de fournisseurs (plusieurs cochables), exercice fiscal, raccourcis, dates, société, fournisseur
function filtersAside(p, go, o = {}) {
  const sel = (p.famille || '').split(',').filter(Boolean);
  const toggle = k => go({ ...p, famille: (sel.includes(k) ? sel.filter(x => x !== k) : Object.keys(FAMILLES).filter(x => sel.includes(x) || x === k)).join(',') });
  const famBox = el('div', { class: 'f-checks' }, Object.entries(FAMILLES).map(([k, l]) => el('label', { class: 'f-check fam-' + k + (sel.includes(k) ? ' on' : '') },
    el('input', { type: 'checkbox', checked: sel.includes(k) ? 'checked' : null, onchange: () => toggle(k) }), el('span', {}, l))));
  const from = el('input', { type: 'date', value: p.from || '' }), to = el('input', { type: 'date', value: p.to || '' });
  const isCur = (a, b) => !p.tout && p.from === isoDate(a) && p.to === isoDate(b);
  const preset = (k, label) => { const [a, b] = periodePreset(k);
    return el('button', { class: 'small' + (isCur(a, b) ? ' primary' : ''), onclick: () => go({ ...p, tout: '', from: isoDate(a), to: isoDate(b) }) }, label); };
  const ec = exerciceCourant();
  const fyTile = y => { const [a, b] = exercice(y);
    return el('button', { class: 'fy-tile' + (isCur(a, b) ? ' on' : ''), onclick: () => go({ ...p, tout: '', from: isoDate(a), to: isoDate(b) }) },
      el('span', { class: 'fy-y' }, `${y}-${String(y + 1).slice(2)}`), el('span', { class: 'fy-d' }, `juin ${y} → mai ${y + 1}`), y === ec ? el('span', { class: 'fy-cur' }, 'en cours') : null); };
  const optSel = (key, label, options) => { const sl = el('select', { onchange: () => go({ ...p, [key]: sl.value }) }, el('option', { value: '' }, 'Tous'),
      options.map(([v, l]) => el('option', { value: v, selected: String(p[key] || '') === String(v) ? 'selected' : null }, l))); return [el('div', { class: 'f-label' }, label), sl]; };
  return el('aside', { class: 'synth-filters' }, el('h2', {}, 'Filtres'),
    el('div', { class: 'f-label' }, 'Famille de fournisseurs'), famBox,
    o.fiscal ? [el('div', { class: 'f-label' }, 'Exercice fiscal'), el('div', { class: 'fy-grid' }, [ec - 2, ec - 1, ec].map(fyTile),
      el('button', { class: 'fy-tile' + (p.tout ? ' on' : ''), onclick: () => go({ ...p, from: '', to: '', tout: '1' }) }, el('span', { class: 'fy-y' }, 'Tout'), el('span', { class: 'fy-d' }, 'toutes périodes')))] : null,
    o.presets ? [el('div', { class: 'f-label' }, 'Raccourcis'), el('div', { class: 'f-chips' }, preset('mois', 'Ce mois'), preset('mois_prec', 'Mois dernier'), preset('trimestre', 'Ce trimestre'), preset('12mois', '12 derniers mois'))] : null,
    el('div', { class: 'f-label' }, o.dateLabel || 'Dates de facture'),
    el('div', { class: 'f-dates' }, el('label', { class: 'f' }, 'Du', from), el('label', { class: 'f' }, 'Au', to)),
    el('button', { class: 'primary small f-apply', onclick: () => go({ ...p, tout: '', from: from.value, to: to.value }) }, 'Appliquer les dates'),
    o.company ? optSel('company_id', 'Société facturée', S.lookups.companies.map(c => [c.id, c.name])) : null,
    o.supplier ? optSel('supplier_id', 'Fournisseur', S.lookups.suppliers.map(x => [x.id, x.name])) : null,
    el('button', { class: 'small f-reset', onclick: () => go({}) }, 'Réinitialiser les filtres'),
    o.note ? el('p', { class: 'muted small f-note' }, o.note) : null);
}
// Exercice fiscal Foot Korner : du 1er juin au 31 mai
function exercice(startYear) { return [new Date(startYear, 5, 1), new Date(startYear + 1, 4, 31)]; }
function exerciceCourant() { const t = new Date(); return t.getMonth() >= 5 ? t.getFullYear() : t.getFullYear() - 1; }
async function viewSynthese(view) {
  const p = getHashParams();
  const ec = exerciceCourant();
  if (!p.from && !p.to && !p.tout) { const [a, b] = exercice(ec); p.from = isoDate(a); p.to = isoDate(b); }
  const go = np => { location.hash = '#/synthese?' + new URLSearchParams(Object.fromEntries(Object.entries(np).filter(([, v]) => v))); };
  const filters = filtersAside(p, go, { fiscal: true, presets: true, company: true, supplier: true,
    note: 'Période = date des factures. Le reste à régler est réparti par semaine d\'échéance (lundi → dimanche). Famille = classement du fournisseur (catégories Pennylane, modifiable sur sa fiche).' });
  const periodeTxt = (p.tout ? 'Toutes périodes' : `Factures du ${d(p.from)} au ${d(p.to)}`) + (p.famille ? ' · ' + famLabels(p.famille).join(' + ') : '');
  const left = el('div', { class: 'synth-main' });
  view.append(el('div', { class: 'crumb' }, el('a', { href: '#/' }, 'Tableau de bord'), ' / ', 'Synthèse'),
    el('h1', {}, 'Synthèse des factures fournisseurs'), el('div', { class: 'muted page-sub' }, periodeTxt),
    el('div', { class: 'synth-layout' }, left, filters));
  view = left;
  const q = Object.fromEntries(Object.entries(Object.assign(p.tout ? {} : { from: p.from, to: p.to }, { famille: p.famille, company_id: p.company_id, supplier_id: p.supplier_id })).filter(([, v]) => v));
  const data = await api('GET', '/api/synthese?' + qs(q));
  const curs = Object.keys(data.currencies);
  if (!curs.length) { view.appendChild(el('div', { class: 'panel empty' }, 'Aucune facture sur cette période.')); return; }
  const listLink = extra => '#/factures?' + new URLSearchParams(Object.fromEntries(Object.entries({ ...q, doc_type: 'facture', ...extra }).filter(([, v]) => v)));
  const addDays = (iso, n) => { const x = new Date(iso + 'T12:00:00'); x.setDate(x.getDate() + n); return isoDate(x); };
  for (const cur of curs) {
    const c = data.currencies[cur];
    const box = el('section', {});
    if (curs.length > 1) box.appendChild(el('h2', {}, 'Devise : ' + cur));
    const retard = (c.semaines.find(s => s.semaine === 'retard') || {}).montant || 0;
    const pct = c.facture.ttc ? Math.round(c.paye.montant / c.facture.ttc * 100) : 0;
    const big = (lab, v, sub, cls, href, ic) => el('a', { class: 'kpi big ' + (cls || ''), href: href || null }, el('div', { class: 'ic' }, icon(ic, 'kic')),
      el('div', { class: 'l' }, lab), el('div', { class: 'v' }, money(v, cur)), sub ? el('div', { class: 's' }, sub) : null);
    box.appendChild(el('div', { class: 'kpis synth-kpis' },
      big('Facturé (TTC)', c.facture.ttc, `${c.facture.n} facture(s)` + (c.avoirs.n ? ` — avoirs : ${money(c.avoirs.ttc, cur)}` : '') + (c.sans_montant ? ` — ${c.sans_montant} sans montant lu` : ''), '', listLink({}), 'facture'),
      big('Déjà payé', c.paye.montant, `${pct} % du facturé`, 'ok', listLink({ payment: 'payee,partielle' }), 'paye'),
      big('Reste à régler', c.reste.montant, `${c.reste.n} facture(s)` + (retard ? ` — dont en retard : ${money(retard, cur)}` : ''), retard ? 'bad' : 'warn', listLink({ open: '1' }), 'reste')));
    box.appendChild(el('div', { class: 'synth-bar', title: `Payé ${pct} %` }, el('div', { style: `width:${pct}%` })));
    const fams = c.familles || {};
    const fkeys = Object.keys(FAMILLES).filter(k => fams[k]);
    if (fkeys.length > 1) box.appendChild(el('div', { class: 'panel' }, el('h2', {}, 'Par famille de fournisseurs'), el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Famille'), el('th', { class: 'num' }, 'Factures'), el('th', { class: 'num' }, 'Facturé'), el('th', { class: 'num' }, 'Payé'), el('th', { class: 'num' }, 'Reste à régler'), el('th', { class: 'num' }, 'dont en retard'))),
      el('tbody', {}, fkeys.map(k => el('tr', { class: 'clickable', onclick: () => go({ ...p, famille: k }) },
        el('td', {}, el('span', { class: 'fam-dot fam-' + k }), FAMILLES[k]), el('td', { class: 'num' }, fams[k].n), el('td', { class: 'num' }, money(fams[k].facture, cur)),
        el('td', { class: 'num' }, money(fams[k].paye, cur)), el('td', { class: 'num' }, money(fams[k].reste, cur)),
        el('td', { class: 'num' + (fams[k].retard ? ' fc-bad' : '') }, fams[k].retard ? money(fams[k].retard, cur) : '—')))))));
    const lib = s => s.semaine === 'retard' ? 'En retard' : s.semaine === 'sans_echeance' ? 'Sans échéance' : s.semaine === 'litige' ? 'En litige'
      : (s.semaine === data.semaine_courante ? 'Cette semaine' : 'Sem. du ' + d(s.semaine).slice(0, 5));
    const weeks = c.semaines.filter(s => !['retard', 'sans_echeance', 'litige'].includes(s.semaine));
    box.appendChild(el('div', { class: 'panel' }, el('h2', {}, 'Reste à régler par semaine d\'échéance' + (retard ? ` — hors retard (${money(retard, cur)}, voir tableau)` : '')),
      c.semaines.length ? [barChart(c.semaines.filter(s => s.semaine !== 'retard').slice(0, 26).map(s => ({ label: s.semaine === 'retard' ? 'Retard' : s.semaine === 'sans_echeance' ? 'Sans éch.' : s.semaine === 'litige' ? 'Litige' : d(s.semaine).slice(0, 5),
          values: [{ v: s.montant, cls: s.semaine === 'retard' ? 'bar-bad' : ['sans_echeance', 'litige'].includes(s.semaine) ? 'bar-grey' : 'bar', title: `${lib(s)} : ${money(s.montant, cur)} (${s.n} facture(s))` }] })), { h: 200 }),
        weeks.length > 26 ? el('div', { class: 'muted small' }, 'Graphique limité aux 26 premières semaines ; le tableau ci-dessous donne tout.') : null]
        : el('div', { class: 'muted' }, 'Rien à régler sur cette période.')));
    const tbody = el('tbody');
    c.semaines.forEach(s => {
      const due = s.semaine.length === 10 ? { due_from: s.semaine, due_to: addDays(s.semaine, 6) } : s.semaine === 'retard' ? { situation: 'en_retard' } : s.semaine === 'sans_echeance' ? { situation: 'sans_echeance' } : { situation: 'litige' };
      const detail = el('tr', { class: 'synth-detail', hidden: true }, el('td', { colspan: 4 }, el('table', { class: 'inner' }, el('tbody', {},
        s.fournisseurs.map(f => el('tr', {}, el('td', {}, f.supplier_id ? el('a', { href: '#/fournisseurs/' + f.supplier_id }, f.supplier_name) : f.supplier_name),
          el('td', { class: 'num' }, f.n + ' fact.'), el('td', { class: 'num' }, f.premiere_echeance ? 'dès le ' + d(f.premiere_echeance) : '—'), el('td', { class: 'num' }, money(f.montant, cur))))))));
      const row = el('tr', { class: 'clickable' + (s.semaine === 'retard' ? ' row-bad' : '') },
        el('td', {}, el('span', { class: 'caret' }, '▸ '), lib(s), s.semaine.length === 10 ? el('span', { class: 'muted small' }, ` (${d(s.semaine)} → ${d(addDays(s.semaine, 6))})`) : null),
        el('td', { class: 'num' }, s.n), el('td', { class: 'num' }, el('a', { href: listLink({ open: '1', ...due }), onclick: e => e.stopPropagation() }, money(s.montant, cur))),
        el('td', { class: 'num muted' }, s.valide ? money(s.valide, cur) : '—'));
      row.onclick = () => { detail.hidden = !detail.hidden; row.querySelector('.caret').textContent = detail.hidden ? '▸ ' : '▾ '; };
      tbody.append(row, detail);
    });
    box.appendChild(el('div', { class: 'panel' }, el('h2', {}, 'Détail par semaine (cliquez une ligne pour voir les fournisseurs)'),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Échéance'), el('th', { class: 'num' }, 'Factures'), el('th', { class: 'num' }, 'Reste à régler'), el('th', { class: 'num' }, 'dont validé'))), tbody)));
    view.appendChild(box);
  }
}

// ------------------------------------------------------------------ échéances des 3 prochaines semaines (en tête du tableau de bord)
async function echeancesHero(view, base) {
  const data = await api('GET', '/api/synthese?' + qs({ ...base })).catch(() => null);
  if (!data) return;
  const curs = Object.keys(data.currencies);
  const cur = curs.includes('EUR') ? 'EUR' : curs[0];
  if (!cur) return;
  const c = data.currencies[cur];
  const addDays = (iso, n) => { const x = new Date(iso + 'T12:00:00'); x.setDate(x.getDate() + n); return isoDate(x); };
  const monday = data.semaine_courante;
  const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
  const link = extra => '#/factures?' + new URLSearchParams(clean({ ...base, doc_type: 'facture', open: '1', ...extra }));
  const weeks = [0, 7, 14].map((off, i) => {
    const ws = addDays(monday, off), we = addDays(ws, 6);
    const w = c.semaines.find(x => x.semaine === ws) || { n: 0, montant: 0, valide: 0, fournisseurs: [] };
    return { ...w, ws, we, title: ['Cette semaine', 'Semaine prochaine', 'Dans 2 semaines'][i] };
  });
  const retard = c.semaines.find(x => x.semaine === 'retard');
  const total = weeks.reduce((s, w) => s + (w.montant || 0), 0), n = weeks.reduce((s, w) => s + (w.n || 0), 0);
  const max = Math.max(1, ...weeks.map(w => w.montant || 0));
  const split = {}; weeks.forEach(w => Object.entries(w.familles || {}).forEach(([k, v]) => { split[k] = (split[k] || 0) + v; }));
  const famLine = (obj, cls) => { const ks = Object.keys(FAMILLES).filter(k => obj[k]); return ks.length ? el('div', { class: cls },
    ks.map(k => el('a', { href: link({ due_from: monday, due_to: addDays(monday, 20), famille: k }), class: 'fam-chip fam-' + k, onclick: e => e.stopPropagation() }, el('span', { class: 'fam-dot fam-' + k }), FAMILLES[k] + ' ', el('b', {}, money(obj[k], cur))))) : null; };
  view.appendChild(el('section', { class: 'hero' },
    el('div', { class: 'hero-head' },
      el('a', { class: 'hero-total', href: link({ due_from: monday, due_to: addDays(monday, 20) }) },
        el('div', { class: 'hero-k' }, 'À régler dans les 3 prochaines semaines'),
        el('div', { class: 'hero-v' }, money(total, cur)),
        el('div', { class: 'hero-s' }, `${n} facture(s) · échéances du ${d(monday)} au ${d(addDays(monday, 20))}`),
        base.famille ? null : famLine(split, 'hero-split')),
      retard && retard.montant ? el('a', { class: 'hero-late', href: link({ situation: 'en_retard' }) },
        el('span', { class: 'hl-l' }, 'Déjà en retard'), el('span', { class: 'hl-v' }, money(retard.montant, cur)),
        el('span', { class: 'hl-s' }, `${retard.n} facture(s) à régulariser`)) : null),
    el('div', { class: 'hero-weeks' }, weeks.map((w, i) => el('a', { class: 'hero-week' + (i === 0 ? ' now' : ''), href: link({ due_from: w.ws, due_to: w.we }) },
      el('div', { class: 'hw-t' }, w.title, el('span', { class: 'hw-d' }, `${d(w.ws).slice(0, 5)} → ${d(w.we).slice(0, 5)}`)),
      el('div', { class: 'hw-v' }, money(w.montant || 0, cur)),
      el('div', { class: 'hw-bar' }, el('div', { style: `width:${(w.montant || 0) / max * 100}%` })),
      el('div', { class: 'hw-n' }, w.n ? `${w.n} facture(s)` + (w.montant - w.valide > 0 ? ` · dont ${money(w.montant - w.valide, cur)} à vérifier` : '') : 'Rien à régler'),
      base.famille ? null : (w.familles && Object.keys(w.familles).length > 1 ? el('div', { class: 'hw-fam' }, Object.keys(FAMILLES).filter(k => w.familles[k]).map(k => el('span', { class: 'fam-chip fam-' + k }, el('span', { class: 'fam-dot fam-' + k }), FAMILLES[k] + ' ', el('b', {}, money(w.familles[k], cur))))) : null),
      el('ul', { class: 'hw-sup' }, (w.fournisseurs || []).slice(0, 4).map(f => el('li', {}, el('span', {}, f.supplier_name), el('span', { class: 'num' }, money(f.montant, cur))))),
      (w.fournisseurs || []).length > 4 ? el('div', { class: 'hw-more' }, `+ ${w.fournisseurs.length - 4} autre(s) fournisseur(s)`) : null)))));
}

// ------------------------------------------------------------------ tableau de bord
async function viewDashboard(view) {
  const p = Object.assign({ company_id: '', supplier_id: '', from: '', to: '', famille: '' }, getHashParams());
  const go = np => { location.hash = '#/?' + new URLSearchParams(Object.fromEntries(Object.entries(np).filter(([, v]) => v))); };
  const base = { company_id: p.company_id, supplier_id: p.supplier_id, from: p.from, to: p.to, famille: p.famille };
  const left = el('div', { class: 'synth-main' });
  const sub = [p.famille ? famLabels(p.famille).join(' + ') : '', p.from || p.to ? `factures ${p.from ? 'du ' + d(p.from) : ''} ${p.to ? 'au ' + d(p.to) : ''}`.trim() : ''].filter(Boolean).join(' · ');
  view.append(el('h1', {}, 'Tableau de bord'), sub ? el('div', { class: 'muted page-sub' }, sub) : null,
    el('div', { class: 'synth-layout' }, left, filtersAside(p, go, { fiscal: true, presets: true, company: true, supplier: true, note: 'Les échéances à venir ne dépendent pas des dates de facture ; le reste du tableau de bord, oui.' })));
  view = left;
  await echeancesHero(view, { company_id: p.company_id, supplier_id: p.supplier_id, famille: p.famille });
  const data = await api('GET', '/api/dashboard?' + qs(p));
  const link = extra => '#/factures?' + new URLSearchParams(Object.fromEntries(Object.entries({ ...base, ...extra }).filter(([, v]) => v)));
  // Alertes
  const al = data.alertes || {};
  const alertItems = [
    ['iban_modifie', 'Changement d\'IBAN à contrôler', 'b-bad'], ['doublon_potentiel', 'Doublons potentiels', 'b-bad'],
    ['montants_incoherents', 'Montants incohérents', 'b-warn'], ['echeance_absente', 'Échéances absentes', 'b-warn'],
    ['fournisseur_ambigu', 'Fournisseurs ambigus', 'b-warn'], ['fournisseur_propose', 'Nouveaux fournisseurs à valider', 'b-warn'],
    ['ocr_requis', 'Scans sans OCR', 'b-bad'], ['pas_une_facture', 'Documents qui ne sont pas des factures', 'b-warn'],
    ['echeance_avant_facture', 'Échéance antérieure à la facture', 'b-bad'], ['extraction_incertaine', 'Lectures incertaines', 'b-warn'],
  ].filter(a => al[a[0]]);
  const alertPanel = el('div', { class: 'panel' }, el('h2', {}, 'Alertes'),
    alertItems.length || data.imports_en_erreur ? el('div', { class: 'row' },
      alertItems.map(a => el('a', { href: link({ anomaly: a[0], validation: 'a_verifier' }), class: 'badge ' + a[2] }, `${a[1]} : ${al[a[0]]}`)),
      data.imports_en_erreur ? el('a', { href: '#/imports', class: 'badge b-bad' }, `Imports en erreur ou à compléter : ${data.imports_en_erreur}`) : null)
      : el('div', { class: 'muted' }, 'Aucune alerte en cours.'));
  view.appendChild(alertPanel);
  const curs = Object.keys(data.currencies);
  if (!curs.length) { view.appendChild(el('div', { class: 'panel empty' }, 'Aucune facture pour ces filtres. Commencez par un import.')); return; }
  if (curs.length > 1) view.appendChild(el('div', { class: 'callout info' }, `Plusieurs devises (${curs.join(', ')}) : les totaux sont présentés séparément, sans conversion.`));
  const treso = await api('GET', '/api/treasury?' + qs({})).catch(() => ({}));
  for (const cur of curs) {
    const c = data.currencies[cur];
    const tr = treso[cur];
    const box = el('section', {});
    if (curs.length > 1) box.appendChild(el('h2', {}, 'Devise : ' + cur));
    const kpi = (lab, v, sub, cls, href) => el('div', { class: 'kpi ' + (cls || '') }, el('a', { href: href || null }, el('div', { class: 'l' }, lab), el('div', { class: 'v' }, money(v, cur)), sub ? el('div', { class: 's' }, sub) : null));
    box.appendChild(el('div', { class: 'kpis' },
      tr ? kpi('Trésorerie (derniers soldes connus)', tr.solde, `${tr.comptes} compte(s), au ${d(tr.date_max)}${tr.date_min !== tr.date_max ? ' (le plus ancien : ' + d(tr.date_min) + ')' : ''}`, 'ok', '#/banque') : null,
      tr ? kpi('Trésorerie après retards et échéances ≤ 30 j', tr.solde - c.en_retard.montant - c.echeance_30j.montant, 'factures connues uniquement (validées et à vérifier)', tr.solde - c.en_retard.montant - c.echeance_30j.montant < 0 ? 'bad' : '', '#/banque') : null,
      kpi('Total restant à payer', c.restant.montant, `${c.restant.n} facture(s)`, '', link({ open: '1', doc_type: 'facture' })),
      kpi('dont validé', c.restant_valide.montant, `${c.restant_valide.n} facture(s)`, 'ok', link({ open: '1', doc_type: 'facture', validation: 'validee' })),
      kpi('dont à vérifier', c.restant_a_verifier.montant, `${c.restant_a_verifier.n} facture(s)`, 'warn', link({ open: '1', doc_type: 'facture', validation: 'a_verifier' })),
      kpi('En retard', c.en_retard.montant, `${c.en_retard.n} facture(s)`, 'bad', link({ situation: 'en_retard', doc_type: 'facture' })),
      kpi('Échéance ≤ 7 jours', c.echeance_7j.montant, `${c.echeance_7j.n} facture(s)`),
      kpi('Échéance ≤ 15 jours', c.echeance_15j.montant, `${c.echeance_15j.n} facture(s)`),
      kpi('Échéance ≤ 30 jours', c.echeance_30j.montant, `${c.echeance_30j.n} facture(s)`),
      kpi('Sans échéance', c.sans_echeance.montant, `${c.sans_echeance.n} facture(s) — non réparties`, 'warn', link({ situation: 'sans_echeance', doc_type: 'facture' })),
      kpi('En litige', c.litige.montant, `${c.litige.n} facture(s)`, c.litige.n ? 'bad' : '', link({ situation: 'litige' })),
      kpi('À vérifier (tous documents)', c.a_verifier.montant, `${c.a_verifier.n} document(s), montant TTC`, 'warn', '#/a-verifier'),
      kpi('Crédits fournisseurs (avoirs non imputés)', c.credits_disponibles.montant, `${c.credits_disponibles.n} avoir(s) — non déduits des totaux`, 'ok', link({ doc_type: 'avoir', open: '1' })),
    ));
    // Prévision hebdo
    const wk = c.prevision_semaines;
    const fc = el('div', { class: 'panel' }, el('h2', {}, 'Prévision des décaissements par semaine (selon les échéances)'),
      barChart([
        { label: 'Retard', values: [{ v: c.prevision_hors_semaines.en_retard, cls: 'bar-bad', title: 'Déjà en retard : ' + money(c.prevision_hors_semaines.en_retard, cur) }] },
        ...wk.map((w, i) => ({ label: i === 0 ? 'Cette sem.' : 'S+' + i, sub: d(w.debut).slice(0, 5),
          values: [{ v: w.valide, cls: 'bar', title: `Semaine du ${d(w.debut)} — validé : ${money(w.valide, cur)}` }, { v: w.montant - w.valide, cls: 'bar2', title: `à vérifier : ${money(w.montant - w.valide, cur)}` }] })),
        { label: 'Sans éch.', values: [{ v: c.prevision_hors_semaines.sans_echeance, cls: 'bar-grey', title: 'Sans échéance : ' + money(c.prevision_hors_semaines.sans_echeance, cur) }] },
      ]),
      el('div', { class: 'legend' }, el('span', {}, el('i', { style: 'background:#ff6b1a' }), 'Validé'), el('span', {}, el('i', { style: 'background:#ffb27a' }), 'À vérifier'),
        el('span', {}, el('i', { style: 'background:#ff5c5c' }), 'En retard (à régulariser)'), el('span', {}, el('i', { style: 'background:#5b6068' }), 'Sans échéance (non réparti)')));
    // Balance âgée
    const ag = c.balance_agee;
    const agItems = [['non_echu', 'Non échu', '#ff6b1a'], ['r1_30', '1–30 j', '#f5b84a'], ['r31_60', '31–60 j', '#ff8f4d'], ['r61_90', '61–90 j', '#ff5c5c'], ['r90p', '> 90 j', '#b3261e'], ['sans_echeance', 'Sans échéance', '#5b6068'], ['litige', 'En litige', '#b48cf2']];
    const agTotal = agItems.reduce((s, a) => s + ag[a[0]], 0) || 1;
    const agingPanel = el('div', { class: 'panel' }, el('h2', {}, 'Balance âgée (solde restant dû)'),
      el('div', { class: 'aging' }, agItems.filter(a => ag[a[0]] > 0).map(a => { const x = el('div', { style: `width:${ag[a[0]] / agTotal * 100}%;background:${a[2]}` }); x.title = `${a[1]} : ${money(ag[a[0]], cur)}`; return x; })),
      el('table', {}, el('tbody', {}, agItems.map(a => el('tr', {}, el('td', {}, el('i', { style: `display:inline-block;width:10px;height:10px;background:${a[2]};margin-right:6px` }), a[1]), el('td', { class: 'num' }, money(ag[a[0]], cur)))))));
    // Top fournisseurs
    const top = el('div', { class: 'panel' }, el('h2', {}, 'Principaux fournisseurs par montant restant dû'),
      c.top_fournisseurs.length ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Fournisseur'), el('th', { class: 'num' }, 'Factures'), el('th', { class: 'num' }, 'Restant dû'), el('th', { class: 'num' }, 'dont retard'))),
        el('tbody', {}, c.top_fournisseurs.map(t => el('tr', {}, el('td', {}, t.supplier_id ? el('a', { href: '#/fournisseurs/' + t.supplier_id }, t.supplier_name || '—') : (t.supplier_name || el('span', { class: 'todo' }, 'Fournisseur non identifié'))),
          el('td', { class: 'num' }, t.n), el('td', { class: 'num' }, money(t.montant, cur)), el('td', { class: 'num' }, t.retard ? money(t.retard, cur) : '—')))))
        : el('div', { class: 'muted' }, 'Rien à payer.'));
    // Mensuel
    const monthly = el('div', { class: 'panel' }, el('h2', {}, 'Montants facturés par mois (TTC)'),
      c.mensuel.length ? [barChart(c.mensuel.map(m => ({ label: m.mois.slice(5) + '/' + m.mois.slice(2, 4), values: [{ v: m.factures, title: `${m.mois} — factures : ${money(m.factures, cur)} (HT ${money(m.factures_ht, cur)})` }] })), { h: 200 }),
        el('div', { class: 'legend' }, el('span', {}, 'Avoirs de la période : ' + money(c.mensuel.reduce((s, m) => s + m.avoirs, 0), cur)))]
        : el('div', { class: 'muted' }, 'Aucune facture datée sur la période.'));
    box.append(fc, el('div', { class: 'grid2' }, agingPanel, top), monthly);
    view.appendChild(box);
  }
}

// ------------------------------------------------------------------ filtres
function filterBar(p, keys, onApply) {
  const f = {};
  const opt = (v, label, cur) => el('option', { value: v, selected: String(cur) === String(v) ? 'selected' : null }, label);
  const sel = (key, label, options) => { f[key] = el('select', {}, opt('', 'Tous'), options.map(([v, l]) => opt(v, l, p[key] || ''))); return el('label', { class: 'f' }, label, f[key]); };
  const parts = [];
  for (const k of keys) {
    if (k === 'search') { f.search = el('input', { type: 'search', placeholder: 'Référence, fournisseur, commande…', value: p.search || '' }); parts.push(el('label', { class: 'f grow' }, 'Recherche', f.search)); }
    if (k === 'company_id') parts.push(sel('company_id', 'Société facturée', S.lookups.companies.map(c => [c.id, c.name])));
    if (k === 'supplier_id') parts.push(sel('supplier_id', 'Fournisseur', S.lookups.suppliers.map(s => [s.id, s.name + (s.status === 'propose' ? ' (proposé)' : '')])));
    if (k === 'famille') parts.push(sel('famille', 'Famille', Object.entries(FAMILLES)));
    if (k === 'doc_type') parts.push(sel('doc_type', 'Type', [['facture', 'Facture'], ['avoir', 'Avoir'], ['autre', 'Autre']]));
    if (k === 'validation') parts.push(sel('validation', 'Validation', [['a_verifier', 'À vérifier'], ['validee', 'Validée'], ['rejetee', 'Rejetée']]));
    if (k === 'payment') parts.push(sel('payment', 'Paiement', [['non_payee', 'Non payée'], ['partielle', 'Partielle'], ['payee', 'Payée']]));
    if (k === 'situation') parts.push(sel('situation', 'Situation', [['a_echeance', 'À échéance'], ['en_retard', 'En retard'], ['litige', 'En litige'], ['sans_echeance', 'Sans échéance'], ['soldee', 'Soldée']]));
    if (k === 'duplicate') parts.push(sel('duplicate', 'Doublon', [['suspect', 'Potentiel'], ['confirme', 'Confirmé'], ['aucun', 'Aucun']]));
    if (k === 'from') { f.from = el('input', { type: 'date', value: p.from || '' }); parts.push(el('label', { class: 'f' }, 'Facturé du', f.from)); }
    if (k === 'to') { f.to = el('input', { type: 'date', value: p.to || '' }); parts.push(el('label', { class: 'f' }, 'au', f.to)); }
    if (k === 'due_to') { f.due_to = el('input', { type: 'date', value: p.due_to || '' }); parts.push(el('label', { class: 'f' }, 'Échéance avant le', f.due_to)); }
  }
  const apply = () => { const np = {}; for (const [k, e] of Object.entries(f)) if (e.value) np[k] = e.value; for (const k of ['anomaly', 'open', 'batch_id', 'document_id']) if (p[k]) np[k] = p[k]; onApply(np); };
  Object.values(f).forEach(e => e.addEventListener(e.tagName === 'INPUT' && e.type === 'search' ? 'keydown' : 'change', ev => { if (ev.type === 'change' || ev.key === 'Enter') apply(); }));
  const extra = [];
  if (p.anomaly) extra.push(el('span', { class: 'badge b-warn' }, 'Anomalie : ' + p.anomaly));
  if (p.open) extra.push(el('span', { class: 'badge b-info' }, 'Solde > 0'));
  if (p.batch_id) extra.push(el('span', { class: 'badge b-info' }, 'Lot #' + p.batch_id));
  return el('div', { class: 'panel' }, el('div', { class: 'row' }, parts, el('button', { onclick: apply }, 'Filtrer'),
    el('button', { onclick: () => onApply({}) }, 'Réinitialiser'), extra));
}

// ------------------------------------------------------------------ liste des factures
async function viewInvoices(view, forced, title) {
  const p = Object.assign({ page: 1, sort: 'id', dir: 'desc' }, getHashParams(), forced);
  const route = location.hash.split('?')[0];
  const go = np => { location.hash = route + '?' + new URLSearchParams(np); };
  view.appendChild(el('h1', {}, title || 'Factures'));
  if (!forced.validation) view.appendChild(filterBar(p, ['search', 'supplier_id', 'famille', 'company_id', 'doc_type', 'validation', 'payment', 'situation', 'duplicate', 'from', 'to', 'due_to'], np => go(np)));
  const data = await api('GET', '/api/invoices?' + qs(p));
  const selected = new Set();
  const exportP = Object.fromEntries(Object.entries(p).filter(([k]) => !['page', 'per_page', 'sort', 'dir', 'review'].includes(k)));
  if (S.demo) exportP.demo = '1';
  const bulkBtn = el('button', { disabled: true, onclick: async () => {
    const r = await act(() => api('POST', '/api/invoices/bulk', { ids: [...selected], action: 'validate' }));
    toast(`${r.done} facture(s) validée(s)` + (r.errors.length ? ` — ${r.errors.length} refus` : ''), !!r.errors.length && !r.done);
    if (r.errors.length) modal('Factures non validées', el('ul', { class: 'list-plain' }, r.errors.map(e => el('li', {}, e))));
    render();
  } }, 'Valider la sélection');
  const toolbar = el('div', { class: 'row', style: 'margin-bottom:8px' },
    el('div', { class: 'grow muted' }, `${data.total} document(s)`),
    canWrite() ? bulkBtn : null,
    el('button', { onclick: () => act(() => exportInvoices(exportP, 'csv')).then(n => toast(`${n} ligne(s) exportée(s)`)) }, 'Export CSV'),
    el('button', { onclick: () => act(() => exportInvoices(exportP, 'xlsx')).then(n => toast(`${n} ligne(s) exportée(s)`)) }, 'Export Excel'));
  const cols = [
    ['', null], ['N°', 'id'], ['Fournisseur', 'supplier_name'], ['Référence', 'reference'], ['Société', 'company_name'], ['Date', 'invoice_date'], ['Échéance', 'due_date'],
    ['HT', 'amount_ht', 1], ['TVA', 'amount_tva', 1], ['TTC', 'amount_ttc', 1], ['Dev.', 'currency'], ['Payé', 'paid', 1], ['Solde', 'balance', 1],
    ['Validation', 'validation_status'], ['Paiement', 'payment_status'], ['Situation', 'situation'], ['Alertes', null],
  ];
  const allBox = el('input', { type: 'checkbox', onchange: e => { view.querySelectorAll('input.rowsel').forEach(c => { c.checked = e.target.checked; c.dispatchEvent(new Event('change')); }); } });
  const head = el('tr', {}, cols.map(([label, key, num], i) => {
    if (i === 0) return el('th', {}, canWrite() ? allBox : null);
    if (!key) return el('th', {}, label);
    const arrow = p.sort === key ? (p.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return el('th', { class: 'sort' + (num ? ' num' : ''), onclick: () => go({ ...p, sort: key, dir: p.sort === key && p.dir === 'desc' ? 'asc' : 'desc', page: 1 }) }, label + arrow);
  }));
  const rows = data.rows.map(r => {
    const cb = el('input', { type: 'checkbox', class: 'rowsel', onclick: e => e.stopPropagation(), onchange: e => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); bulkBtn.disabled = !selected.size; } });
    const nb = r.anomalies.filter(a => a.niveau === 'bloquant').length, na = r.anomalies.filter(a => a.niveau === 'alerte' && !r.acknowledged.includes(a.code)).length;
    return el('tr', { class: 'click', onclick: () => { S.reviewQueue = data.rows.map(x => x.id); location.hash = '#/factures/' + r.id; } },
      el('td', {}, canWrite() ? cb : null),
      el('td', { class: 'nowrap' }, '#' + r.id, r.is_demo ? el('span', { class: 'badge b-demo', style: 'margin-left:4px' }, 'DÉMO') : null),
      el('td', {}, r.supplier_name || todo(), r.supplier_status === 'propose' ? el('div', { class: 'small muted' }, 'proposé') : null),
      el('td', { class: 'mono' }, r.reference || todo(), r.doc_type !== 'facture' ? el('div', {}, badge('doc_type', r.doc_type)) : null),
      el('td', { class: 'small' }, r.company_name || '—'),
      el('td', { class: 'nowrap' }, r.invoice_date ? d(r.invoice_date) : todo()),
      el('td', { class: 'nowrap' }, r.due_date ? d(r.due_date) : (r.doc_type === 'facture' ? todo() : '—')),
      el('td', { class: 'num' }, money(r.amount_ht)), el('td', { class: 'num' }, money(r.amount_tva)), el('td', { class: 'num' }, r.amount_ttc !== null ? money(r.amount_ttc) : todo()),
      el('td', {}, r.currency || '—'), el('td', { class: 'num' }, money(r.paid + (r.doc_type === 'facture' ? r.credited : 0))), el('td', { class: 'num' }, money(r.balance)),
      el('td', {}, badge('validation', r.validation_status)),
      el('td', {}, badge(r.doc_type === 'avoir' ? 'payment_avoir' : 'payment', r.payment_status)),
      el('td', {}, badge('situation', r.situation), r.days_late > 0 && r.situation === 'en_retard' ? el('div', { class: 'small muted' }, r.days_late + ' j') : null),
      el('td', {}, nb ? el('span', { class: 'badge b-bad' }, nb + ' bloq.') : null, na ? el('span', { class: 'badge b-warn' }, na + ' alerte' + (na > 1 ? 's' : '')) : null,
        r.duplicate_status === 'suspect' || r.duplicate_status === 'confirme' ? badge('duplicate', r.duplicate_status) : null));
  });
  const pages = Math.max(1, Math.ceil(data.total / data.per_page));
  view.appendChild(el('div', { class: 'panel' }, toolbar, el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, head), el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: cols.length, class: 'empty' }, 'Aucun document')))))),
    el('div', { class: 'pager' }, el('button', { disabled: data.page <= 1 ? true : null, onclick: () => go({ ...p, page: data.page - 1 }) }, '‹ Précédent'),
      el('span', {}, `Page ${data.page} / ${pages}`),
      el('button', { disabled: data.page >= pages ? true : null, onclick: () => go({ ...p, page: data.page + 1 }) }, 'Suivant ›'),
      el('select', { onchange: e => go({ ...p, per_page: e.target.value, page: 1 }) }, [25, 50, 100, 200].map(n => el('option', { value: n, selected: +p.per_page === n || (!p.per_page && n === 50) ? 'selected' : null }, n + ' / page')))));
}

// ------------------------------------------------------------------ file À vérifier
async function viewReview(view) {
  const p = getHashParams();
  const sub = el('div');
  view.appendChild(sub);
  await viewInvoices(sub, { validation: 'a_verifier', review: '1', per_page: p.per_page || 100, anomalies: p.anomalies || '' }, 'À vérifier');
  const intro = el('p', { class: 'muted' }, 'Documents classés par gravité : anomalies bloquantes, puis alertes, puis documents sans anomalie (validables en masse). Ouvrez un document pour le contrôler côte à côte avec la pièce ; « Suivante » enchaîne sur le document suivant de la file.');
  const tabs = el('div', { class: 'tabs' },
    [['', 'Tout'], ['1', 'Avec anomalies'], ['0', 'Sans anomalie']].map(([v, l]) => el('button', { class: (p.anomalies || '') === v ? 'on' : '', onclick: () => { location.hash = '#/a-verifier' + (v ? '?anomalies=' + v : ''); } }, l)));
  sub.insertBefore(tabs, sub.children[1]);
  sub.insertBefore(intro, tabs);
}

// ------------------------------------------------------------------ détail d'une facture
const FIELD_DEFS = [
  ['doc_type', 'Type', 'select', [['facture', 'Facture'], ['avoir', 'Avoir'], ['autre', 'Autre document']]],
  ['supplier_name_raw', 'Fournisseur (raison sociale lue)'], ['supplier_siret', 'SIRET fournisseur'], ['supplier_siren', 'SIREN fournisseur'], ['supplier_vat', 'N° TVA fournisseur'],
  ['company_id', 'Société facturée', 'company'], ['client_name_raw', 'Client (texte lu)'],
  ['reference', 'Référence'], ['invoice_date', 'Date de facture', 'date'], ['payment_terms', 'Conditions de paiement'], ['due_date', 'Échéance', 'date'],
  ['amount_ht', 'Montant HT', 'money'], ['amount_tva', 'TVA', 'money'], ['amount_ttc', 'Montant TTC', 'money'], ['currency', 'Devise'],
  ['order_ref', 'Commande / bon de livraison'], ['payment_method', 'Mode de règlement'], ['iban', 'IBAN (lu sur la facture)'], ['bic', 'BIC'],
  ['category_id', 'Catégorie', 'category'],
];

async function viewInvoice(view, id) {
  const inv = await api('GET', '/api/invoices/' + id);
  const ro = !canWrite() || inv.validation_status === 'rejetee';
  const meta = inv.fields_meta || {};
  // Navigation dans la file
  const q = S.reviewQueue || [], qi = q.indexOf(id);
  const navBtns = el('div', { class: 'row' },
    el('button', { class: 'small', onclick: () => history.back() }, '← Retour'),
    qi > 0 ? el('a', { class: 'btn small', href: '#/factures/' + q[qi - 1] }, '‹ Précédente') : null,
    qi >= 0 && qi < q.length - 1 ? el('a', { class: 'btn small', href: '#/factures/' + q[qi + 1] }, 'Suivante ›') : null);
  const title = el('div', { class: 'row', style: 'align-items:center;margin-bottom:12px' },
    el('h1', { style: 'margin:0' }, `${L.doc_type[inv.doc_type][0]} #${inv.id}`, inv.reference ? ' — ' + inv.reference : ''),
    inv.is_demo ? el('span', { class: 'badge b-demo' }, 'DÉMO') : null,
    badge('validation', inv.validation_status), badge(inv.doc_type === 'avoir' ? 'payment_avoir' : 'payment', inv.payment_status), badge('situation', inv.situation),
    inv.duplicate_status !== 'aucun' ? badge('duplicate', inv.duplicate_status) : null, el('div', { class: 'grow' }), navBtns);
  view.appendChild(title);

  // ---- visionneuse
  const viewer = el('div', { class: 'viewer panel' });
  if (inv.document) {
    const doc = inv.document;
    const total = doc.pages || 1;
    const from = inv.page_from || 1, to = inv.page_to || total;
    let showAll = false;
    const pagesBox = el('div', { class: 'pages' });
    const draw = () => {
      pagesBox.replaceChildren();
      const range = showAll ? [1, total] : [from, to];
      for (let n = range[0]; n <= range[1]; n++) {
        const inside = n >= from && n <= to;
        pagesBox.append(el('div', { class: 'pg-label' }, `Page ${n} / ${total}` + (inside ? '' : ' (autre facture du même fichier)')),
          signedImg(`apercus/${doc.sha256}/${n}.png`, 'Page ' + n, inside ? '' : 'outside'));
      }
    };
    draw();
    viewer.append(el('div', { class: 'row', style: 'margin-bottom:8px;align-items:center' },
      el('div', { class: 'grow small' }, el('strong', {}, doc.filename), el('div', { class: 'muted' },
        inv.row_index ? `Ligne ${inv.row_index} du tableau` : `Pages ${from} à ${to} sur ${total}`, ' · importé le ', d(doc.created_at),
        inv.import_item ? [' · ', el('a', { href: '#/imports/' + inv.import_item.batch_id }, 'lot #' + inv.import_item.batch_id)] : null)),
      total > 1 && (from > 1 || to < total) ? el('button', { class: 'small', onclick: e => { showAll = !showAll; e.target.textContent = showAll ? 'Pages de la facture' : 'Tout le fichier'; draw(); } }, 'Tout le fichier') : null,
      el('button', { class: 'small', onclick: () => act(() => openStored('pieces', `originaux/${doc.sha256}`, doc.filename)) }, 'Original'),
      doc.mime === 'application/pdf' && (from > 1 || to < total) ? el('button', { class: 'small', onclick: () => act(() => openStored('pieces', `extraits/${doc.sha256}_${from}-${to}.pdf`, doc.filename.replace(/\.pdf$/i, '') + `_p${from}-${to}.pdf`)) }, 'Pages de la facture (PDF)') : null),
      inv.import_item && inv.import_item.provenance !== doc.filename ? el('div', { class: 'small muted', style: 'margin-bottom:6px' }, 'Provenance : ' + inv.import_item.provenance) : null,
      inv.row_index ? el('div', { class: 'callout info small' }, 'Données lues dans un tableau : ', el('div', { class: 'mono' }, inv.text_excerpt || '')) : null,
      ['xlsx', 'xls', 'csv'].some(x => doc.filename.toLowerCase().endsWith('.' + x)) ? null : pagesBox,
      inv.siblings && inv.siblings.length ? el('div', { class: 'small', style: 'margin-top:8px' }, 'Autres enregistrements du même fichier : ',
        inv.siblings.map(s => el('a', { href: '#/factures/' + s.id, style: 'margin-right:8px' }, `#${s.id}` + (s.reference ? ` (${s.reference})` : '')))) : null);
  } else viewer.appendChild(el('div', { class: 'empty' }, 'Aucun document original (donnée de démonstration ou saisie).'));

  // ---- colonne droite
  const right = el('div');
  // Anomalies
  const ack = new Set(inv.acknowledged);
  const anPanel = el('div', { class: 'panel' }, el('h2', {}, 'Contrôles'));
  if (!inv.anomalies.length) anPanel.appendChild(el('div', { class: 'muted' }, 'Aucune anomalie détectée.'));
  inv.anomalies.forEach(a => {
    const acts = [];
    if (canWrite() && a.niveau === 'alerte' && !ack.has(a.code) && inv.validation_status === 'a_verifier')
      acts.push(el('button', { class: 'small', onclick: () => promptBox('Lever l\'alerte', a.message + ' — Expliquez pourquoi cette alerte peut être levée (obligatoire, conservé dans l\'historique).', 'Lever l\'alerte',
        v => api('POST', `/api/invoices/${id}/acknowledge`, { code: a.code, comment: v }).then(render)) }, 'Lever l\'alerte'));
    if (a.code === 'doublon_potentiel' && canWrite()) {
      acts.push(el('a', { class: 'btn small', href: '#/factures/' + inv.duplicate_of }, 'Voir #' + inv.duplicate_of));
      acts.push(el('button', { class: 'small danger', onclick: () => confirmBox('Confirmer le doublon', `La facture #${id} sera marquée « doublon confirmé » et rejetée. Elle est conservée (rien n'est supprimé) mais exclue des indicateurs.`, 'Confirmer le doublon',
        () => act(() => api('POST', `/api/invoices/${id}/duplicate`, { action: 'confirm' })).then(render)) }, 'C\'est un doublon'));
      acts.push(el('button', { class: 'small', onclick: () => act(() => api('POST', `/api/invoices/${id}/duplicate`, { action: 'dismiss' }), 'Doublon écarté').then(render) }, 'Pas un doublon'));
    }
    if (a.code === 'iban_modifie' || a.code === 'iban_non_valide') acts.push(inv.supplier_id ? el('a', { class: 'btn small', href: '#/fournisseurs/' + inv.supplier_id }, 'Fiche fournisseur') : null);
    if (a.code === 'fournisseur_propose') acts.push(el('a', { class: 'btn small', href: '#/fournisseurs/' + inv.supplier_id }, 'Valider la fiche'));
    anPanel.appendChild(el('div', { class: `anomaly ${a.niveau}` + (ack.has(a.code) ? ' acked' : '') },
      el('div', {}, el('strong', {}, a.niveau === 'bloquant' ? 'Bloquant' : a.niveau === 'alerte' ? (ack.has(a.code) ? 'Alerte levée' : 'Alerte') : 'Info'), ' — ', a.message),
      el('div', { class: 'row', style: 'flex-wrap:nowrap' }, acts)));
  });
  // Actions de statut
  if (canWrite()) {
    const sa = el('div', { class: 'row', style: 'margin-top:10px' });
    if (inv.validation_status === 'a_verifier') {
      sa.appendChild(el('button', { class: 'primary', disabled: inv.blocking.length ? true : null, title: inv.blocking.length ? 'Résolvez d\'abord les anomalies bloquantes et levez les alertes' : null,
        onclick: () => act(() => api('POST', `/api/invoices/${id}/validate`), 'Facture validée').then(() => { const n = q[qi + 1]; if (location.hash.includes('/factures/') && n) location.hash = '#/factures/' + n; else render(); }) }, 'Valider'));
      sa.appendChild(el('button', { class: 'danger', onclick: () => promptBox('Rejeter le document', 'Motif du rejet (obligatoire) :', 'Rejeter', v => api('POST', `/api/invoices/${id}/reject`, { reason: v }).then(render), { cls: 'danger' }) }, 'Rejeter'));
    } else {
      sa.appendChild(el('button', { onclick: () => promptBox('Remettre à vérifier', 'Motif :', 'Remettre à vérifier', v => api('POST', `/api/invoices/${id}/reopen`, { reason: v }).then(render)) }, 'Remettre à vérifier'));
    }
    if (inv.doc_type === 'facture' && inv.validation_status !== 'rejetee')
      sa.appendChild(inv.dispute ? el('button', { onclick: () => promptBox('Clore le litige', 'Commentaire de clôture :', 'Clore le litige', v => api('POST', `/api/invoices/${id}/dispute`, { dispute: false, reason: v }).then(render)) }, 'Clore le litige')
        : el('button', { onclick: () => promptBox('Mettre en litige', 'Motif du litige (obligatoire) :', 'Mettre en litige', v => api('POST', `/api/invoices/${id}/dispute`, { dispute: true, reason: v }).then(render)) }, 'Mettre en litige'));
    anPanel.appendChild(sa);
    if (inv.blocking.length && inv.validation_status === 'a_verifier') anPanel.appendChild(el('div', { class: 'small muted', style: 'margin-top:6px' }, 'Validation possible lorsque les anomalies bloquantes sont corrigées et les alertes levées.'));
  }
  if (inv.dispute) anPanel.appendChild(el('div', { class: 'callout bad' }, 'En litige : ' + (inv.dispute_reason || '')));
  right.appendChild(anPanel);

  // Fournisseur
  const supPanel = el('div', { class: 'panel' }, el('h2', {}, 'Fournisseur'));
  if (inv.supplier) {
    const m = meta.supplier_id || {};
    supPanel.append(el('div', { class: 'row', style: 'align-items:center' }, el('a', { href: '#/fournisseurs/' + inv.supplier.id, style: 'font-weight:600;font-size:15px' }, inv.supplier.name),
      badge('supplier', inv.supplier.status), m.regle ? el('span', { class: 'small muted' }, 'Rapprochement : ' + m.regle) : null),
      el('div', { class: 'kv', style: 'margin-top:8px' }, el('div', { class: 'k' }, 'SIREN / TVA'), el('div', {}, [inv.supplier.siren, inv.supplier.vat].filter(Boolean).join(' · ') || '—'),
        el('div', { class: 'k' }, 'IBAN validé'), el('div', { class: 'mono' }, inv.supplier.iban ? inv.supplier.iban.replace(/(.{4})/g, '$1 ') : 'Aucun IBAN validé'),
        el('div', { class: 'k' }, 'Conditions habituelles'), el('div', {}, inv.supplier.payment_terms || '—')));
  } else supPanel.appendChild(el('div', { class: 'callout' }, 'Fournisseur non rattaché.'));
  if (inv.supplier_candidates.length) supPanel.appendChild(el('div', { style: 'margin-top:8px' }, el('div', { class: 'small muted' }, 'Candidats possibles :'),
    inv.supplier_candidates.map(c => el('div', { class: 'row', style: 'align-items:center;margin-top:4px' }, el('a', { href: '#/fournisseurs/' + c.id }, c.name), el('span', { class: 'small muted' }, c.motif),
      canWrite() ? el('button', { class: 'small', onclick: () => act(() => api('POST', `/api/invoices/${id}/supplier`, { supplier_id: c.id, add_alias: true }), 'Fournisseur rattaché').then(render) }, 'Choisir') : null))));
  if (canWrite() && inv.validation_status !== 'rejetee') {
    const s = el('select', {}, el('option', { value: '' }, '— choisir une fiche —'), S.lookups.suppliers.map(x => el('option', { value: x.id }, x.name)));
    const alias = el('input', { type: 'checkbox', checked: true });
    supPanel.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, s,
      el('label', { class: 'small' }, alias, ' mémoriser le nom lu comme variante'),
      el('button', { class: 'small', onclick: () => s.value && act(() => api('POST', `/api/invoices/${id}/supplier`, { supplier_id: +s.value, add_alias: alias.checked }), 'Fournisseur modifié').then(render) }, 'Rattacher'),
      el('button', { class: 'small', onclick: () => newSupplierModal(inv) }, 'Créer une fiche')));
  }
  right.appendChild(supPanel);

  // Champs extraits
  const form = el('div', { class: 'fields' });
  const inputs = {};
  for (const [k, label, type, opts] of FIELD_DEFS) {
    const m = meta[k] || {};
    let input;
    const v = inv[k];
    if (type === 'select') input = el('select', {}, opts.map(([ov, ol]) => el('option', { value: ov, selected: v === ov ? 'selected' : null }, ol)));
    else if (type === 'company') input = el('select', {}, el('option', { value: '' }, '—'), S.lookups.companies.map(c => el('option', { value: c.id, selected: v === c.id ? 'selected' : null }, c.name)));
    else if (type === 'category') input = el('select', {}, el('option', { value: '' }, '—'), S.lookups.categories.map(c => el('option', { value: c.id, selected: v === c.id ? 'selected' : null }, c.name)));
    else if (type === 'date') input = el('input', { type: 'date', value: v || '' });
    else if (type === 'money') input = el('input', { value: moneyIn(v), inputmode: 'decimal', style: 'text-align:right' });
    else input = el('input', { value: v || '' });
    if (v === null || v === undefined || v === '') input.placeholder = 'À compléter';
    if (m.conf === 'basse' && m.src !== 'saisie') input.classList.add('conf-basse');
    if (m.conf === 'moyenne' && m.src === 'document') input.classList.add('conf-moyenne');
    if (ro) input.disabled = true;
    inputs[k] = input;
    let srcTag = null;
    if (m.src && v !== null && v !== undefined && v !== '') {
      const [lab, desc] = L.src[m.src] || [m.src, ''];
      const tip = [desc, m.conf ? 'confiance ' + m.conf : '', m.page ? 'page ' + m.page : '', m.cellule ? 'cellule ' + m.cellule : '', m.extrait ? '« ' + m.extrait + ' »' : '', m.regle ? 'règle : ' + m.regle : '',
        m.par ? `par ${m.par} le ${dt(m.le)}` : '', m.valeur_extraite !== undefined && m.valeur_extraite !== null && m.src === 'saisie' ? 'valeur extraite : ' + m.valeur_extraite : '', m.ocr ? 'lu par OCR' : '', m.ia ? 'lu par IA externe' : '', m.note || ''].filter(Boolean).join('\n');
      srcTag = el('span', { class: 'src ' + m.src, title: tip }, lab + (m.page ? ' p.' + m.page : ''));
    }
    form.append(el('div', { class: 'lab' }, label), el('div', { class: 'val' }, input, srcTag));
    if (k === 'due_date' && (inv.due_rule || (meta._flags || {}).echeance_non_calculee))
      form.append(el('div'), el('div', { class: 'small ' + (inv.due_rule ? 'muted' : 'todo') }, inv.due_rule ? 'Règle : ' + inv.due_rule : (meta._flags || {}).echeance_non_calculee));
  }
  const fieldsPanel = el('div', { class: 'panel' }, el('h2', {}, 'Données de la facture'),
    el('div', { class: 'small muted', style: 'margin-bottom:8px' }, 'Étiquettes : ', el('span', { class: 'src document' }, 'lu'), ' dans le document · ', el('span', { class: 'src calcul' }, 'calculé'), ' · ', el('span', { class: 'src saisie' }, 'saisi'),
      ' par un utilisateur. Survolez une étiquette pour voir la page, l\'extrait et la confiance. Cadre orange = lecture incertaine.',
      meta._methode ? el('div', {}, 'Méthode d\'extraction : ' + meta._methode) : null),
    form);
  if (inv.vat_breakdown && inv.vat_breakdown.length) fieldsPanel.appendChild(el('div', { style: 'margin-top:10px' }, el('h3', {}, 'TVA par taux (lue)'),
    el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Taux'), el('th', { class: 'num' }, 'Base'), el('th', { class: 'num' }, 'TVA'))),
      el('tbody', {}, inv.vat_breakdown.map(v => el('tr', {}, el('td', {}, String(v.taux).replace('.', ',') + ' %'), el('td', { class: 'num' }, money(v.base)), el('td', { class: 'num' }, money(v.tva))))))));
  if (inv.line_items && inv.line_items.length) fieldsPanel.appendChild(el('div', { style: 'margin-top:10px' }, el('h3', {}, 'Lignes de facturation'),
    el('table', {}, el('tbody', {}, inv.line_items.map(li => el('tr', {}, el('td', {}, li.designation), el('td', { class: 'num' }, li.quantite || ''), el('td', { class: 'num' }, li.prix_unitaire || ''), el('td', { class: 'num' }, li.montant_ht || '')))))));
  if (!ro) {
    fieldsPanel.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'primary', onclick: async () => {
      const body = {};
      for (const [k, , type] of FIELD_DEFS) {
        const cur = inputs[k].value;
        let orig = inv[k];
        if (type === 'money') orig = moneyIn(orig);
        if ((orig === null || orig === undefined ? '' : String(orig)) !== cur) body[k] = cur;
      }
      if (!Object.keys(body).length) return toast('Aucune modification');
      await act(() => api('PATCH', '/api/invoices/' + id, body), 'Corrections enregistrées (historisées)');
      render();
    } }, 'Enregistrer les corrections'), el('span', { class: 'small muted' }, 'Chaque correction est historisée (utilisateur, date, ancienne et nouvelle valeur).')));
  }
  right.appendChild(fieldsPanel);

  // Règlements
  right.appendChild(paymentsPanel(inv));
  // Commentaires
  const cm = el('div', { class: 'panel' }, el('h2', {}, 'Commentaires'),
    inv.comments.length ? inv.comments.map(c => el('div', { style: 'margin-bottom:8px' }, el('div', { class: 'small muted' }, `${c.user_name || 'système'} — ${dt(c.created_at)}`), el('div', {}, c.body))) : el('div', { class: 'muted' }, 'Aucun commentaire.'));
  if (canWrite()) { const t = el('textarea', { placeholder: 'Ajouter un commentaire…' }); cm.append(t, el('div', { style: 'margin-top:6px' }, el('button', { onclick: () => t.value.trim() && act(() => api('POST', `/api/invoices/${id}/comments`, { body: t.value })).then(render) }, 'Ajouter'))); }
  right.appendChild(cm);
  // Historique
  right.appendChild(el('div', { class: 'panel' }, el('h2', {}, 'Historique'), historyTable(inv.history, FIELD_LABELS_JS)));
  view.appendChild(el('div', { class: 'detail' }, viewer, right));
}
const FIELD_LABELS_JS = Object.fromEntries(FIELD_DEFS.map(f => [f[0], f[1]]).concat([['validation_status', 'Validation'], ['supplier_id', 'Fournisseur'], ['dispute', 'Litige']]));

function historyTable(rows, labels) {
  if (!rows.length) return el('div', { class: 'muted' }, 'Aucun événement.');
  return el('div', { class: 'table-wrap' }, el('table', { class: 'history' }, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Utilisateur'), el('th', {}, 'Action'), el('th', {}, 'Champ'), el('th', {}, 'Ancienne valeur'), el('th', {}, 'Nouvelle valeur'))),
    el('tbody', {}, rows.map(h => el('tr', {}, el('td', { class: 'nowrap' }, dt(h.ts)), el('td', {}, h.user_name || 'système'), el('td', {}, h.action.replace(/_/g, ' ')),
      el('td', {}, (labels && labels[h.field]) || h.field || ''), el('td', { class: 'mono' }, h.old_value ?? ''), el('td', { class: 'mono' }, h.new_value ?? ''))))));
}

function newSupplierModal(inv) {
  const name = el('input', { value: inv.supplier_name_raw || '' }), siret = el('input', { value: inv.supplier_siret || '' }), vat = el('input', { value: inv.supplier_vat || '' });
  modal('Créer une fiche fournisseur', el('div', {}, el('label', { class: 'f' }, 'Raison sociale', name), el('label', { class: 'f' }, 'SIRET', siret), el('label', { class: 'f' }, 'N° TVA', vat),
    el('p', { class: 'small muted' }, 'Les coordonnées bancaires ne sont jamais reprises automatiquement : elles se valident sur la fiche.')),
  [{ label: 'Créer et rattacher', fn: async close => { await act(() => api('POST', `/api/invoices/${inv.id}/supplier`, { create: { name: name.value, siret: siret.value, vat: vat.value } }), 'Fiche créée'); close(); render(); } }]);
}

function paymentsPanel(inv) {
  const isAvoir = inv.doc_type === 'avoir';
  const cur = inv.currency || '';
  const p = el('div', { class: 'panel' }, el('h2', {}, isAvoir ? 'Utilisation de l\'avoir' : 'Règlements'));
  p.appendChild(el('div', { class: 'kv', style: 'margin-bottom:10px' },
    el('div', { class: 'k' }, 'Montant TTC'), el('div', {}, money(inv.amount_ttc, cur)),
    el('div', { class: 'k' }, isAvoir ? 'Remboursements reçus' : 'Payé'), el('div', {}, money(inv.paid, cur)),
    el('div', { class: 'k' }, isAvoir ? 'Imputé sur factures' : 'Avoirs imputés'), el('div', {}, money(inv.credited, cur)),
    el('div', { class: 'k' }, el('strong', {}, isAvoir ? 'Crédit disponible' : 'Solde restant dû')), el('div', {}, el('strong', {}, money(inv.balance, cur)))));
  if (inv.payments.length) p.appendChild(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', { class: 'num' }, 'Montant'), el('th', {}, 'Mode'), el('th', {}, 'Référence'), el('th', {}, 'Commentaire'), el('th', {}, 'Justificatif'), el('th', {}))),
    el('tbody', {}, inv.payments.map(pm => {
      const up = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png', style: 'display:none', onchange: async e => {
        const f = e.target.files[0]; if (!f) return;
        await act(() => api('POST', `/api/payments/${pm.id}/proof`, f, { headers: { 'X-File-Name': encodeURIComponent(f.name) } }), 'Justificatif ajouté'); render(); } });
      return el('tr', {}, el('td', {}, d(pm.date)), el('td', { class: 'num' }, money(pm.amount, cur)), el('td', {}, pm.method || '—'), el('td', {}, pm.reference || '—'), el('td', { class: 'small' }, pm.comment || ''),
        el('td', {}, pm.proof_document_id ? el('a', { href: '#', onclick: e => { e.preventDefault(); act(() => openStored('justificatifs', pm.proof_path.replace(/^justificatifs\//, ''), pm.proof_name)); } }, pm.proof_name || 'fichier') : (canWrite() ? [up, el('button', { class: 'small', onclick: () => up.click() }, 'Joindre')] : '—')),
        el('td', {}, canWrite() ? el('button', { class: 'small danger', onclick: () => confirmBox('Supprimer le paiement', `Supprimer le paiement de ${money(pm.amount, cur)} du ${d(pm.date)} ? L'opération est historisée.`, 'Supprimer',
          () => act(() => api('DELETE', '/api/payments/' + pm.id), 'Paiement supprimé').then(render)) }, 'Supprimer') : null));
    }))));
  if (inv.allocations.length) p.appendChild(el('div', {}, el('h3', {}, isAvoir ? 'Imputations sur factures' : 'Avoirs imputés'),
    el('table', {}, el('tbody', {}, inv.allocations.map(a => el('tr', {}, el('td', {}, el('a', { href: '#/factures/' + a.other_id }, (isAvoir ? 'Facture #' : 'Avoir #') + a.other_id + (a.other_reference ? ' — ' + a.other_reference : ''))),
      el('td', { class: 'num' }, money(a.amount, cur)), el('td', { class: 'small muted' }, dt(a.created_at)),
      el('td', {}, canWrite() ? el('button', { class: 'small danger', onclick: () => confirmBox('Annuler l\'imputation', 'Annuler cette imputation d\'avoir ?', 'Annuler l\'imputation', () => act(() => api('DELETE', '/api/allocations/' + a.id)).then(render)) }, 'Annuler') : null)))))));
  if (!canWrite()) return p;
  if (inv.validation_status !== 'validee') { p.appendChild(el('div', { class: 'callout info' }, 'Les règlements et imputations s\'enregistrent sur une facture validée.')); return p; }
  if (!isAvoir && inv.balance > 0) {
    const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }), amount = el('input', { value: moneyIn(inv.balance), inputmode: 'decimal', style: 'width:120px;text-align:right' });
    const method = el('select', {}, ['Virement', 'Prélèvement', 'Chèque', 'LCR', 'Carte bancaire', 'Compensation', 'Autre'].map(m => el('option', { value: m }, m)));
    const ref = el('input', { placeholder: 'Référence' }), com = el('input', { placeholder: 'Commentaire' });
    p.appendChild(el('div', {}, el('h3', {}, 'Enregistrer un paiement'),
      el('div', { class: 'row' }, el('label', { class: 'f' }, 'Date', date), el('label', { class: 'f' }, 'Montant', amount), el('label', { class: 'f' }, 'Mode', method),
        el('label', { class: 'f' }, 'Référence', ref), el('label', { class: 'f grow' }, 'Commentaire', com),
        el('button', { class: 'primary', onclick: () => act(() => api('POST', `/api/invoices/${inv.id}/payments`, { date: date.value, amount: amount.value, method: method.value, reference: ref.value, comment: com.value }), 'Paiement enregistré').then(render) }, 'Enregistrer')),
      el('div', { class: 'small muted', style: 'margin-top:4px' }, 'L\'application enregistre le suivi : elle ne déclenche aucun virement.')));
    if (inv.available_credits && inv.available_credits.length) p.appendChild(el('div', { class: 'callout info', style: 'margin-top:10px' }, 'Avoirs disponibles chez ce fournisseur : ',
      inv.available_credits.map(c => el('a', { href: '#/factures/' + c.id, style: 'margin-right:10px' }, `#${c.id} ${c.reference || ''} (${money(c.balance, cur)})`)), ' — l\'imputation se fait depuis la fiche de l\'avoir.'));
  }
  if (isAvoir && inv.balance > 0) {
    if (inv.allocatable && inv.allocatable.length) {
      const target = el('select', {}, inv.allocatable.map(f => el('option', { value: f.id }, `#${f.id} ${f.reference || ''} — solde ${money(f.balance, cur)}`)));
      const amount = el('input', { value: moneyIn(Math.min(inv.balance, inv.allocatable[0].balance)), style: 'width:120px;text-align:right' });
      target.addEventListener('change', () => { const f = inv.allocatable.find(x => x.id === +target.value); amount.value = moneyIn(Math.min(inv.balance, f.balance)); });
      p.appendChild(el('div', {}, el('h3', {}, 'Imputer sur une facture'), el('div', { class: 'row' }, el('label', { class: 'f grow' }, 'Facture du même fournisseur', target), el('label', { class: 'f' }, 'Montant', amount),
        el('button', { class: 'primary', onclick: () => act(() => api('POST', `/api/invoices/${inv.id}/allocations`, { invoice_id: +target.value, amount: amount.value }), 'Avoir imputé').then(render) }, 'Imputer')),
        el('div', { class: 'small muted' }, 'Sans imputation, l\'avoir reste un crédit fournisseur : il n\'est jamais déduit deux fois.')));
    } else p.appendChild(el('div', { class: 'muted small' }, 'Aucune facture validée avec un solde ouvert chez ce fournisseur : l\'avoir reste en crédit fournisseur.'));
  }
  return p;
}

// ------------------------------------------------------------------ fournisseurs
async function viewSuppliers(view) {
  const p = getHashParams();
  const search = el('input', { type: 'search', value: p.search || '', placeholder: 'Nom, variante, SIREN, TVA…' });
  const status = el('select', {}, [['', 'Tous'], ['propose', 'Propositions à valider'], ['actif', 'Actifs']].map(([v, l]) => el('option', { value: v, selected: (p.status || '') === v ? 'selected' : null }, l)));
  const go = () => { location.hash = '#/fournisseurs?' + new URLSearchParams({ search: search.value, status: status.value }); };
  search.addEventListener('keydown', e => e.key === 'Enter' && go()); status.addEventListener('change', go);
  view.append(el('h1', {}, 'Fournisseurs'), el('div', { class: 'panel' }, el('div', { class: 'row' }, el('label', { class: 'f grow' }, 'Recherche', search), el('label', { class: 'f' }, 'Statut', status),
    el('button', { onclick: go }, 'Filtrer'), canWrite() ? el('button', { class: 'primary', onclick: createSupplierModal }, 'Nouveau fournisseur') : null)));
  const rows = await api('GET', '/api/suppliers?' + qs({ search: p.search || '', status: p.status || '' }));
  view.appendChild(el('div', { class: 'panel table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Nom', 'Variantes', 'SIREN', 'TVA', 'IBAN validé', 'Conditions', 'Factures', 'Encours', 'Statut'].map((h, i) => el('th', { class: i === 7 || i === 6 ? 'num' : '' }, h)))),
    el('tbody', {}, rows.length ? rows.map(s => el('tr', { class: 'click', onclick: () => { location.hash = '#/fournisseurs/' + s.id; } },
      el('td', {}, el('strong', {}, s.name), s.trade_name ? el('div', { class: 'small muted' }, s.trade_name) : null),
      el('td', { class: 'small' }, JSON.parse(s.aliases || '[]').join(', ')), el('td', { class: 'mono' }, s.siren || '—'), el('td', { class: 'mono' }, s.vat || '—'),
      el('td', {}, s.iban ? el('span', { class: 'badge b-ok' }, 'Oui') : el('span', { class: 'badge' }, 'Non')), el('td', { class: 'small' }, s.payment_terms || '—'),
      el('td', { class: 'num' }, s.n_invoices), el('td', { class: 'num' }, money(s.encours) + ((s.currencies || '').includes(',') ? ' *' : ' ' + (s.currencies || ''))), el('td', {}, badge('supplier', s.status))))
      : el('tr', {}, el('td', { colspan: 9, class: 'empty' }, 'Aucun fournisseur'))))),
    el('p', { class: 'small muted' }, '* encours multi-devises : voir le détail de la fiche.'));
}
function createSupplierModal() {
  const f = { name: el('input'), siret: el('input'), vat: el('input'), payment_terms: el('input', { placeholder: 'ex. 30 jours fin de mois' }) };
  modal('Nouveau fournisseur', el('div', {}, el('label', { class: 'f' }, 'Raison sociale', f.name), el('label', { class: 'f' }, 'SIRET', f.siret), el('label', { class: 'f' }, 'N° TVA', f.vat), el('label', { class: 'f' }, 'Conditions de paiement habituelles', f.payment_terms)),
    [{ label: 'Créer', fn: async close => { const r = await act(() => api('POST', '/api/suppliers', Object.fromEntries(Object.entries(f).map(([k, e]) => [k, e.value])))); close(); location.hash = '#/fournisseurs/' + r.id; } }]);
}

async function viewSupplier(view, id) {
  const s = await api('GET', '/api/suppliers/' + id);
  view.appendChild(el('div', { class: 'row', style: 'align-items:center;margin-bottom:12px' }, el('h1', { style: 'margin:0' }, s.name), badge('supplier', s.status), s.is_demo ? el('span', { class: 'badge b-demo' }, 'DÉMO') : null,
    el('div', { class: 'grow' }), el('a', { class: 'btn small', href: '#/fournisseurs' }, '← Fournisseurs')));
  if (s.status === 'fusionne') view.appendChild(el('div', { class: 'callout' }, 'Fiche fusionnée dans ', el('a', { href: '#/fournisseurs/' + s.merged_into }, 'la fiche #' + s.merged_into)));
  if (s.status === 'propose') view.appendChild(el('div', { class: 'callout' }, 'Fiche créée automatiquement à partir d\'une facture : vérifiez les informations puis validez-la. ',
    canWrite() ? el('button', { class: 'primary small', onclick: () => act(() => api('POST', `/api/suppliers/${id}/approve`), 'Fiche validée').then(render) }, 'Valider la fiche') : null));
  const ro = !canWrite();
  const fields = [['name', 'Raison sociale'], ['trade_name', 'Nom commercial'], ['famille', 'Famille'], ['siren', 'SIREN'], ['siret', 'SIRET'], ['vat', 'N° TVA'], ['address', 'Adresse'], ['email', 'E-mail'], ['phone', 'Téléphone'], ['payment_terms', 'Conditions de paiement habituelles'], ['notes', 'Notes']];
  const inputs = {};
  const form = el('div', { class: 'fields' }, fields.map(([k, l]) => {
    if (k === 'famille') inputs[k] = el('select', { disabled: ro ? true : null }, Object.entries(FAMILLES).map(([v, lab]) => el('option', { value: v, selected: (s.famille || 'autre') === v ? 'selected' : null }, lab)));
    else inputs[k] = el(k === 'notes' || k === 'address' ? 'textarea' : 'input', { value: s[k] || '', disabled: ro ? true : null });
    return [el('div', { class: 'lab' }, l), el('div', { class: 'val' }, inputs[k], k === 'famille' ? el('span', { class: 'small muted' }, 'Textile = marchandises · Charges fixes = loyers, énergie, télécom, leasing, assurances, abonnements, prestations récurrentes') : null)]; }));
  const aliases = el('textarea', { disabled: ro ? true : null }); aliases.value = s.aliases.join('\n');
  form.append(el('div', { class: 'lab' }, 'Noms alternatifs / variantes (un par ligne)'), el('div', { class: 'val' }, aliases));
  const info = el('div', { class: 'panel' }, el('h2', {}, 'Fiche'), form,
    ro ? null : el('div', { style: 'margin-top:10px' }, el('button', { class: 'primary', onclick: async () => {
      const body = {}; for (const [k] of fields) if ((k === 'famille' ? (s.famille || 'autre') : (s[k] || '')) !== inputs[k].value) body[k] = inputs[k].value;
      const al = aliases.value.split('\n').map(x => x.trim()).filter(Boolean); if (JSON.stringify(al) !== JSON.stringify(s.aliases)) body.aliases = al;
      await act(() => api('PATCH', '/api/suppliers/' + id, body), 'Fiche enregistrée'); render(); } }, 'Enregistrer')));
  // Banque
  const bank = el('div', { class: 'panel' }, el('h2', {}, 'Coordonnées bancaires validées'),
    s.iban ? el('div', { class: 'kv' }, el('div', { class: 'k' }, 'IBAN'), el('div', { class: 'mono' }, s.iban.replace(/(.{4})/g, '$1 ')), el('div', { class: 'k' }, 'BIC'), el('div', {}, s.bic || '—'),
      el('div', { class: 'k' }, 'Validé le'), el('div', {}, dt(s.iban_validated_at))) : el('div', { class: 'callout' }, 'Aucun IBAN validé. Les IBAN lus sur les factures ne sont jamais enregistrés automatiquement.'));
  if (s.ibans_lus.length) bank.appendChild(el('div', {}, el('h3', {}, 'IBAN lus sur les factures'), el('table', {}, el('tbody', {}, s.ibans_lus.map(x => el('tr', {},
    el('td', { class: 'mono' }, x.iban.replace(/(.{4})/g, '$1 ')), el('td', {}, `${x.n} facture(s), dernière le ${d(x.derniere)}`),
    el('td', {}, s.iban && s.iban === x.iban ? el('span', { class: 'badge b-ok' }, 'conforme') : el('span', { class: 'badge b-bad' }, s.iban ? 'DIFFÉRENT' : 'non validé'))))))));
  if (canWrite()) bank.appendChild(el('div', { style: 'margin-top:10px' }, el('button', { onclick: () => bankModal(s) }, s.iban ? 'Modifier l\'IBAN validé' : 'Valider un IBAN')));
  // Encours
  const enc = el('div', { class: 'panel' }, el('h2', {}, 'Encours'), s.encours.length ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Devise'), el('th', { class: 'num' }, 'Restant dû'), el('th', { class: 'num' }, 'dont retard'), el('th', { class: 'num' }, 'Crédits (avoirs)'))),
    el('tbody', {}, s.encours.map(e => el('tr', {}, el('td', {}, e.currency), el('td', { class: 'num' }, money(e.du)), el('td', { class: 'num' }, money(e.retard)), el('td', { class: 'num' }, money(e.credits)))))) : el('div', { class: 'muted' }, 'Aucune facture.'));
  // Fusion
  const merge = canWrite() && s.status !== 'fusionne' ? el('div', { class: 'panel' }, el('h2', {}, 'Fusionner cette fiche'),
    el('p', { class: 'small muted' }, 'Toutes les factures de cette fiche seront rattachées à la fiche cible ; ce nom deviendra une variante. Refusé si les SIREN diffèrent. L\'IBAN validé de cette fiche n\'est pas repris.'),
    (() => { const t = el('select', {}, el('option', { value: '' }, '— fiche cible —'), S.lookups.suppliers.filter(x => x.id !== id).map(x => el('option', { value: x.id }, x.name)));
      return el('div', { class: 'row' }, t, el('button', { class: 'danger', onclick: () => { if (!t.value) return; const tgt = S.lookups.suppliers.find(x => x.id === +t.value);
        const inp = el('input', { placeholder: 'FUSIONNER' });
        modal('Confirmer la fusion', el('div', {}, el('p', {}, `Fusionner « ${s.name} » DANS « ${tgt.name} » ? Cette opération est historisée mais ne s'annule pas automatiquement.`), el('p', {}, 'Saisissez FUSIONNER pour confirmer :'), inp),
          [{ label: 'Fusionner', cls: 'danger', fn: async close => { await act(() => api('POST', `/api/suppliers/${id}/merge`, { target_id: +t.value, confirm: inp.value }), 'Fiches fusionnées'); close(); location.hash = '#/fournisseurs/' + t.value; } }]); } }, 'Fusionner…')); })()) : null;
  view.appendChild(el('div', { class: 'grid2' }, el('div', {}, info, merge), el('div', {}, bank, enc, el('div', { class: 'panel' }, el('h2', {}, 'Historique'), historyTable(s.history)))));
  const sub = el('div');
  view.appendChild(sub);
  await viewInvoicesEmbedded(sub, { supplier_id: id }, 'Factures du fournisseur');
}
async function viewInvoicesEmbedded(view, filter, title) {
  const data = await api('GET', '/api/invoices?' + qs({ ...filter, per_page: 200, sort: 'invoice_date' }));
  view.appendChild(el('div', { class: 'panel table-wrap' }, el('h2', {}, `${title} (${data.total})`), el('table', {}, el('thead', {}, el('tr', {}, ['N°', 'Type', 'Référence', 'Date', 'Échéance', 'TTC', 'Solde', 'Validation', 'Situation'].map((h, i) => el('th', { class: i === 5 || i === 6 ? 'num' : '' }, h)))),
    el('tbody', {}, data.rows.map(r => el('tr', { class: 'click', onclick: () => { location.hash = '#/factures/' + r.id; } }, el('td', {}, '#' + r.id), el('td', {}, badge('doc_type', r.doc_type)), el('td', { class: 'mono' }, r.reference || todo()),
      el('td', {}, d(r.invoice_date)), el('td', {}, d(r.due_date)), el('td', { class: 'num' }, money(r.amount_ttc, r.currency)), el('td', { class: 'num' }, money(r.balance, r.currency)),
      el('td', {}, badge('validation', r.validation_status)), el('td', {}, badge('situation', r.situation))))))));
}
function bankModal(s) {
  const iban = el('input', { value: '', placeholder: 'FR76 …' }), bic = el('input', { value: s.bic || '' }), com = el('textarea', { placeholder: 'Ex. : confirmé par téléphone au numéro habituel le …, interlocuteur …' });
  const chk = el('input', { type: 'checkbox' });
  modal('Valider des coordonnées bancaires', el('div', {},
    el('div', { class: 'callout bad small' }, 'Fraude au changement d\'IBAN : ne validez un IBAN qu\'après confirmation par un canal connu (téléphone habituel, courrier signé), jamais sur la seule foi d\'une facture ou d\'un e-mail.'),
    el('label', { class: 'f' }, 'IBAN', iban), el('label', { class: 'f' }, 'BIC', bic), el('label', { class: 'f' }, 'Comment cet IBAN a-t-il été vérifié ? (obligatoire)', com),
    el('label', { class: 'small' }, chk, ' Je confirme avoir vérifié ces coordonnées auprès du fournisseur')),
  [{ label: 'Valider l\'IBAN', fn: async close => { await act(() => api('POST', `/api/suppliers/${s.id}/bank`, { iban: iban.value, bic: bic.value, comment: com.value, confirm: chk.checked }), 'IBAN validé'); close(); render(); } }]);
}

// ------------------------------------------------------------------ imports
// Zone de dépôt réutilisable (imports de factures, relevés bancaires) : envoi dans le stockage privé puis traitement par le poste de traitement.
function uploadPanel(o) {
  const label = el('input', { placeholder: o.placeholder || 'Libellé du lot (facultatif), ex. « Factures septembre »', value: o.label || '' });
  const fileInput = el('input', { type: 'file', multiple: true, accept: o.accept || '.pdf,.xlsx,.xls,.csv,.zip,.jpg,.jpeg,.png', style: 'display:none' });
  const list = el('div');
  const drop = el('div', { class: 'drop', onclick: () => fileInput.click() }, el('strong', {}, o.title || 'Déposez vos factures ici ou cliquez pour choisir'),
    o.hint || 'PDF (y compris scannés), Excel XLSX/XLS, CSV, images JPG/PNG — plusieurs fichiers à la fois — ou une archive ZIP complète (sous-dossiers compris, jusqu\'à 2 Go)');
  const start = async files => {
    if (!files.length) return;
    const b = await act(() => api('POST', '/api/batches', { label: label.value }));
    list.replaceChildren();
    const rows = [...files].map(f => { const bar = el('div', { style: 'width:0%' }); const st = el('span', { class: 'small muted' }, 'en attente d\'envoi');
      list.appendChild(el('div', { class: 'row', style: 'align-items:center;margin:4px 0' }, el('span', { class: 'grow' }, f.name), el('div', { class: 'progress', style: 'width:180px' }, bar), st)); return { f, bar, st }; });
    for (const r of rows) {
      try {
        const isZip = /\.zip$/i.test(r.f.name);
        if (isZip && r.f.size > 2000 * 1024 * 1024) throw new Error('archive trop volumineuse (2 Go maximum)');
        if (!isZip && r.f.size > 100 * 1024 * 1024) throw new Error('fichier trop volumineux (regroupez les gros volumes dans une archive ZIP)');
        const path = `${b.id}/${uuid()}_${safeKey(r.f.name)}`;
        await SB.upload('depots', path, r.f, x => { r.bar.style.width = (x * 100) + '%'; });
        await SB.rpc('import_register', { p_batch: b.id, p_path: path, p_filename: r.f.name, p_size: r.f.size });
        r.st.textContent = 'reçu';
      } catch (e) { r.st.textContent = 'refusé : ' + e.message; }
      r.bar.style.width = '100%';
    }
    location.hash = '#/imports/' + b.id;
  };
  fileInput.addEventListener('change', () => start(fileInput.files));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); start(e.dataTransfer.files); });
  return el('div', { class: 'panel' }, el('label', { class: 'f', style: 'margin-bottom:10px' }, 'Lot', label), drop, fileInput, list,
    el('p', { class: 'small muted' }, o.note || 'Les fichiers sont contrôlés (format réel, taille, archives piégées) puis traités en arrière-plan : une erreur sur un fichier ne bloque pas les autres. Le contenu des documents est traité comme une donnée, jamais exécuté.'));
}

async function viewImports(view) {
  view.appendChild(el('h1', {}, 'Imports'));
  const ws = workerState(S.lookups.worker_last_seen);
  view.appendChild(el('div', { class: 'callout ' + (ws.ok ? 'info' : '') }, 'Poste de traitement (lecture des factures) : ', el('span', { class: 'badge ' + ws.cls }, ws.label),
    ws.ok ? '' : ' — les fichiers déposés sont conservés et seront traités dès que le poste sera de nouveau allumé.'));
  if (canWrite() && !S.demo) view.appendChild(uploadPanel({}));
  const batches = await api('GET', '/api/batches?' + qs({}));
  view.appendChild(el('div', { class: 'panel table-wrap' }, el('h2', {}, 'Lots importés'), el('table', {}, el('thead', {}, el('tr', {}, ['Lot', 'Libellé', 'Date', 'Par', 'Progression', 'Fichiers', 'En cours', 'Erreurs', 'Doublons', 'À mapper', 'Factures'].map(h => el('th', {}, h)))),
    el('tbody', {}, batches.length ? batches.map(b => el('tr', { class: 'click', onclick: () => { location.hash = '#/imports/' + b.id; } }, el('td', {}, '#' + b.id), el('td', {}, b.label || '—'), el('td', {}, dt(b.created_at)), el('td', {}, b.user_name || '—'),
      el('td', { style: 'min-width:140px' }, el('div', { class: 'progress', title: `${b.items - b.pending} / ${b.items}` }, el('div', { style: `width:${b.items ? Math.floor((b.items - b.pending) / b.items * 100) : 0}%` })),
        el('div', { class: 'small muted' }, b.pending ? `${Math.floor((b.items - b.pending) / b.items * 100)} %` : 'terminé')),
      el('td', {}, b.items), el('td', {}, b.pending ? el('span', { class: 'badge b-info' }, b.pending) : '0'), el('td', {}, b.errors ? el('span', { class: 'badge b-bad' }, b.errors) : '0'),
      el('td', {}, b.duplicates ? el('span', { class: 'badge b-warn' }, b.duplicates) : '0'), el('td', {}, b.mapping ? el('span', { class: 'badge b-warn' }, b.mapping) : '0'), el('td', {}, b.invoices)))
      : el('tr', {}, el('td', { colspan: 11, class: 'empty' }, 'Aucun import'))))));
}

// Barre de progression d'un lot : fichiers traités, vitesse mesurée, fin estimée.
function progressBlock(lot, opts = {}) {
  const pct = lot.total ? Math.floor(lot.faits / lot.total * 100) : 0;
  const fin = lot.fin_estimee ? new Date(lot.fin_estimee) : null;
  const restMin = fin ? Math.max(1, Math.round((fin - Date.now()) / 60000)) : null;
  const dureeTxt = restMin === null ? '' : restMin < 60 ? `${restMin} min` : `${Math.floor(restMin / 60)} h ${String(restMin % 60).padStart(2, '0')}`;
  return el('div', { class: 'progress-block' },
    el('div', { class: 'row', style: 'align-items:center;gap:10px' },
      opts.title ? el('strong', {}, opts.title) : null,
      el('div', { class: 'progress grow', style: 'height:12px' }, el('div', { style: `width:${pct}%` })),
      el('strong', { class: 'nowrap' }, `${pct} %`)),
    el('div', { class: 'small muted', style: 'margin-top:4px' },
      `${lot.faits.toLocaleString('fr-FR')} / ${lot.total.toLocaleString('fr-FR')} fichier(s) traité(s)`,
      lot.restants ? ` · ${lot.restants.toLocaleString('fr-FR')} restant(s)` : ' · terminé',
      lot.vitesse_min ? ` · ${String(lot.vitesse_min).replace('.', ',')} fichiers/min` : '',
      lot.restants && fin ? ` · fin estimée vers ${fin.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} (environ ${dureeTxt})` : '',
      lot.restants && !lot.vitesse_min ? ' · en attente du poste de traitement' : '',
      lot.erreurs ? ` · ${lot.erreurs} erreur(s)` : '', lot.a_mapper ? ` · ${lot.a_mapper} tableau(x) à confirmer` : '',
      lot.doublons ? ` · ${lot.doublons} doublon(s) exact(s)` : ''));
}

async function viewBatch(view, id) {
  const container = el('div');
  view.appendChild(container);
  const draw = async () => {
    const [b, prog] = await Promise.all([api('GET', '/api/batches/' + id), api('GET', '/api/progress?' + qs({})).catch(() => ({ lots: [] }))]);
    const c = b.compteurs || {};
    const pending = (c.en_attente || 0) + (c.traitement || 0);
    const lot = (prog.lots || []).find(l => l.id === id) || { total: b.total, faits: b.total - pending, restants: pending, erreurs: c.erreur || 0,
      a_mapper: c.correspondance || 0, doublons: c.doublon || 0, vitesse_min: null, fin_estimee: null };
    const ws = workerState(b.worker_last_seen);
    container.replaceChildren(
      el('div', { class: 'row', style: 'align-items:center;margin-bottom:12px' }, el('h1', { style: 'margin:0' }, `Lot #${b.id}` + (b.label ? ' — ' + b.label : '')), el('div', { class: 'grow' }),
        el('a', { class: 'btn small', href: '#/factures?batch_id=' + id }, 'Voir les factures du lot'), el('a', { class: 'btn small', href: '#/imports' }, '← Imports')),
      el('div', { class: 'panel' }, progressBlock(lot),
        el('div', { class: 'row', style: 'margin-top:8px' }, Object.entries(c).map(([k, n]) => el('span', {}, badge('item', k), ' ', n.toLocaleString('fr-FR'))),
          el('span', { class: 'grow' }), el('span', { class: 'small' }, 'Poste de traitement : ', el('span', { class: 'badge ' + ws.cls }, ws.label)))),
      el('div', { class: 'panel table-wrap' },
        b.total > b.items.length ? el('p', { class: 'small muted' }, `${b.items.length} ligne(s) affichée(s) sur ${b.total.toLocaleString('fr-FR')} : erreurs et fichiers en cours d'abord, puis les plus récents.`) : null,
        el('table', {}, el('thead', {}, el('tr', {}, ['#', 'Fichier / provenance', 'Type', 'Taille', 'Statut', 'Résultat', 'Factures', ''].map(h => el('th', {}, h)))),
        el('tbody', {}, b.items.map(it => el('tr', {}, el('td', {}, it.id),
          el('td', {}, el('div', {}, it.filename), it.provenance !== it.filename ? el('div', { class: 'small muted' }, it.provenance) : null),
          el('td', {}, it.kind || '—'), el('td', { class: 'nowrap' }, it.size ? (it.size / 1024).toFixed(0) + ' Ko' : '—'),
          el('td', {}, badge('item', it.status), it.attempts > 1 ? el('div', { class: 'small muted' }, it.attempts + ' tentatives') : null),
          el('td', { class: 'small' }, it.message || '', it.status === 'correspondance' && it.mapping && canWrite() ? mappingEditor(it) : null),
          el('td', {}, it.invoices_created ? el('a', { href: `#/factures?document_id=${it.document_id}&batch_id=${id}` }, it.invoices_created) : (it.status === 'doublon' && it.document_id ? el('a', { href: '#/factures?document_id=' + it.document_id }, 'voir l\'original') : '—')),
          el('td', {}, canWrite() && ['erreur', 'termine'].includes(it.status) && it.kind && it.kind !== 'zip' ? el('button', { class: 'small', onclick: () => act(() => api('POST', `/api/import-items/${it.id}/retry`), 'Relance programmée').then(draw) }, 'Relancer') : null,
            canWrite() && it.status === 'erreur' && it.kind === 'zip' ? el('button', { class: 'small', onclick: () => act(() => api('POST', `/api/import-items/${it.id}/retry`)).then(draw) }, 'Relancer') : null))))),
        el('p', { class: 'small muted' }, 'La relance d\'un fichier remplace les factures issues de la tentative précédente (sans créer de doublon) tant qu\'elles n\'ont été ni validées ni réglées.')));
    return pending;
  };
  const pending = await draw();
  if (pending) currentTimer = setInterval(async () => { if (!location.hash.startsWith('#/imports/' + id)) { clearInterval(currentTimer); return; } const p = await draw().catch(() => 1); if (!p) { clearInterval(currentTimer); updateReviewCount(); } }, 5000);
}

function mappingEditor(it) {
  const m = it.mapping;
  const FIELDS = [['reference', 'Référence facture'], ['supplier_name_raw', 'Fournisseur'], ['supplier_siret', 'SIRET'], ['supplier_vat', 'N° TVA'], ['client_name_raw', 'Société facturée'],
    ['invoice_date', 'Date facture'], ['due_date', 'Échéance'], ['payment_terms', 'Conditions'], ['amount_ht', 'Montant HT'], ['amount_tva', 'TVA'], ['amount_ttc', 'Montant TTC'],
    ['currency', 'Devise'], ['order_ref', 'Commande / BL'], ['payment_method', 'Mode de règlement'], ['iban', 'IBAN'], ['doc_type', 'Type (facture/avoir)']];
  const sels = {};
  const box = el('div', { style: 'margin-top:8px' }, el('div', { class: 'small' }, `Feuille « ${m.sheet_title} », en-têtes ligne ${m.header_row + 1}. Associez les colonnes :`),
    el('div', { class: 'fields', style: 'margin-top:6px' }, FIELDS.map(([k, l]) => { sels[k] = el('select', {}, el('option', { value: '' }, '— ignorer —'), m.headers.map((h, i) => el('option', { value: i, selected: m.columns[k] === i ? 'selected' : null }, h || `Colonne ${i + 1}`))); return [el('div', { class: 'lab' }, l), el('div', { class: 'val' }, sels[k])]; })),
    el('div', { class: 'small muted', style: 'margin-top:6px' }, 'Aperçu :'),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, m.headers.map(h => el('th', {}, h)))), el('tbody', {}, m.preview.map(r => el('tr', {}, r.map(c => el('td', { class: 'small' }, c))))))),
    el('button', { class: 'primary small', style: 'margin-top:6px', onclick: () => act(() => api('POST', `/api/import-items/${it.id}/mapping`, { sheet: m.sheet, header_row: m.header_row, columns: Object.fromEntries(Object.entries(sels).map(([k, s]) => [k, s.value])) }), 'Traitement lancé').then(render) }, 'Valider la correspondance et importer'));
  return box;
}

// ------------------------------------------------------------------ paramètres
async function viewSettings(view) {
  const data = await api('GET', '/api/settings');
  const st = data.settings;
  const tab = getHashParams().tab || 'societes';
  const tabs = [['societes', 'Sociétés'], ['controles', 'Règles de contrôle'], ['ocr', 'OCR & IA'], ['categories', 'Catégories'], ['utilisateurs', 'Utilisateurs & droits'], ['sauvegardes', 'Sauvegardes'], ['demo', 'Démonstration'], ['journal', 'Journal']];
  view.append(el('h1', {}, 'Paramètres'), el('div', { class: 'tabs' }, tabs.map(([k, l]) => el('button', { class: tab === k ? 'on' : '', onclick: () => { location.hash = '#/parametres?tab=' + k; } }, l))));
  const ro = !isAdmin();
  if (ro) view.appendChild(el('div', { class: 'callout info' }, 'Consultation seule : seuls les administrateurs modifient les paramètres.'));
  const saveSettings = async body => { await act(() => api('PUT', '/api/settings', body), 'Paramètres enregistrés'); render(); };
  const p = el('div', { class: 'panel' });
  view.appendChild(p);
  if (tab === 'societes') {
    p.append(el('h2', {}, 'Sociétés facturées (vos entités)'), el('p', { class: 'small muted' }, 'Elles servent à reconnaître la société destinataire sur les factures et à exclure ses identifiants de ceux du fournisseur.'),
      el('table', {}, el('thead', {}, el('tr', {}, ['Nom', 'Variantes', 'SIREN', 'SIRET', 'TVA', ''].map(h => el('th', {}, h)))), el('tbody', {}, data.companies.map(c => el('tr', {}, el('td', {}, c.name), el('td', { class: 'small' }, JSON.parse(c.aliases).join(', ')),
        el('td', { class: 'mono' }, c.siren || ''), el('td', { class: 'mono' }, c.siret || ''), el('td', { class: 'mono' }, c.vat || ''),
        el('td', {}, ro ? null : el('button', { class: 'small danger', onclick: () => confirmBox('Supprimer la société', `Supprimer « ${c.name} » ?`, 'Supprimer', () => act(() => api('DELETE', '/api/companies/' + c.id)).then(render)) }, 'Supprimer')))))));
    if (!ro) { const f = { name: el('input'), aliases: el('input', { placeholder: 'séparées par des virgules' }), siret: el('input'), vat: el('input') };
      p.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, el('label', { class: 'f' }, 'Nom', f.name), el('label', { class: 'f' }, 'Variantes', f.aliases), el('label', { class: 'f' }, 'SIRET', f.siret), el('label', { class: 'f' }, 'TVA', f.vat),
        el('button', { class: 'primary', onclick: () => act(() => api('POST', '/api/companies', { name: f.name.value, aliases: f.aliases.value.split(','), siret: f.siret.value, vat: f.vat.value }), 'Société ajoutée').then(render) }, 'Ajouter'))); }
  }
  if (tab === 'controles') {
    const tol = el('input', { type: 'number', min: 0, value: st.amount_tolerance_cents, disabled: ro ? true : null });
    const fdm = el('select', { disabled: ro ? true : null }, [['date_plus_n_puis_fdm', 'Date + N jours, puis fin de mois (usage courant)'], ['fdm_puis_n', 'Fin de mois, puis + N jours']].map(([v, l]) => el('option', { value: v, selected: st.due_fdm_method === v ? 'selected' : null }, l)));
    const auto = el('select', { disabled: ro ? true : null }, [['0', 'Non : toute facture passe par « À vérifier »'], ['1', 'Oui : valider automatiquement les factures sans aucune anomalie']].map(([v, l]) => el('option', { value: v, selected: st.auto_validate_clean === v ? 'selected' : null }, l)));
    const lim = { max_upload_mb: el('input', { type: 'number', value: st.max_upload_mb }), zip_max_upload_mb: el('input', { type: 'number', value: st.zip_max_upload_mb, max: 2000 }), zip_max_entries: el('input', { type: 'number', value: st.zip_max_entries }), zip_max_total_mb: el('input', { type: 'number', value: st.zip_max_total_mb }), zip_max_ratio: el('input', { type: 'number', value: st.zip_max_ratio }) };
    p.append(el('h2', {}, 'Règles de contrôle'), el('div', { class: 'fields' },
      el('div', { class: 'lab' }, 'Tolérance d\'arrondi HT + TVA = TTC (centimes)'), el('div', { class: 'val' }, tol),
      el('div', { class: 'lab' }, 'Calcul « N jours fin de mois »'), el('div', { class: 'val' }, fdm),
      el('div', { class: 'lab' }, 'Validation automatique'), el('div', { class: 'val' }, auto),
      el('div', { class: 'lab' }, 'Taille max. d\'un fichier (Mo)'), el('div', { class: 'val' }, lim.max_upload_mb),
      el('div', { class: 'lab' }, 'ZIP : taille max. de l\'archive (Mo, 2000 au plus)'), el('div', { class: 'val' }, lim.zip_max_upload_mb),
      el('div', { class: 'lab' }, 'ZIP : nombre max. de fichiers'), el('div', { class: 'val' }, lim.zip_max_entries),
      el('div', { class: 'lab' }, 'ZIP : taille décompressée max. (Mo)'), el('div', { class: 'val' }, lim.zip_max_total_mb),
      el('div', { class: 'lab' }, 'ZIP : taux de compression max.'), el('div', { class: 'val' }, lim.zip_max_ratio)),
      el('p', { class: 'small muted' }, 'Les conditions ambiguës (« fin de mois le 10 », plusieurs délais, escompte…) ne donnent jamais lieu à un calcul automatique d\'échéance.'),
      ro ? null : el('button', { class: 'primary', onclick: () => saveSettings({ amount_tolerance_cents: tol.value, due_fdm_method: fdm.value, auto_validate_clean: auto.value, ...Object.fromEntries(Object.entries(lim).map(([k, e]) => [k, e.value])) }) }, 'Enregistrer'));
  }
  if (tab === 'ocr') {
    const w = workerState(st.worker_last_seen);
    const prov = el('select', { disabled: ro ? true : null }, [['auto', 'Automatique (OCR local disponible)'], ['macos_vision', 'Apple Vision (local, macOS)'], ['tesseract', 'Tesseract (local)'], ['aucun', 'Aucun OCR']].map(([v, l]) => el('option', { value: v, selected: st.ocr_provider === v ? 'selected' : null }, l)));
    const ai = el('select', { disabled: ro ? true : null }, [['aucun', 'Désactivée (aucun envoi externe)'], ['claude', 'Claude — API Anthropic (service EXTERNE)']].map(([v, l]) => el('option', { value: v, selected: st.ai_provider === v ? 'selected' : null }, l)));
    const scope = el('select', { disabled: ro ? true : null }, [['scans', 'Uniquement les documents sans texte (scans, photos)'], ['tous', 'Tous les PDF et images']].map(([v, l]) => el('option', { value: v, selected: st.ai_scope === v ? 'selected' : null }, l)));
    p.append(el('h2', {}, 'Reconnaissance de texte (OCR)'),
      el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Poste de traitement'), el('div', {}, el('span', { class: 'badge ' + w.cls }, w.label), ' ', st.worker_info || ''),
        el('div', { class: 'k' }, 'Moteurs'), el('div', {}, 'Apple Vision (local, macOS) ou Tesseract (local, si installé sur le poste de traitement)')),
      el('div', { class: 'fields', style: 'margin-top:10px' }, el('div', { class: 'lab' }, 'Moteur OCR'), el('div', { class: 'val' }, prov)),
      el('p', { class: 'small muted' }, 'L\'OCR local ne transmet aucun document à l\'extérieur.'),
      el('h2', { style: 'margin-top:20px' }, 'Extraction par IA (facultatif)'),
      el('div', { class: 'callout' }, 'Si vous activez l\'IA, les documents concernés sont ENVOYÉS à Anthropic (API Claude) pour extraction. Clé requise : ANTHROPIC_API_KEY dans le fichier .env du poste de traitement (jamais dans l\'interface). Sans clé, l\'option reste sans effet.'),
      el('div', { class: 'fields' }, el('div', { class: 'lab' }, 'Service d\'IA'), el('div', { class: 'val' }, ai), el('div', { class: 'lab' }, 'Documents concernés'), el('div', { class: 'val' }, scope)),
      ro ? null : el('button', { class: 'primary', style: 'margin-top:10px', onclick: () => {
        if (ai.value === 'claude' && st.ai_provider !== 'claude') confirmBox('Activer un service externe', 'Les documents seront transmis à Anthropic. Confirmez-vous ce choix ?', 'Activer', () => saveSettings({ ocr_provider: prov.value, ai_provider: ai.value, ai_scope: scope.value }), 'primary');
        else saveSettings({ ocr_provider: prov.value, ai_provider: ai.value, ai_scope: scope.value }); } }, 'Enregistrer'));
  }
  if (tab === 'categories') {
    p.append(el('h2', {}, 'Catégories de dépenses'), el('ul', { class: 'list-plain' }, data.categories.map(c => el('li', {}, c.name, ' ', ro ? null : el('button', { class: 'small', onclick: () => act(() => api('DELETE', '/api/categories/' + c.id)).then(render) }, '×')))));
    if (!ro) { const n = el('input'); p.appendChild(el('div', { class: 'row', style: 'margin-top:8px' }, n, el('button', { onclick: () => act(() => api('POST', '/api/categories', { name: n.value })).then(render) }, 'Ajouter'))); }
  }
  if (tab === 'utilisateurs') {
    p.append(el('h2', {}, 'Utilisateurs & droits'),
      el('div', { class: 'kv small', style: 'margin-bottom:10px' }, el('div', { class: 'k' }, 'Administrateur'), el('div', {}, 'tout, y compris paramètres, utilisateurs, sauvegardes'),
        el('div', { class: 'k' }, 'Finance'), el('div', {}, 'imports, corrections, validation, paiements, fournisseurs'), el('div', { class: 'k' }, 'Lecture seule'), el('div', {}, 'consultation et exports')));
    if (ro) { p.appendChild(el('p', { class: 'muted' }, 'Réservé aux administrateurs.')); return; }
    p.appendChild(el('table', {}, el('thead', {}, el('tr', {}, ['Nom', 'E-mail', 'Rôle', 'Actif', ''].map(h => el('th', {}, h)))), el('tbody', {}, data.users.map(u => {
      const role = el('select', { onchange: e => act(() => api('PATCH', '/api/users/' + u.user_id, { role: e.target.value }), 'Rôle modifié').then(render) }, Object.entries(L.role).map(([k, l]) => el('option', { value: k, selected: u.role === k ? 'selected' : null }, l)));
      return el('tr', {}, el('td', {}, u.name), el('td', {}, u.email), el('td', {}, role), el('td', {}, u.active ? 'oui' : 'non'),
        el('td', {}, el('button', { class: 'small', onclick: () => act(() => api('PATCH', '/api/users/' + u.user_id, { active: !u.active })).then(render) }, u.active ? 'Désactiver' : 'Réactiver'), ' ',
          el('button', { class: 'small', onclick: () => promptBox('Nouveau mot de passe', 'Nouveau mot de passe (10 caractères min.) :', 'Enregistrer', v => api('PATCH', '/api/users/' + u.user_id, { password: v }), { input: true }) }, 'Mot de passe')));
    }))));
    const f = { name: el('input'), email: el('input', { type: 'email' }), password: el('input', { type: 'password' }), role: el('select', {}, Object.entries(L.role).map(([k, l]) => el('option', { value: k, selected: k === 'finance' ? 'selected' : null }, l))) };
    p.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, el('label', { class: 'f' }, 'Nom', f.name), el('label', { class: 'f' }, 'E-mail', f.email), el('label', { class: 'f' }, 'Mot de passe', f.password), el('label', { class: 'f' }, 'Rôle', f.role),
      el('button', { class: 'primary', onclick: () => act(() => api('POST', '/api/users', Object.fromEntries(Object.entries(f).map(([k, e]) => [k, e.value]))), 'Utilisateur créé').then(render) }, 'Créer')));
  }
  if (tab === 'sauvegardes') {
    p.append(el('h2', {}, 'Sauvegardes'),
      el('div', { class: 'kv' },
        el('div', { class: 'k' }, 'Base de données'), el('div', {}, 'Sauvegarde quotidienne automatique par Supabase (offre Pro), restauration depuis le tableau de bord Supabase › Database › Backups.'),
        el('div', { class: 'k' }, 'Copie locale'), el('div', {}, 'Chaque jour, le poste de traitement exporte toutes les tables et copie les pièces (originaux, aperçus, justificatifs) dans le dossier donnees-locales/ du Mac. Dernière copie : ',
          el('strong', {}, st.last_local_backup ? dt(st.last_local_backup) : 'aucune'))),
      el('h3', {}, 'Restauration'), el('ol', { class: 'small' },
        el('li', {}, 'Base seule (erreur récente) : Supabase › Database › Backups, choisir la date.'),
        el('li', {}, 'Reconstruction complète dans un projet vide : appliquer les migrations du dossier supabase/, puis ', el('span', { class: 'mono' }, 'python3 lancer_worker.py restaurer donnees-locales/sauvegardes/<date>'), ' (renvoie aussi les pièces).'),
        el('li', {}, 'Copie immédiate : ', el('span', { class: 'mono' }, 'python3 lancer_worker.py sauvegarde'), '.')));
  }
  if (tab === 'demo') {
    p.append(el('h2', {}, 'Données de démonstration'), el('p', {}, 'Les données de démonstration sont fictives, marquées « DÉMO » et totalement séparées des données réelles : elles ne s\'affichent qu\'en mode démonstration (bouton dans le menu) et ne sont jamais utilisées pour rapprocher des factures réelles.'),
      ro ? null : el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => act(() => api('POST', '/api/admin/demo', { action: 'load' }), 'Données de démonstration chargées').then(() => { S.demo = true; try { localStorage.setItem('sf_demo', '1'); } catch (e) {} location.hash = '#/'; render(); }) }, 'Charger / régénérer la démo'),
        el('button', { class: 'danger', onclick: () => confirmBox('Supprimer la démo', 'Supprimer toutes les données de démonstration ? (les données réelles ne sont pas touchées)', 'Supprimer', () => act(() => api('POST', '/api/admin/demo', { action: 'clear' }), 'Démo supprimée').then(render)) }, 'Supprimer la démo')));
  }
  if (tab === 'journal') {
    const rows = await api('GET', '/api/audit');
    p.append(el('h2', {}, 'Journal des modifications (300 derniers événements)'), el('div', { class: 'table-wrap' }, el('table', { class: 'history' }, el('thead', {}, el('tr', {}, ['Date', 'Utilisateur', 'Objet', 'Action', 'Champ', 'Ancienne valeur', 'Nouvelle valeur'].map(h => el('th', {}, h)))),
      el('tbody', {}, rows.map(h => el('tr', {}, el('td', { class: 'nowrap' }, dt(h.ts)), el('td', {}, h.user_name || 'système'),
        el('td', {}, h.entity === 'invoice' ? el('a', { href: '#/factures/' + h.entity_id }, 'facture #' + h.entity_id) : h.entity === 'supplier' ? el('a', { href: '#/fournisseurs/' + h.entity_id }, 'fournisseur #' + h.entity_id) : `${h.entity} ${h.entity_id ? '#' + h.entity_id : ''}`),
        el('td', {}, h.action.replace(/_/g, ' ')), el('td', {}, h.field || ''), el('td', { class: 'mono' }, h.old_value ?? ''), el('td', { class: 'mono' }, h.new_value ?? '')))))));
  }
}

// ------------------------------------------------------------------ banque : relevés et rapprochement
const BANK_STATUS = { a_rapprocher: ['À rapprocher', 'b-warn'], partielle: ['Partiellement rapprochée', 'b-info'], rapprochee: ['Rapprochée', 'b-ok'],
  ignoree: ['Hors factures', ''], encaissement: ['Encaissement', ''] };
const BANK_CATEGORIES = ['Frais bancaires', 'Virement interne', 'Salaires', 'Échéance de prêt', 'Charges sociales et fiscales', 'Dépenses carte (relevé)',
  'Impayé client (prélèvement rejeté)', 'Remboursement / avance', 'Autre opération sans facture fournisseur'];
const CONF = { sure: ['sûre', 'b-ok'], probable: ['probable', 'b-info'], possible: ['possible', ''] };

// Rapprochements repris de Pennylane : propositions validées par l'utilisateur, en lot (par paquets de 50 opérations)
async function pennylanePanel(view) {
  const o = await api('GET', '/api/pennylane').catch(() => null);
  if (!o || (!o.operations && !o.appliquees && !o.bloquees)) return;
  const box = el('div', { class: 'panel pl-panel' }, el('h2', {}, 'Rapprochements repris de Pennylane'),
    el('p', {}, o.operations
      ? `${o.operations} opération(s) bancaire(s) déjà rapprochée(s) dans Pennylane avec ${o.factures} facture(s) de l'application, pour ${money(o.montant, 'EUR')}.`
      : 'Toutes les propositions Pennylane ont été traitées.'),
    el('p', { class: 'muted small' }, `Déjà appliquées : ${o.appliquees}. ` + (o.bloquees ? `${o.bloquees} opération(s) non proposée(s) (déjà rapprochée(s) ici, ou facture déjà soldée). ` : '') +
      (o.derniere_synchro ? `Dernière synchronisation : ${dt(o.derniere_synchro)}.` : '')));
  if (o.operations && o.exemples.length) box.appendChild(el('details', {}, el('summary', {}, 'Voir les plus récentes'),
    el('table', {}, el('tbody', {}, o.exemples.map(x => el('tr', {}, el('td', {}, d(x.tx_date)), el('td', { class: 'small' }, x.tx_label),
      el('td', { class: 'num' }, money(x.tx_amount, 'EUR')),
      el('td', { class: 'small' }, x.invoices.map(i => el('div', {}, el('a', { href: '#/factures/' + i.invoice_id }, `${i.supplier_name || '?'} — ${i.reference || '#' + i.invoice_id}`), ' ', money(i.amount, 'EUR'))))))))));
  if (o.operations && canWrite()) {
    const status = el('div', { class: 'muted small' });
    const btn = el('button', { class: 'primary', onclick: () => modal('Valider les rapprochements Pennylane',
      el('div', {}, el('p', {}, `Pour chacune des ${o.operations} opérations, le règlement des factures rapprochées par Pennylane sera enregistré à la date de l'opération.`),
        el('p', {}, o.dont_factures_a_verifier ? `${o.dont_factures_a_verifier} facture(s) sont encore « à vérifier » : elles seront validées en même temps. Celles qui ont une anomalie bloquante (montant manquant, doublon…) sont laissées de côté.` : ''),
        el('p', { class: 'muted small' }, 'Chaque règlement reste annulable depuis la page Banque (« Annuler le rapprochement »).')),
      [{ label: 'Valider et enregistrer les règlements', fn: async close => {
        close(); btn.disabled = true;
        let done = 0, skipped = 0, errs = [];
        for (let k = 0; k < 200; k++) {
          status.textContent = `Enregistrement en cours… ${done} opération(s) rapprochée(s)` + (skipped ? `, ${skipped} laissée(s) de côté` : '');
          const r = await act(() => api('POST', '/api/pennylane/apply', { validate: true, limit: 50 }));
          done += r.done; skipped += r.skipped; errs = errs.concat(r.errors || []);
          if (r.done + r.skipped === 0 || r.done === 0) break;
        }
        toast(`${done} opération(s) rapprochée(s)` + (skipped ? ` — ${skipped} laissée(s) de côté` : ''));
        if (errs.length) console.warn('Rapprochements Pennylane non appliqués', errs);
        render();
      } }]) }, `Valider les ${o.operations} rapprochements`);
    box.append(el('div', { class: 'row' }, btn), status);
  }
  view.appendChild(box);
}

async function viewBank(view) {
  const p = Object.assign({ status: 'a_rapprocher,partielle', sens: 'debit', page: 1 }, getHashParams());
  const go = np => { location.hash = '#/banque?' + new URLSearchParams(np); };
  const data = await api('GET', '/api/bank?' + qs({ ...p, per_page: 50 }));
  view.appendChild(el('h1', {}, 'Banque — rapprochement des règlements'));
  view.appendChild(el('p', { class: 'muted' }, 'Les débits des relevés sont comparés aux factures ouvertes (montant, fournisseur et référence dans le libellé, échéance). ',
    'Un rapprochement validé crée le règlement de la facture ; rien n\'est jamais marqué payé automatiquement. Les encaissements, virements internes, frais et prêts sont classés à part (réversible).'));
  // Comptes
  const acc = data.accounts;
  const tot = acc.filter(a => a.balance !== null).reduce((s, a) => s + a.balance, 0);
  view.appendChild(el('div', { class: 'panel table-wrap' }, el('h2', {}, `Comptes (${acc.length}) — trésorerie connue : ${money(tot, 'EUR')}`),
    acc.length ? el('table', {}, el('thead', {}, el('tr', {}, ['Banque', 'Compte', 'N°', 'Société', 'Solde', 'Au', 'Opérations', 'À rapprocher', 'Période'].map((h, i) => el('th', { class: [4, 6, 7].includes(i) ? 'num' : '' }, h)))),
      el('tbody', {}, acc.map(a => el('tr', { class: 'click', onclick: () => go({ ...p, account_id: a.id, page: 1 }) },
        el('td', {}, a.bank || '—'), el('td', {}, a.label || '—'), el('td', { class: 'mono' }, (a.account_number || '').slice(-11)), el('td', { class: 'small' }, a.company_name || '—'),
        el('td', { class: 'num' }, money(a.balance, a.currency)), el('td', {}, d(a.balance_date)), el('td', { class: 'num' }, a.n_tx),
        el('td', { class: 'num' }, a.n_open ? el('span', { class: 'badge b-warn' }, a.n_open) : '0'),
        el('td', { class: 'small' }, a.first_date ? `${d(a.first_date)} → ${d(a.last_date)}` : 'soldes seuls')))))
      : el('div', { class: 'empty' }, 'Aucun relevé importé.')));
  if (!S.demo) await pennylanePanel(view);
  if (canWrite() && !S.demo) view.appendChild(uploadPanel({ title: 'Déposez vos relevés bancaires', label: 'Relevés bancaires',
    hint: 'Exports CIC (Excel), Crédit Agricole (Excel), Société Générale (CSV)… Un relevé qui recouvre une période déjà importée n\'ajoute que les opérations nouvelles.',
    accept: '.xlsx,.xls,.csv', note: 'Les relevés sont lus par le poste de traitement comme les factures ; ils restent privés.' }));
  // Filtres
  const c = data.compteurs || {};
  const tabs = el('div', { class: 'tabs' }, [['a_rapprocher,partielle', `À rapprocher (${(c.a_rapprocher || 0) + (c.partielle || 0)})`], ['rapprochee', `Rapprochées (${c.rapprochee || 0})`],
    ['ignoree', `Hors factures (${c.ignoree || 0})`], ['encaissement', `Encaissements (${c.encaissement || 0})`], ['', 'Tout']]
    .map(([v, l]) => el('button', { class: (p.status || '') === v ? 'on' : '', onclick: () => go({ ...p, status: v, sens: v === 'encaissement' ? '' : p.sens, page: 1 }) }, l)));
  const search = el('input', { type: 'search', placeholder: 'Libellé, fournisseur, nature…', value: p.search || '' });
  const accSel = el('select', {}, el('option', { value: '' }, 'Tous les comptes'), acc.map(a => el('option', { value: a.id, selected: String(p.account_id) === String(a.id) ? 'selected' : null }, `${a.bank || ''} ${a.label || a.account_number}`)));
  const from = el('input', { type: 'date', value: p.from || '' }), to = el('input', { type: 'date', value: p.to || '' });
  const sens = el('select', {}, [['debit', 'Débits'], ['credit', 'Crédits'], ['', 'Débits et crédits']].map(([v, l]) => el('option', { value: v, selected: (p.sens || '') === v ? 'selected' : null }, l)));
  const apply = () => go({ ...p, search: search.value, account_id: accSel.value, from: from.value, to: to.value, sens: sens.value, page: 1 });
  search.addEventListener('keydown', e => e.key === 'Enter' && apply());
  [accSel, from, to, sens].forEach(x => x.addEventListener('change', apply));
  const rows = data.rows;
  const sureIds = rows.filter(r => r.suggestions[0] && r.suggestions[0].confiance === 'sure' && r.suggestions[0].type === 'facture' && r.suggestions[0].invoices[0].validation_status === 'validee').map(r => r.id);
  view.appendChild(el('div', { class: 'panel' }, tabs, el('div', { class: 'row' }, el('label', { class: 'f grow' }, 'Recherche', search), el('label', { class: 'f' }, 'Compte', accSel),
    el('label', { class: 'f' }, 'Du', from), el('label', { class: 'f' }, 'au', to), el('label', { class: 'f' }, 'Sens', sens),
    canWrite() && sureIds.length ? el('button', { class: 'primary', onclick: () => confirmBox('Valider les correspondances sûres',
      `${sureIds.length} opération(s) de cette page ont une correspondance sûre avec une facture déjà validée (montant exact + fournisseur ou référence). Créer les règlements correspondants ?`,
      'Valider', () => act(() => api('POST', '/api/bank/reconcile-sure', { ids: sureIds })).then(r => { toast(`${r.done} rapprochement(s) créé(s)`); render(); }), 'primary') }, `Valider les ${sureIds.length} correspondances sûres`) : null)));
  // Opérations
  const tbody = el('tbody', {}, rows.length ? rows.map(r => bankRow(r)) : el('tr', {}, el('td', { colspan: 6, class: 'empty' }, 'Aucune opération.')));
  const pages = Math.max(1, Math.ceil(data.total / data.per_page));
  view.appendChild(el('div', { class: 'panel table-wrap' }, el('div', { class: 'muted', style: 'margin-bottom:6px' }, `${data.total} opération(s)`),
    el('table', {}, el('thead', {}, el('tr', {}, ['Date', 'Compte', 'Libellé', 'Montant', 'Statut', 'Factures proposées / rapprochées'].map((h, i) => el('th', { class: i === 3 ? 'num' : '' }, h)))), tbody),
    el('div', { class: 'pager' }, el('button', { disabled: data.page <= 1 ? true : null, onclick: () => go({ ...p, page: data.page - 1 }) }, '‹ Précédent'),
      el('span', {}, `Page ${data.page} / ${pages}`), el('button', { disabled: data.page >= pages ? true : null, onclick: () => go({ ...p, page: data.page + 1 }) }, 'Suivant ›'))));
}

function bankRow(r) {
  const st = BANK_STATUS[r.status] || [r.status, ''];
  const right = el('td', {});
  if (r.payments.length) right.appendChild(el('div', {}, r.payments.map(pm => el('div', { class: 'small' }, '✓ ', el('a', { href: '#/factures/' + pm.invoice_id }, `${pm.supplier_name || ''} ${pm.reference || '#' + pm.invoice_id}`), ' — ', money(pm.amount)))));
  if (['a_rapprocher', 'partielle'].includes(r.status) && r.amount < 0) {
    const s = r.suggestions;
    if (s.length) {
      const best = s[0];
      const conf = CONF[best.confiance] || [best.confiance, ''];
      right.append(el('div', {}, el('span', { class: 'badge ' + conf[1] }, conf[0]), ' ', el('span', { class: 'small muted' }, best.raisons.join(' · '))),
        el('div', { class: 'small' }, best.invoices.slice(0, 6).map(i => el('div', {}, el('a', { href: '#/factures/' + i.id }, `${i.supplier_name || ''} ${i.reference || '#' + i.id}`),
          ` — ${money(i.amount)}` + (i.due_date ? ` · éch. ${d(i.due_date)}` : '') + (i.validation_status !== 'validee' ? ' · à vérifier' : ''))),
          best.invoices.length > 6 ? el('div', { class: 'muted' }, `… et ${best.invoices.length - 6} autre(s)`) : null));
      if (canWrite()) right.appendChild(el('div', { class: 'row', style: 'margin-top:4px' },
        el('button', { class: 'small primary', onclick: () => reconcileModal(r, best.invoices) }, 'Valider…'),
        s.length > 1 ? el('button', { class: 'small', onclick: () => reconcileModal(r, null, s) }, `Autres propositions (${s.length - 1})`) : null,
        el('button', { class: 'small', onclick: () => reconcileModal(r, []) }, 'Choisir'), el('button', { class: 'small', onclick: () => ignoreModal(r) }, 'Hors factures')));
    } else {
      right.appendChild(el('div', { class: 'small muted' }, 'Aucune facture correspondante trouvée.'));
      if (canWrite()) right.appendChild(el('div', { class: 'row', style: 'margin-top:4px' }, el('button', { class: 'small', onclick: () => reconcileModal(r, []) }, 'Choisir des factures'),
        el('button', { class: 'small', onclick: () => ignoreModal(r) }, 'Hors factures')));
    }
  } else if (canWrite()) {
    if (r.status === 'rapprochee' || r.status === 'partielle') right.appendChild(el('button', { class: 'small danger', onclick: () => confirmBox('Annuler le rapprochement',
      'Les règlements créés par ce rapprochement seront supprimés (opération historisée).', 'Annuler le rapprochement', () => act(() => api('POST', `/api/bank/${r.id}/unreconcile`)).then(render)) }, 'Annuler le rapprochement'));
    if (r.status === 'ignoree' || r.status === 'encaissement') right.appendChild(el('div', {}, el('span', { class: 'small muted' }, (r.category || '') + (r.auto ? ' (classement automatique)' : '')), ' ',
      el('button', { class: 'small', onclick: () => act(() => api('POST', `/api/bank/${r.id}/status`, { status: 'a_rapprocher' })).then(render) }, 'Remettre à rapprocher')));
  }
  return el('tr', {}, el('td', { class: 'nowrap' }, d(r.date)), el('td', { class: 'small' }, `${r.bank || ''} ${r.account_label || ''}`),
    el('td', { class: 'small', style: 'max-width:380px' }, r.label), el('td', { class: 'num', style: r.amount < 0 ? 'color:var(--bad)' : 'color:var(--ok)' }, money(r.amount, r.currency)),
    el('td', {}, el('span', { class: 'badge ' + st[1] }, st[0]), r.reconciled && r.status === 'partielle' ? el('div', { class: 'small muted' }, `rapproché : ${money(r.reconciled)}`) : null), right);
}

function reconcileModal(r, preset, alternatives) {
  const remaining = -r.amount - (r.reconciled || 0);
  const chosen = new Map();
  (preset || []).forEach(i => chosen.set(i.id, { ...i, amount: i.amount }));
  const body = el('div');
  const totalEl = el('strong');
  const validate = el('input', { type: 'checkbox' });
  const listEl = el('div');
  const draw = () => {
    listEl.replaceChildren(...[...chosen.values()].map(i => {
      const amt = el('input', { value: moneyIn(i.amount), style: 'width:110px;text-align:right', onchange: e => { const v = parseAmount(e.target.value); if (!Number.isNaN(v) && v > 0) { i.amount = v; drawTotal(); } } });
      return el('div', { class: 'row', style: 'align-items:center;margin:3px 0' }, el('span', { class: 'grow small' }, `${i.supplier_name || ''} ${i.reference || '#' + i.id} — solde ${money(i.balance)}` + (i.validation_status !== 'validee' ? ' (à vérifier)' : '')),
        amt, el('button', { class: 'small', onclick: () => { chosen.delete(i.id); draw(); } }, '×'));
    }));
    drawTotal();
  };
  const drawTotal = () => { const t = [...chosen.values()].reduce((s, i) => s + i.amount, 0); totalEl.textContent = `${money(t)} affectés sur ${money(remaining)}` + (t === remaining ? ' ✓' : t > remaining ? ' — dépasse le montant !' : ''); };
  const search = el('input', { type: 'search', placeholder: 'Rechercher une facture ouverte (fournisseur, référence)…' });
  const results = el('div', { class: 'small' });
  const doSearch = async () => {
    const res = await api('GET', '/api/invoices?' + qs({ search: search.value, open: '1', doc_type: 'facture', per_page: 15, sort: 'due_date', dir: 'asc' }));
    results.replaceChildren(...res.rows.filter(i => !chosen.has(i.id)).map(i => el('div', { class: 'row', style: 'align-items:center' },
      el('span', { class: 'grow' }, `${i.supplier_name || ''} ${i.reference || '#' + i.id} — solde ${money(i.balance)} · éch. ${d(i.due_date)}` + (i.validation_status !== 'validee' ? ' (à vérifier)' : '')),
      el('button', { class: 'small', onclick: () => { chosen.set(i.id, { id: i.id, reference: i.reference, supplier_name: i.supplier_name, balance: i.balance, validation_status: i.validation_status, amount: Math.min(i.balance, Math.max(0, remaining - [...chosen.values()].reduce((s, x) => s + x.amount, 0))) || i.balance }); draw(); doSearch(); } }, 'Ajouter'))));
  };
  search.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  body.append(el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Opération'), el('div', {}, `${d(r.date)} — ${r.label}`), el('div', { class: 'k' }, 'Montant à affecter'), el('div', {}, money(remaining, r.currency))));
  if (alternatives) body.appendChild(el('div', { style: 'margin-top:8px' }, el('h3', {}, 'Propositions'), alternatives.map(a => el('div', { class: 'row', style: 'align-items:center;margin:3px 0' },
    el('span', { class: 'badge ' + (CONF[a.confiance] || ['', ''])[1] }, (CONF[a.confiance] || [a.confiance])[0]),
    el('span', { class: 'grow small' }, a.invoices.map(i => `${i.reference || '#' + i.id} (${money(i.amount)})`).join(', ') + ' — ' + a.raisons.join(' · ')),
    el('button', { class: 'small', onclick: () => { chosen.clear(); a.invoices.forEach(i => chosen.set(i.id, { ...i })); draw(); } }, 'Choisir')))));
  body.append(el('h3', {}, 'Factures réglées par cette opération'), listEl, el('div', { style: 'margin:6px 0' }, totalEl),
    el('div', { class: 'row', style: 'margin-top:8px' }, search, el('button', { class: 'small', onclick: doSearch }, 'Chercher')), results,
    el('label', { class: 'small', style: 'display:block;margin-top:10px' }, validate, ' Valider aussi les factures encore « à vérifier » qui n\'ont aucune anomalie bloquante'),
    el('p', { class: 'small muted' }, 'Chaque facture reçoit un règlement daté du jour de l\'opération, avec le libellé bancaire en référence. Annulable depuis cet écran.'));
  draw();
  modal('Rapprocher l\'opération', body, [{ label: 'Créer les règlements', fn: async close => {
    const alloc = [...chosen.values()].map(i => ({ invoice_id: i.id, amount: i.amount }));
    await act(() => api('POST', `/api/bank/${r.id}/reconcile`, { alloc, validate: validate.checked }), 'Rapprochement enregistré');
    close(); render();
  } }]);
}

function ignoreModal(r) {
  const cat = el('select', {}, BANK_CATEGORIES.map(c => el('option', { value: c }, c)));
  const note = el('input', { placeholder: 'Précision (facultatif)' });
  modal('Opération sans facture fournisseur', el('div', {}, el('p', {}, `${d(r.date)} — ${r.label} — ${money(r.amount, r.currency)}`),
    el('label', { class: 'f' }, 'Nature', cat), el('label', { class: 'f' }, 'Note', note)),
    [{ label: 'Classer hors factures', fn: async close => { await act(() => api('POST', `/api/bank/${r.id}/status`, { status: 'ignoree', category: cat.value, note: note.value })); close(); render(); } }]);
}

// ------------------------------------------------------------------ suivi des encaissements web
// 3 niveaux : commande Shopify → transaction chez le prestataire → versement du prestataire → opération bancaire.
L.psp_etat = { recu: ['Reçu', 'b-ok'], en_transit: ['En transit', 'b-info'], en_retard: ['En retard', 'b-bad'], ecart: ['Écart', 'b-bad'],
  releve_manquant: ['Relevé à importer', 'b-warn'], negatif: ['Règlement négatif', 'b-warn'], echec: ['Échec', 'b-bad'] };
L.psp_todo = { commande_introuvable: ['Commande introuvable chez le prestataire', 'b-bad'], ecart_montant: ['Écart de montant', 'b-warn'],
  versement_retard: ['Versement non arrivé', 'b-bad'], ecart_versement: ['Écart de versement', 'b-bad'], litige: ['Litige / chargeback', 'b-warn'],
  versement_negatif: ['Règlement négatif', 'b-warn'], credit_non_rattache: ['Crédit bancaire non rattaché', 'b-info'],
  tiktok_sans_correspondance: ['Commandes TikTok sans n° TikTok', 'b-info'] };
const PSP_KIND = { sale: 'Vente', capture: 'Capture', refund: 'Remboursement', charge: 'Paiement', chargeback: 'Chargeback', chargeback_hold: 'Fonds retenus (litige)',
  chargeback_hold_release: 'Fonds libérés', adjustment: 'Ajustement', fee: 'Frais' };
const PSP_STATUS = { paid: 'payé', in_transit: 'en transit', scheduled: 'programmé', pending: 'en attente', failed: 'échec' };
const PSP_LINK = { reference: 'par référence', montant_date: 'montant + date', manuel: 'manuel' };
const PSP_ACK = { cmd: 'Commande introuvable', ecart: 'Écart de montant', payout: 'Versement', litige: 'Litige', bank: 'Crédit bancaire', tiktok_sans_ref: 'Commandes TikTok sans n°' };
const monthLabel = m => { const [y, mo] = m.split('-'); const s = new Date(+y, +mo - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }); return s.charAt(0).toUpperCase() + s.slice(1); };
const pct = (a, b) => b ? (a / b * 100).toFixed(2).replace('.', ',') + ' %' : '—';

async function viewEncaissements(view) {
  const p = Object.assign({ tab: 'a-traiter', page: 1 }, getHashParams());
  const go = np => { location.hash = '#/encaissements?' + new URLSearchParams(Object.fromEntries(Object.entries(np).filter(([, v]) => v !== '' && v !== null && v !== undefined))); };
  const ov = await api('GET', '/api/psp/overview?' + qs({ month: p.month || '' }));
  const month = ov.month;
  view.append(el('h1', {}, 'Suivi des encaissements web'),
    el('p', { class: 'muted' }, 'CA web par moyen d\'encaissement et contrôle des versements des prestataires, en trois niveaux : chaque commande Shopify doit se retrouver chez le prestataire, ',
      'chaque transaction dans un versement, chaque versement sur un relevé bancaire. Le rattachement à la banque ne modifie pas l\'écran Banque.'));
  // Barre : mois, recherche de commande, rapprochement
  const monthSel = el('select', {}, ov.months.map(m => el('option', { value: m, selected: m === month ? 'selected' : null }, monthLabel(m))));
  monthSel.addEventListener('change', () => go({ ...p, month: monthSel.value, page: 1 }));
  const search = el('input', { type: 'search', placeholder: 'W-712345, n° de commande TikTok…', value: p.order || '' });
  const doSearch = () => go({ ...p, order: search.value.trim() });
  search.addEventListener('keydown', e => e.key === 'Enter' && doSearch());
  view.appendChild(el('div', { class: 'panel' }, el('div', { class: 'row' },
    el('label', { class: 'f' }, 'Mois', monthSel), el('label', { class: 'f grow' }, 'Rechercher une commande', search), el('button', { onclick: doSearch }, 'Afficher le parcours'),
    canWrite() ? el('button', { onclick: () => act(() => api('POST', '/api/psp/match?' + qs({}))).then(r => {
      toast(`Rapprochement : ${r.transactions_rattachees} transaction(s) rattachée(s), ${r.banque_par_reference + r.banque_par_montant} versement(s) retrouvé(s) en banque`); render(); }) }, 'Relancer le rapprochement') : null),
    el('div', { class: 'small muted', style: 'margin-top:6px' }, ov.bank_last_date ? `Relevés bancaires importés jusqu'au ${d(ov.bank_last_date)}.` : 'Aucun relevé bancaire importé : les versements ne peuvent pas encore être contrôlés.')));
  if (p.order) view.appendChild(await pspTracePanel(p.order, () => go({ ...p, order: '' })));
  view.appendChild(pspCards(ov, p, go));
  // Onglets
  const nTodo = ov.providers.reduce((s, x) => s + x.n_anomalies, 0);
  const nPay = ov.providers.reduce((s, x) => s + x.n_versements, 0);
  const tabs = [['a-traiter', `À traiter (${nTodo})`], ['versements', `Versements (${nPay})`], ['ventes-jour', 'Ventes par jour'], ['previsionnel', 'Prévisionnel'], ['parametres', 'Paramètres']];
  if (canWrite() && !S.demo) tabs.push(['deposer', 'Déposer des exports']);
  const body = el('div');
  view.appendChild(el('div', { class: 'panel' }, el('div', { class: 'tabs' }, tabs.map(([k, l]) => el('button', { class: p.tab === k ? 'on' : '', onclick: () => go({ ...p, tab: k, page: 1, etat: '', kind: '' }) }, l))), body));
  if (p.tab === 'versements') await pspPayoutsTab(body, p, go, ov);
  else if (p.tab === 'ventes-jour') await pspSalesByDayTab(body, p, go);
  else if (p.tab === 'previsionnel') await pspForecastTab(body, p, go);
  else if (p.tab === 'parametres') await pspSettingsTab(body, ov);
  else if (p.tab === 'deposer') body.appendChild(uploadPanel({ title: 'Déposez les exports des prestataires', label: 'Exports encaissements web', accept: '.csv,.xlsx',
    hint: 'Shopify : transactions des commandes, versements et transactions Shopify Payments, export Commandes (n° TikTok) — JUST (CSV) — TikTok Shop (income .xlsx) — PayPlug (rapport comptable CSV), Alma (export comptable CSV), PayPal (historique « Impact sur le solde » CSV) — Global-e (avis de paiement PDF « Remittance Advice » et rapports hebdomadaires « ReconciliationReport … Euro.xlsx »). Reconnus automatiquement ; un export qui recouvre une période déjà chargée n\'ajoute que les nouveautés.',
    note: 'Seules les colonnes utiles au rapprochement sont lues (jamais les noms ni e-mails des clients). Les fichiers sont traités par le poste de traitement comme les relevés bancaires.' }));
  else await pspTodoTab(body, p, go, ov);
}

function pspCards(ov, p, go) {
  const tracked = ov.providers.filter(x => x.tracked);
  const others = ov.providers.filter(x => !x.tracked && x.ca_brut);
  const tot = tracked.reduce((a, x) => ({ ca: a.ca + x.ca_brut, n: a.n + x.n_commandes, f: a.f + x.frais, v: a.v + x.verse, w: a.w + x.en_attente }), { ca: 0, n: 0, f: 0, v: 0, w: 0 });
  const allCa = ov.providers.reduce((s, x) => s + x.ca_brut, 0);
  const hasData = x => { const c = x.couverture || {}; return !!((c.transactions || {}).du || (c.versements || {}).du); };
  const cov = x => { const c = x.couverture || {}; const r = (c.transactions || {}).du ? c.transactions : (c.versements || {}); return r.du ? `exports du ${d(r.du)} au ${d(r.au)}` : 'aucun export prestataire'; };
  const card = x => el('div', { class: 'kpi psp-card' + (x.n_anomalies ? ' has-pb' : '') },
    el('div', { class: 'psp-head' }, el('strong', {}, x.label),
      x.n_anomalies ? el('a', { href: '#', class: 'badge b-bad', onclick: e => { e.preventDefault(); go({ ...p, tab: 'a-traiter', provider: x.code, kind: '' }); } }, `${x.n_anomalies} à traiter`)
        : (!hasData(x) ? (x.n_commandes ? el('span', { class: 'badge b-warn' }, 'Aucun export') : null)
          : el('span', { class: 'badge b-ok' }, 'RAS'))),
    el('div', { class: 'v' }, money(x.ca_brut, 'EUR')),
    el('div', { class: 's' }, `${x.n_commandes} commande(s)` + (x.remboursements ? ` · remboursé ${money(x.remboursements)}` : '')),
    el('dl', { class: 'psp-lines' },
      el('dt', {}, 'Frais'), el('dd', {}, x.frais ? `${money(x.frais)} (${pct(x.frais, x.ca_brut)})` : '—'),
      el('dt', {}, 'Versé'), el('dd', {}, money(x.verse) + (x.n_versements ? ` · ${x.n_versements} vers.` : '')),
      el('dt', {}, 'Reçu en banque'), el('dd', { class: x.verse && x.recu_banque < x.verse ? 'warn' : '' }, money(x.recu_banque) + (x.n_versements ? ` · ${x.n_recus}/${x.n_versements}` : '')),
      el('dt', {}, 'En attente'), el('dd', {}, money(x.en_attente))),
    el('div', { class: 'small muted' }, cov(x)));
  return el('div', {},
    el('div', { class: 'row', style: 'align-items:baseline;margin-bottom:8px' }, el('h2', { style: 'margin:0' }, monthLabel(ov.month)),
      el('span', { class: 'muted' }, `CA web ${money(allCa, 'EUR')} · prestataires suivis ${money(tot.ca, 'EUR')} (${tot.n} commandes) · frais ${money(tot.f)} (${pct(tot.f, tot.ca)}) · versé ${money(tot.v)} · en attente ${money(tot.w)}`)),
    el('div', { class: 'psp-cards' }, tracked.map(card)),
    others.length ? el('div', { class: 'small muted', style: 'margin:-6px 0 16px' }, 'Sans versement suivi : ', others.map(x => `${x.label} ${money(x.ca_brut, 'EUR')} (${x.n_commandes} cmd)`).join(' · ')) : null);
}

function pspProviderSelect(ov, value, onChange) {
  const s = el('select', {}, el('option', { value: '' }, 'Tous les prestataires'), ov.providers.filter(x => x.tracked).map(x => el('option', { value: x.code, selected: x.code === value ? 'selected' : null }, x.label)));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

async function pspTodoTab(body, p, go, ov) {
  const data = await api('GET', '/api/psp/todo?' + qs({ month: ov.month, provider: p.provider || '', kind: p.kind || '', limit: 300 }));
  const c = data.compteurs || {};
  const chips = el('div', { class: 'row', style: 'gap:6px;margin-bottom:10px' },
    el('button', { class: 'small' + (!p.kind ? ' primary' : ''), onclick: () => go({ ...p, kind: '' }) }, `Tout (${Object.values(c).reduce((s, n) => s + n, 0)})`),
    Object.keys(L.psp_todo).filter(k => c[k]).map(k => el('button', { class: 'small' + (p.kind === k ? ' primary' : ''), onclick: () => go({ ...p, kind: k }) }, `${L.psp_todo[k][0]} (${c[k]})`)));
  body.append(el('div', { class: 'row', style: 'margin-bottom:10px' }, el('label', { class: 'f' }, 'Prestataire', pspProviderSelect(ov, p.provider, v => go({ ...p, provider: v })))), chips);
  if (!data.rows.length) { body.appendChild(el('div', { class: 'empty' }, 'Rien à traiter pour ce mois.')); }
  else {
    body.appendChild(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Point', 'Prestataire', 'Date', 'Commande / réf.', 'Montant', 'Détail', ''].map((h, i) => el('th', { class: i === 4 ? 'num' : '' }, h)))),
      el('tbody', {}, data.rows.map(r => el('tr', {},
        el('td', {}, badge('psp_todo', r.kind)), el('td', { class: 'small' }, r.provider_label), el('td', { class: 'nowrap' }, d(r.day)),
        el('td', { class: 'mono' }, r.order_name ? el('a', { href: '#', onclick: e => { e.preventDefault(); go({ ...p, order: r.order_name }); } }, r.order_name) : (r.ref || '—')),
        el('td', { class: 'num' }, money(r.amount)), el('td', { class: 'small', style: 'max-width:420px' }, r.message),
        el('td', { class: 'nowrap' },
          canWrite() && r.payout_id && r.kind === 'versement_retard' ? el('button', { class: 'small', onclick: () => pspLinkModal({ id: r.payout_id, provider_label: r.provider_label, payout_date: r.day, amount: r.amount }) }, 'Rattacher…') : null,
          canWrite() ? el('button', { class: 'small', onclick: () => promptBox('Lever ce point', `${L.psp_todo[r.kind][0]} — ${r.order_name || r.ref || ''} ${money(r.amount)}. Expliquez pourquoi ce point est réglé (obligatoire, historisé).`,
            'Lever le point', comment => api('POST', '/api/psp/ack?' + qs({}), { key: r.key, comment }).then(render)) }, 'Lever…') : null)))))));
    if (data.total > data.rows.length) body.appendChild(el('div', { class: 'small muted', style: 'margin-top:6px' }, `${data.rows.length} premiers points affichés sur ${data.total}. Filtrez par prestataire ou par type.`));
  }
  const acks = await api('GET', '/api/psp/acks?' + qs({})).catch(() => []);
  if (acks.length) body.appendChild(el('details', { style: 'margin-top:14px' }, el('summary', { class: 'small muted' }, `Points levés (${acks.length})`),
    el('table', {}, el('tbody', {}, acks.slice(0, 200).map(a => el('tr', {}, el('td', { class: 'small' }, PSP_ACK[a.kind] || a.kind), el('td', { class: 'mono' }, a.key.split(':').slice(1).join(' · ')),
      el('td', { class: 'small' }, a.comment), el('td', { class: 'small muted' }, `${a.user_name || 'système'} — ${dt(a.created_at)}`),
      el('td', {}, canWrite() ? el('button', { class: 'small', onclick: () => act(() => api('POST', '/api/psp/unack?' + qs({}), { key: a.key })).then(render) }, 'Rétablir') : null)))))));
}

async function pspPayoutsTab(body, p, go, ov) {
  const data = await api('GET', '/api/psp/payouts?' + qs({ month: ov.month, provider: p.provider || '', etat: p.etat || '', page: p.page || 1, per_page: 50 }));
  const c = data.compteurs || {};
  body.append(el('div', { class: 'row', style: 'margin-bottom:10px' }, el('label', { class: 'f' }, 'Prestataire', pspProviderSelect(ov, p.provider, v => go({ ...p, provider: v, page: 1 })))),
    el('div', { class: 'row', style: 'gap:6px;margin-bottom:10px' },
      el('button', { class: 'small' + (!p.etat ? ' primary' : ''), onclick: () => go({ ...p, etat: '', page: 1 }) }, `Tous (${Object.values(c).reduce((s, n) => s + n, 0)})`),
      Object.keys(L.psp_etat).filter(k => c[k]).map(k => el('button', { class: 'small' + (p.etat === k ? ' primary' : ''), onclick: () => go({ ...p, etat: k, page: 1 }) }, `${L.psp_etat[k][0]} (${c[k]})`))));
  if (!data.rows.length) { body.appendChild(el('div', { class: 'empty' }, 'Aucun versement ce mois-ci.')); return; }
  body.appendChild(el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ['Date', 'Prestataire', 'Référence', 'Statut prestataire', 'Montant', 'Frais', 'Transactions', 'Banque', 'État', ''].map((h, i) => el('th', { class: [4, 5].includes(i) ? 'num' : '' }, h)))),
    el('tbody', {}, data.rows.map(r => el('tr', {},
      el('td', { class: 'nowrap' }, d(r.payout_date)), el('td', { class: 'small' }, r.provider_label),
      el('td', { class: 'mono' }, r.bank_ref || r.ext_id || '—'), el('td', { class: 'small' }, PSP_STATUS[r.status] || r.status),
      el('td', { class: 'num' }, money(r.amount)), el('td', { class: 'num' }, r.fees === null ? '—' : money(r.fees)),
      el('td', { class: 'small' }, r.n_tx ? `${r.n_tx} · ${money(r.sum_tx)}` : '—'),
      el('td', { class: 'small', style: 'max-width:300px' }, r.bank_transaction_id ? [el('div', {}, `${d(r.bank_date)} — ${money(r.bank_amount)}`), el('div', { class: 'muted' }, r.bank_label), el('div', { class: 'muted' }, PSP_LINK[r.link_mode] || r.link_mode)]
        : el('span', { class: 'muted' }, `attendu au plus tard le ${d(r.expected_by)}`)),
      el('td', {}, badge('psp_etat', r.etat)),
      el('td', { class: 'nowrap' }, !canWrite() || r.amount <= 0 ? null : r.bank_transaction_id
        ? el('button', { class: 'small', onclick: () => confirmBox('Détacher de l\'opération bancaire', 'Le lien sera supprimé (historisé). Un lien automatique détaché ne sera plus proposé.', 'Détacher',
            () => act(() => api('POST', `/api/psp/payouts/${r.id}/unlink`, {})).then(render)) }, 'Détacher')
        : el('button', { class: 'small', onclick: () => pspLinkModal(r) }, 'Rattacher…'))))))));
  const pages = Math.max(1, Math.ceil(data.total / data.per_page));
  body.appendChild(el('div', { class: 'pager' }, el('button', { disabled: data.page <= 1 ? true : null, onclick: () => go({ ...p, page: data.page - 1 }) }, '‹ Précédent'),
    el('span', {}, `Page ${data.page} / ${pages} — ${data.total} versement(s)`), el('button', { disabled: data.page >= pages ? true : null, onclick: () => go({ ...p, page: data.page + 1 }) }, 'Suivant ›')));
}

async function pspLinkModal(r) {
  const cands = await act(() => api('GET', `/api/psp/payouts/${r.id}/candidates`));
  const comment = el('input', { placeholder: 'Commentaire (facultatif)' });
  let close = null;
  const list = cands.length ? el('table', {}, el('tbody', {}, cands.map(c => el('tr', {},
    el('td', { class: 'nowrap' }, d(c.date)), el('td', { class: 'small' }, c.label, c.deja_rattache ? el('div', { class: 'muted' }, `déjà rattaché : ${money(c.deja_rattache)}`) : null),
    el('td', { class: 'num' }, money(c.amount), c.meme_montant ? el('div', {}, el('span', { class: 'badge b-ok' }, 'même montant')) : null),
    el('td', {}, el('button', { class: 'small primary', onclick: async () => {
      await act(() => api('POST', `/api/psp/payouts/${r.id}/link`, { bank_transaction_id: c.id, comment: comment.value }), 'Versement rattaché');
      close(); render(); } }, 'Rattacher'))))))
    : el('div', { class: 'empty' }, 'Aucun crédit bancaire proche (date ou montant) n\'est disponible. Importez le relevé de la période.');
  close = modal('Rattacher le versement à une opération bancaire', el('div', {},
    el('p', {}, `${r.provider_label} — versement du ${d(r.payout_date)} : ${money(r.amount, 'EUR')}`),
    el('p', { class: 'small muted' }, 'Crédits bancaires du J−5 au J+20, de même montant (à 5 % près) ou au libellé du prestataire. L\'opération bancaire elle-même n\'est pas modifiée.'),
    list, el('label', { class: 'f', style: 'margin-top:10px' }, 'Commentaire', comment)), []);
}

async function pspSettingsTab(body, ov) {
  const admin = isAdmin();
  body.append(el('p', { class: 'small muted' }, 'Délai de versement : nombre de jours tolérés entre la date annoncée par le prestataire et l\'arrivée en banque, au-delà duquel le versement est signalé en retard. ',
    'Délai commande : âge minimal d\'une commande avant de la signaler introuvable chez le prestataire. Fenêtre banque : rapprochement par montant entre J et J + n. ',
    'Motif : texte (expression régulière) cherché dans le libellé bancaire, en majuscules sans accents.'));
  body.appendChild(el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ['Prestataire', 'Délai versement (j)', 'Délai commande (j)', 'Fenêtre banque (j)', 'Motif du libellé', 'Exclure', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, ov.providers.filter(x => x.tracked).map(x => {
      const f = {};
      const inp = (k, w) => (f[k] = el('input', { value: x[k] === null || x[k] === undefined ? '' : x[k], style: `width:${w}px`, disabled: admin ? null : true }));
      return el('tr', {}, el('td', {}, x.label), el('td', {}, inp('payout_delay_days', 60)), el('td', {}, inp('order_delay_days', 60)), el('td', {}, inp('bank_window_days', 60)),
        el('td', {}, inp('bank_pattern', 160)), el('td', {}, inp('bank_exclude', 110)),
        el('td', {}, admin ? el('button', { class: 'small', onclick: () => {
          const ch = {};
          for (const [k, i] of Object.entries(f)) if (String(i.value) !== String(x[k] === null || x[k] === undefined ? '' : x[k])) ch[k] = i.value;
          if (!Object.keys(ch).length) return toast('Aucune modification');
          act(() => api('POST', `/api/psp/providers/${x.code}`, ch), 'Paramètres enregistrés').then(render);
        } }, 'Enregistrer') : null));
    })))));
  if (!admin) body.appendChild(el('p', { class: 'small muted' }, 'Seuls les administrateurs modifient ces paramètres.'));
  await pspForecastRulesSettings(body);
}

async function pspTracePanel(order, onClose) {
  const panel = el('div', { class: 'panel' });
  let t;
  try { t = await api('GET', '/api/psp/order?' + qs({ order })); }
  catch (e) { panel.append(el('div', { class: 'callout bad' }, e.message), el('button', { class: 'small', onclick: onClose }, 'Fermer')); return panel; }
  const empty = !t.shopify.length && !t.transactions.length;
  const ok = (cond, txt) => el('span', { class: 'badge ' + (cond ? 'b-ok' : 'b-bad') }, txt);
  const tracked = t.shopify.some(s => s.tracked);
  const col = (title, status, content) => el('div', { class: 'psp-step' }, el('div', { class: 'psp-step-h' }, el('strong', {}, title), status), content);
  panel.append(el('div', { class: 'row', style: 'align-items:center;margin-bottom:10px' }, el('h2', { style: 'margin:0' }, `Commande ${t.order_name}`),
    t.refs.length ? el('span', { class: 'small muted' }, 'n° TikTok ' + t.refs.map(r => r.ext_order_id).join(', ')) : null, el('div', { class: 'grow' }),
    el('button', { class: 'small', onclick: onClose }, 'Fermer')));
  if (empty) { panel.appendChild(el('div', { class: 'empty' }, 'Aucune donnée importée pour cette commande (vérifiez le n° ou importez les exports de la période).')); return panel; }
  panel.appendChild(el('div', { class: 'psp-steps' },
    col('1. Shopify', ok(t.shopify.length, t.shopify.length ? 'payée' : 'absente'), t.shopify.length ? el('table', {}, el('tbody', {}, t.shopify.map(s => el('tr', {},
      el('td', { class: 'small nowrap' }, dt(s.tx_at)), el('td', { class: 'small' }, `${PSP_KIND[s.kind] || s.kind} · ${s.provider_label}`), el('td', { class: 'num' }, money(s.amount))))))
      : el('div', { class: 'small muted' }, 'Commande absente de l\'export Shopify importé.')),
    col('2. Prestataire', tracked || t.transactions.length ? ok(t.transactions.length, t.transactions.length ? 'retrouvée' : 'introuvable') : el('span', { class: 'badge' }, 'non suivi'),
      t.transactions.length ? el('table', {}, el('tbody', {}, t.transactions.map(x => el('tr', {},
        el('td', { class: 'small nowrap' }, d(x.tx_at)), el('td', { class: 'small' }, `${PSP_KIND[x.kind] || x.kind} · ${x.provider_label}`),
        el('td', { class: 'num' }, money(x.gross), x.fee ? el('div', { class: 'small muted' }, `frais ${money(x.fee)} · net ${money(x.net)}`) : null)))))
        : el('div', { class: 'small muted' }, tracked ? 'Aucune transaction chez le prestataire dans les exports importés.' : 'Moyen d\'encaissement sans versement suivi.')),
    col('3. Versement → banque', t.payouts.length ? (t.payouts.every(v => v.etat === 'recu') ? ok(true, 'reçu') : badge('psp_etat', t.payouts[0].etat)) : el('span', { class: 'badge' }, '—'),
      t.payouts.length ? el('div', {}, t.payouts.map(v => el('div', { class: 'small', style: 'margin-bottom:6px' },
        el('div', {}, `${v.provider_label} — versement du ${d(v.payout_date)} : ${money(v.amount)} `, badge('psp_etat', v.etat)),
        v.bank_transaction_id ? el('div', { class: 'muted' }, `Banque ${d(v.bank_date)} — ${money(v.bank_amount)} — ${v.bank_label}`) : el('div', { class: 'muted' }, `Pas encore sur les relevés (attendu au plus tard le ${d(v.expected_by)})`))))
        : el('div', { class: 'small muted' }, t.transactions.some(x => x.payout_date) ? `Versement prévu le ${d(t.transactions.find(x => x.payout_date).payout_date)}` : 'Pas encore de versement.'))));
  if (t.anomalies.length) panel.appendChild(el('div', { style: 'margin-top:8px' }, t.anomalies.map(a => el('div', { class: 'anomaly alerte' }, el('div', {}, el('strong', {}, (L.psp_todo[a.kind] || [a.kind])[0]), ' — ', a.message)))));
  return panel;
}

// ------------------------------------------------------------------ encaissements web : prévisionnel des arrivées en banque
const FC_DOW = ['', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
const FC_DOW_LONG = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const FC_QUALITY = { mesure: null, estimation: ['estimation', 'b-info'], hypothese: ['hypothèse à confirmer', 'b-warn'] };
const FC_SYNC = { ok: ['à jour', 'b-ok'], partiel: ['partielle (reprise au prochain passage)', 'b-warn'], erreur: ['en erreur', 'b-bad'] };
const fcShift = (iso, n) => { const x = new Date(iso + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const fcShort = iso => { const [, m, dd] = String(iso).split('-'); return `${dd}/${m}`; };
// Écart reçu − prévu : vert si proche (5 % ou 50 €), sinon orange (reçu en plus) ou rouge (reçu en moins).
function fcEcartClass(ecart, prevu) {
  if (ecart === null || ecart === undefined) return '';
  return Math.abs(ecart) <= Math.max(5000, Math.abs(prevu) * 0.05) ? 'fc-ok' : (ecart < 0 ? 'fc-bad' : 'fc-warn');
}
function fcSyncLine(sync) {
  const s = (sync || []).find(x => x.source === 'shopify');
  if (!s) return el('div', { class: 'small muted' }, 'Synchronisation Shopify : pas encore en service — les ventes proviennent des exports « Transactions » déposés.');
  const st = FC_SYNC[s.last_status] || [s.last_status || '—', ''];
  return el('div', { class: 'small' }, 'Synchronisation Shopify : ', el('span', { class: 'badge ' + st[1] }, st[0]),
    ` · dernier passage ${dt(s.last_run_at)}`, s.last_success_at ? ` · dernier succès ${dt(s.last_success_at)}` : '',
    s.covered_from ? ` · période couverte du ${d(s.covered_from)} au ${d(s.covered_to)}` : '',
    s.last_count !== null && s.last_count !== undefined ? ` · ${s.last_count} ligne(s) au dernier passage` : '',
    s.last_error ? el('div', { class: 'muted' }, 'Dernière erreur : ' + s.last_error) : null);
}

async function pspForecastTab(body, p, go) {
  const f = await api('GET', '/api/psp/forecast?' + qs({ from: p.fc_from || '', to: p.fc_to || '' }));
  const provs = f.providers;
  const nav = n => go({ ...p, fc_from: fcShift(f.from, n), fc_to: fcShift(f.to, n) });
  const t = f.totaux || {};
  const ecartConnu = t.reel - t.prevu_connu;
  body.append(
    el('p', { class: 'small muted' }, 'Montants attendus en banque par jour et par prestataire, calculés à partir des ventes Shopify (moins les remboursements) et des règles de délai et de frais (Paramètres). ',
      'Banque : pas de crédit le week-end ni les jours fériés (report au jour ouvré suivant). Quand un prestataire a annoncé un versement pas encore reçu, son montant remplace l\'estimation. ',
      'Réel : crédits bancaires rattachés aux versements, à défaut crédits au libellé du prestataire (l\'écran Banque n\'est pas modifié).'),
    fcSyncLine(f.sync),
    el('div', { class: 'row', style: 'margin:10px 0;align-items:center' },
      el('button', { class: 'small', onclick: () => nav(-7) }, '‹ 7 jours'),
      el('button', { class: 'small', onclick: () => go({ ...p, fc_from: '', fc_to: '' }) }, 'Aujourd\'hui'),
      el('button', { class: 'small', onclick: () => nav(7) }, '7 jours ›'),
      el('span', { class: 'muted small' }, `Du ${d(f.from)} au ${d(f.to)}`
        + (f.reel_connu_jusquau ? ` · réel connu jusqu'au ${d(f.reel_connu_jusquau)} (relevés importés)` : ' · aucun relevé bancaire sur la période'))),
    el('div', { class: 'kpis' },
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'Attendu après aujourd\'hui'), el('div', { class: 'v' }, money(t.prevu_a_venir, 'EUR'))),
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'Prévu (jours au réel connu)'), el('div', { class: 'v' }, money(t.prevu_connu, 'EUR'))),
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'Reçu en banque'), el('div', { class: 'v' }, money(t.reel, 'EUR'))),
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'Écart reçu − prévu'), el('div', { class: 'v ' + fcEcartClass(ecartConnu, t.prevu_connu) }, money(ecartConnu, 'EUR')))));
  if (!provs.length) { body.appendChild(el('div', { class: 'empty' }, 'Aucune règle de prévisionnel.')); return; }
  const head = el('tr', {}, el('th', {}, 'Jour bancaire'),
    provs.map(x => el('th', { class: 'num' }, x.label, FC_QUALITY[x.quality] ? el('div', {}, el('span', { class: 'badge ' + FC_QUALITY[x.quality][1] }, FC_QUALITY[x.quality][0])) : null)),
    el('th', { class: 'num' }, 'Total'));
  const cell = (c, connu) => {
    if (!c) return el('td', { class: 'num' }, '');
    const parts = [];
    if (c.prevu || (connu && c.reel)) parts.push(el('div', {}, c.prevu ? money(c.prevu) : el('span', { class: 'muted' }, '—'),
      c.source === 'versement' ? el('span', { class: 'fc-tag', title: 'Versement annoncé par le prestataire (remplace l\'estimation ' + money(c.estime) + ')' }, ' annoncé') : null));
    if (connu && (c.reel || c.prevu)) parts.push(el('div', { class: 'small ' + fcEcartClass(c.ecart, c.prevu) }, `reçu ${money(c.reel)}`, c.ecart ? ` (${c.ecart > 0 ? '+' : ''}${money(c.ecart)})` : ''));
    return el('td', { class: 'num' }, parts);
  };
  const rows = f.days.map(dd => el('tr', { class: [dd.date === f.today ? 'fc-today' : '', dd.ouvre ? '' : 'fc-off'].join(' ').trim() || null },
    el('td', { class: 'nowrap' }, `${FC_DOW[dd.dow]} ${d(dd.date)}`, dd.ferie ? el('div', { class: 'small muted' }, 'férié') : (!dd.ouvre ? el('div', { class: 'small muted' }, 'non ouvré') : null),
      dd.date === f.today ? el('div', { class: 'small' }, 'aujourd\'hui') : null),
    provs.map(x => cell(dd.cells[x.code], dd.reel_connu)),
    el('td', { class: 'num' }, el('strong', {}, dd.total_prevu ? money(dd.total_prevu) : '—'),
      dd.reel_connu && (dd.total_reel || dd.total_prevu) ? el('div', { class: 'small ' + fcEcartClass(dd.ecart, dd.total_prevu) }, `reçu ${money(dd.total_reel)}`) : null)));
  body.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'fc-table' }, el('thead', {}, head), el('tbody', {}, rows))));
  body.appendChild(el('div', { class: 'small muted', style: 'margin-top:6px' },
    'Couleurs de l\'écart : vert = conforme (5 % ou 50 € près), rouge = reçu en moins, orange = reçu en plus. « annoncé » : montant du versement annoncé par le prestataire.'));

  // Tableau des délais : jour de commande → jour d'arrivée en banque (règles en vigueur la semaine de référence).
  const dl = f.delais || { lignes: [] };
  body.appendChild(el('h3', {}, `Délais de paiement (ventes de la semaine du ${d(dl.semaine)})`));
  body.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'fc-delays' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Commande le'), provs.map(x => el('th', {}, x.label)))),
    el('tbody', {}, dl.lignes.map(l => el('tr', {}, el('td', { class: 'nowrap' }, `${FC_DOW_LONG[l.dow]} ${fcShort(l.date)}`),
      provs.map(x => el('td', { class: 'small nowrap' }, ((l.cells || {})[x.code] || []).map(q => el('div', {},
        (q.share < 1 ? `${Math.round(q.share * 100)} % ` : '') + `${FC_DOW[new Date(q.jour + 'T12:00:00Z').getUTCDay() || 7]} ${fcShort(q.jour)} (J+${q.n})`))))))))));
  const notes = f.rules.filter(r => r.note);
  if (notes.length) body.appendChild(el('details', { style: 'margin-top:10px' }, el('summary', { class: 'small muted' }, 'Règles appliquées'),
    el('ul', { class: 'small' }, notes.map(r => el('li', {}, el('strong', {}, r.provider_label), r.valid_from || r.valid_to ? ` (ventes ${r.valid_from ? 'du ' + d(r.valid_from) : ''}${r.valid_to ? ' au ' + d(r.valid_to) : ''})` : '', ' — ', r.note)))));
}

// ------------------------------------------------------------------ encaissements web : ventes par jour (vendu → net attendu → banque)
L.vj_statut = { recu: ['Reçu', 'b-ok'], attendu: ['Attendu', 'vj-attendu'], en_retard: ['En retard', 'b-bad'], non_verifiable: ['Non vérifiable', 'vj-nv'] };
const VJ_SOURCE = { versement: 'd\'après les versements du prestataire', banque: 'd\'après les crédits bancaires au libellé du prestataire' };
const VJ_MAX_DAYS = 62;   // limite de psp_sales_by_day
const VJ_TOL = 100;       // écart CA Shopify / encaissé toléré : 1 € (centimes)
const vjEur = c => (c === null || c === undefined) ? '—' : money(c) + ' €';
const vjDay = iso => `${FC_DOW[new Date(iso + 'T12:00:00Z').getUTCDay() || 7]} ${fcShort(iso)}`;
const vjIso = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : '';
const vjToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });   // AAAA-MM-JJ, heure de Paris
const vjNbDays = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000) + 1;
// Pourcentage reçu (fraction 0 → 1) : jamais « 100 % » tant que tout n'est pas reçu, jamais « 0 % » dès qu'une partie l'est.
function vjPct(x) {
  if (x === null || x === undefined) return '—';
  let v = Math.round(x * 1000) / 10;
  if (x < 1 && v >= 100) v = 99.9;
  if (x > 0 && v <= 0) v = 0.1;
  return String(v).replace('.', ',') + ' %';
}
// Badge « % reçu » : vert 100 %, rouge si en retard, orange si partiel, gris si rien encore (attendu / non vérifiable).
function vjPctBadge(pctRecu, statut, netRecu, net) {
  if (pctRecu === null || pctRecu === undefined) return null;
  const cls = pctRecu >= 1 ? 'b-ok' : statut === 'en_retard' ? 'b-bad' : pctRecu > 0 ? 'b-warn' : 'vj-attendu';
  return el('span', { class: 'badge vj-pct ' + cls, title: `${vjEur(netRecu)} reçus sur ${vjEur(net)} attendus` }, vjPct(pctRecu));
}
// Écart CA Shopify − encaissé : badge « = Shopify » à 1 € près, sinon montant en orange.
function vjEcart(e) {
  if (e === null || e === undefined) return null;
  if (Math.abs(e) <= VJ_TOL) return el('span', { class: 'badge b-ok', title: `écart ${vjEur(e)}` }, '= Shopify');
  return el('div', { class: 'small fc-warn nowrap' }, `écart ${e > 0 ? '+' : ''}${vjEur(e)}`);
}

// Sélecteur de période : du / au + raccourcis, conservés dans l'adresse (#/encaissements?tab=ventes-jour&from=…&to=…).
function vjRangeBar(p, go, from, to, f) {
  const today = (f && f.today) || vjToday();
  const iFrom = el('input', { type: 'date', value: from || '', 'aria-label': 'Du' });
  const iTo = el('input', { type: 'date', value: to || '', 'aria-label': 'Au' });
  const msg = el('div', { class: 'vj-range-msg', role: 'alert' });
  const apply = (a, b) => {
    msg.textContent = '';
    if (!vjIso(a) || !vjIso(b)) { msg.textContent = 'Indiquez une date de début et une date de fin.'; return; }
    if (b < a) { msg.textContent = 'La date de fin doit être postérieure ou égale à la date de début.'; return; }
    const n = vjNbDays(a, b);
    if (n > VJ_MAX_DAYS) { msg.textContent = `Période trop longue : ${n} jours sélectionnés, ${VJ_MAX_DAYS} jours au plus. Réduisez la période (un mois à la fois par exemple).`; return; }
    go({ ...p, from: a, to: b, vj_from: '', vj_to: '' });
  };
  [iFrom, iTo].forEach(i => i.addEventListener('keydown', e => e.key === 'Enter' && apply(iFrom.value, iTo.value)));
  const m1 = today.slice(0, 8) + '01';
  const prevEnd = fcShift(m1, -1);
  const quick = [['7 j', fcShift(today, -6), today], ['14 j', fcShift(today, -13), today], ['30 j', fcShift(today, -29), today],
    ['Mois en cours', m1, today], ['Mois précédent', prevEnd.slice(0, 8) + '01', prevEnd]];
  const cur = f ? [f.from, f.to] : [from, to];
  const shift = n => { if (f) go({ ...p, from: fcShift(f.from, n), to: fcShift(f.to, n), vj_from: '', vj_to: '' }); };
  return el('div', { class: 'vj-range' },
    el('div', { class: 'row vj-range-row' },
      el('label', { class: 'f' }, 'Du', iFrom), el('label', { class: 'f' }, 'Au', iTo),
      el('button', { class: 'primary', onclick: () => apply(iFrom.value, iTo.value) }, 'Afficher'),
      el('div', { class: 'vj-quick' }, quick.map(([l, a, b]) => el('button', { class: 'small' + (a === cur[0] && b === cur[1] ? ' primary' : ''), onclick: () => apply(a, b) }, l))),
      f ? el('div', { class: 'vj-quick' },
        el('button', { class: 'small', title: 'Décaler la période de 7 jours en arrière', onclick: () => shift(-7) }, '‹ 7 jours'),
        el('button', { class: 'small', title: 'Décaler la période de 7 jours en avant', onclick: () => shift(7) }, '7 jours ›')) : null),
    msg);
}

async function pspSalesByDayTab(body, p, go) {
  const from = vjIso(p.from || p.vj_from), to = vjIso(p.to || p.vj_to);
  let f;
  try { f = await api('GET', '/api/psp/sales-by-day?' + qs({ from, to })); }
  catch (e) {
    if (e.status === 401) throw e;
    body.append(vjRangeBar(p, go, from, to, null), el('div', { class: 'callout bad' },
      /62 jours/.test(e.message) ? `Période invalide : ${VJ_MAX_DAYS} jours au plus, date de fin postérieure ou égale à la date de début. Choisissez une autre période.` : e.message));
    return;
  }
  const provs = f.providers;
  const t = f.totaux || {};
  const st = t.statuts || {};
  const shopOk = !!t.ca_shopify_disponible;
  const hasCa = t.ca_shopify !== null && t.ca_shopify !== undefined;
  const nDays = f.days.length;
  const ecartTot = hasCa ? t.ecart_ca : null;
  body.append(
    el('p', { class: 'small muted' }, 'Pour chaque jour de vente (heure de Paris) : montant vendu (ventes − remboursements du jour), net attendu et date d\'arrivée en banque attendue selon les règles du prévisionnel (Paramètres). ',
      'Statut d\'après les versements du prestataire quand les transactions du jour y sont rattachées (Shopify Payments, JUST, TikTok), sinon d\'après les crédits bancaires au libellé du prestataire autour de la date attendue (± 1 jour ouvré, délai de tolérance compris). ',
      'Cliquez sur une case pour le détail.'),
    vjRangeBar(p, go, f.from, f.to, f),
    el('div', { class: 'small muted vj-period' }, `Ventes du ${d(f.from)} au ${d(f.to)} (${nDays} jours)`
      + (f.bank_last_date ? ` · relevés bancaires importés jusqu'au ${d(f.bank_last_date)}` : ' · aucun relevé bancaire importé')),
    el('div', { class: 'kpis' },
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'CA Shopify de la période'), el('div', { class: 'v' }, hasCa ? vjEur(t.ca_shopify) : '—'),
        el('div', { class: 's' }, !shopOk ? 'non disponible (droit read_reports à ajouter)'
          : !hasCa ? 'aucun jour de rapport sur la période'
          : (t.jours_ca_shopify < nDays ? `rapport sur ${t.jours_ca_shopify} / ${nDays} jours` : `${t.commandes_shopify || 0} commande(s)`))),
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'Total encaissé (toutes passerelles)'), el('div', { class: 'v' }, vjEur(t.total_encaisse_toutes_passerelles)),
        el('div', { class: 's' }, 'y compris Baback, carte cadeau…')),
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'Écart CA Shopify − encaissé'),
        el('div', { class: 'v ' + (ecartTot === null ? '' : Math.abs(ecartTot) <= VJ_TOL ? 'fc-ok' : 'fc-warn') },
          ecartTot === null ? '—' : Math.abs(ecartTot) <= VJ_TOL ? '= Shopify' : `${ecartTot > 0 ? '+' : ''}${vjEur(ecartTot)}`),
        el('div', { class: 's' }, ecartTot === null ? '' : (Math.abs(ecartTot) <= VJ_TOL ? `écart ${vjEur(ecartTot)} (1 € près)` : '')
          + (hasCa && t.jours_ca_shopify < nDays ? ' sur les jours couverts' : ''))),
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'Vendu (prestataires suivis)'), el('div', { class: 'v' }, vjEur(t.vendu))),
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'Net attendu'), el('div', { class: 'v' }, vjEur(t.net))),
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'Net reçu'), el('div', { class: 'v' }, vjEur(t.net_recu))),
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, '% reçu'),
        el('div', { class: 'v ' + (t.pct_recu === null || t.pct_recu === undefined ? '' : t.pct_recu >= 1 ? 'fc-ok' : st.en_retard ? 'fc-bad' : t.pct_recu > 0 ? 'fc-warn' : '') }, vjPct(t.pct_recu))),
      el('div', { class: 'kpi' + (st.en_retard ? ' bad' : '') }, el('div', { class: 'l' }, 'Cases en retard'), el('div', { class: 'v' }, String(st.en_retard || 0))),
      el('div', { class: 'kpi' }, el('div', { class: 'l' }, 'Reçues / attendues / non vérifiables'),
        el('div', { class: 'v' }, `${st.recu || 0} / ${st.attendu || 0} / ${st.non_verifiable || 0}`))));
  if (!shopOk) body.appendChild(el('div', { class: 'callout info' }, 'CA Shopify non disponible (droit read_reports à ajouter) : ',
    'l\'application Shopify de la synchronisation doit recevoir la portée read_reports pour lire le rapport « Ventes » par jour.'));
  if (!provs.length) { body.appendChild(el('div', { class: 'empty' }, 'Aucun prestataire suivi.')); return; }

  const head = el('tr', {}, el('th', {}, 'Jour de vente'),
    shopOk ? el('th', { class: 'num' }, 'CA Shopify', el('div', { class: 'small muted' }, 'et écart avec l\'encaissé')) : null,
    provs.map(x => el('th', { class: 'num' }, x.label, FC_QUALITY[x.quality] ? el('div', {}, el('span', { class: 'badge ' + FC_QUALITY[x.quality][1] }, FC_QUALITY[x.quality][0])) : null)),
    el('th', { class: 'num' }, 'Total'), el('th', { class: 'num' }, '% reçu'));
  const caCell = dd => {
    if (dd.ca_shopify === null || dd.ca_shopify === undefined) return el('td', { class: 'num small muted' }, '—');
    return el('td', { class: 'num vj-ca' }, el('div', { class: 'vj-amt' }, vjEur(dd.ca_shopify)),
      el('div', { class: 'small muted nowrap' }, `encaissé ${vjEur(dd.total_encaisse_toutes_passerelles)}`), vjEcart(dd.ecart_ca));
  };
  const cell = (dd, x) => {
    const c = dd.cells[x.code];
    if (!c) return el('td', { class: 'num vj-empty' }, '');
    const dates = (c.parts || []).map(q => (q.share < 1 ? `${Math.round(q.share * 100)} % ` : '') + '→ ' + vjDay(q.date_attendue));
    const partiel = c.pct_recu !== null && c.pct_recu !== undefined && c.pct_recu > 0 && c.pct_recu < 1;
    return el('td', { class: 'num vj-cell', title: 'Voir le détail', onclick: () => vjDetail(dd, x, c) },
      el('div', { class: 'vj-amt' }, vjEur(c.vendu)),
      c.net !== null && c.net !== undefined ? el('div', { class: 'small muted' }, `net ${vjEur(c.net)}`) : el('div', { class: 'small muted' }, 'pas de règle'),
      dates.length ? el('div', { class: 'small muted nowrap' }, dates.join(' · ')) : null,
      c.source === 'versement' && c.date_reelle ? el('div', { class: 'small nowrap' }, `en banque ${vjDay(c.date_reelle)}`) : null,
      c.statut ? el('div', {}, badge('vj_statut', c.statut), partiel ? el('span', { class: 'small vj-partiel' }, ' ' + vjPct(c.pct_recu)) : null) : null);
  };
  const days = f.days.slice().reverse();   // jours les plus récents en haut
  const rows = days.map(dd => el('tr', { class: [dd.date === f.today ? 'vj-today' : '', dd.ouvre ? '' : 'vj-off'].join(' ').trim() || null },
    el('td', { class: 'nowrap' }, `${FC_DOW[dd.dow]} ${d(dd.date)}`, dd.ferie ? el('div', { class: 'small muted' }, 'férié') : (!dd.ouvre ? el('div', { class: 'small muted' }, 'non ouvré') : null),
      dd.date === f.today ? el('div', { class: 'small' }, 'aujourd\'hui') : null),
    shopOk ? caCell(dd) : null,
    provs.map(x => cell(dd, x)),
    el('td', { class: 'num' }, el('strong', {}, dd.total_vendu ? vjEur(dd.total_vendu) : '—'),
      dd.total_net ? el('div', { class: 'small muted' }, `net ${vjEur(dd.total_net)}`) : null),
    el('td', { class: 'num' }, vjPctBadge(dd.pct_recu, dd.statut, dd.net_recu, dd.total_net),
      dd.pct_recu !== null && dd.pct_recu !== undefined ? el('div', { class: 'small muted nowrap' }, `reçu ${vjEur(dd.net_recu)}`) : null)));
  const pp = t.par_prestataire || {};
  const foot = el('tr', { class: 'vj-total' }, el('td', {}, el('strong', {}, 'Total')),
    shopOk ? el('td', { class: 'num' }, hasCa ? [el('strong', {}, vjEur(t.ca_shopify)), vjEcart(t.ecart_ca)] : '—') : null,
    provs.map(x => el('td', { class: 'num' }, pp[x.code] ? [el('strong', {}, vjEur(pp[x.code].vendu)), el('div', { class: 'small muted' }, `net ${vjEur(pp[x.code].net)}`),
      el('div', { class: 'small muted' }, `${pp[x.code].n_commandes} cmd`),
      pp[x.code].pct_recu !== null && pp[x.code].pct_recu !== undefined ? el('div', { class: 'small muted' }, `reçu ${vjPct(pp[x.code].pct_recu)}`) : null] : '—')),
    el('td', { class: 'num' }, el('strong', {}, vjEur(t.vendu)), el('div', { class: 'small muted' }, `net ${vjEur(t.net)}`)),
    el('td', { class: 'num' }, vjPctBadge(t.pct_recu, st.en_retard ? 'en_retard' : null, t.net_recu, t.net)));
  body.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'vj-table' }, el('thead', {}, head), el('tbody', {}, rows), el('tfoot', {}, foot))));
  body.appendChild(el('div', { class: 'small muted vj-notes' },
    'Reçu : versement retrouvé en banque (ou crédit du prestataire à la date attendue). Attendu : date pas encore passée, délai de tolérance en cours ou relevé pas encore importé. ',
    'En retard : rien trouvé sur les relevés importés après le délai de tolérance. Non vérifiable : date antérieure aux premiers relevés couvrant ce prestataire. ',
    'Les crédits au libellé du prestataire ne sont pas affectés à un jour de vente précis : le statut « reçu » indique qu\'un crédit est arrivé à la date attendue, pas que son montant correspond.'),
    el('div', { class: 'small muted vj-notes' },
      '% reçu : net des parts reçues (ou, pour les prestataires à versements, part du net des transactions du jour comprises dans un versement reçu) rapporté au net attendu. ',
      'Vert 100 %, orange partiel, gris rien encore (attendu), rouge en retard. ',
      'CA Shopify : « Ventes totales » du rapport Ventes de Shopify pour le jour ; encaissé : ventes − remboursements du jour, toutes passerelles (y compris non suivies). ',
      '« = Shopify » : écart de 1 € au plus. Un écart peut venir de remboursements comptés un autre jour, de ventes de cartes cadeaux ou de commandes payées plus tard (paiement différé, Stockly).'));
}

function vjDetail(dd, x, c) {
  const kv = (k, v) => [el('div', { class: 'k' }, k), el('div', {}, v)];
  const qual = FC_QUALITY[c.quality] ? el('span', { class: 'badge ' + FC_QUALITY[c.quality][1] }, FC_QUALITY[c.quality][0]) : el('span', { class: 'badge b-ok' }, 'règle mesurée');
  const parts = (c.parts || []).length ? el('table', { class: 'vj-detail' },
    el('thead', {}, el('tr', {}, ['Part', 'Net attendu', 'Date attendue', 'Crédit bancaire'].map((h, i) => el('th', { class: i === 1 ? 'num' : '' }, h)))),
    el('tbody', {}, c.parts.map(q => el('tr', {},
      el('td', {}, `${Math.round(q.share * 100)} %`, q.fee_rate > 0 ? el('div', { class: 'small muted' }, `frais ${String(Math.round(q.fee_rate * 10000) / 100).replace('.', ',')} %`) : null),
      el('td', { class: 'num' }, vjEur(q.net)),
      el('td', { class: 'nowrap' }, `${vjDay(q.date_attendue)} (J+${q.jours})`, el('div', { class: 'small muted' }, `tolérance jusqu'au ${fcShort(q.date_limite)}`),
        c.source !== 'versement' && q.statut_banque ? el('div', {}, badge('vj_statut', q.statut_banque)) : null),
      el('td', { class: 'small' }, q.credit ? [el('div', {}, `${d(q.credit.date)} — ${vjEur(q.credit.amount)}`), el('div', { class: 'muted' }, q.credit.label)] : el('span', { class: 'muted' }, '—'))))))
    : el('div', { class: 'small muted' }, 'Aucune règle de prévisionnel pour ce prestataire à cette date.');
  const vers = (c.versements || []).length ? [el('h3', {}, 'Versements rattachés'), el('table', { class: 'vj-detail' },
    el('thead', {}, el('tr', {}, ['Versement', 'Montant', 'Banque', 'État'].map((h, i) => el('th', { class: i === 1 ? 'num' : '' }, h)))),
    el('tbody', {}, c.versements.map(v => el('tr', {},
      el('td', { class: 'small' }, el('div', {}, d(v.payout_date)), el('div', { class: 'mono muted' }, v.bank_ref || v.ext_id || '—')),
      el('td', { class: 'num' }, vjEur(v.amount)),
      el('td', { class: 'small' }, v.bank_date ? `${d(v.bank_date)} — ${vjEur(v.bank_amount)}` : el('span', { class: 'muted' }, `attendu au plus tard le ${d(v.expected_by)}`)),
      el('td', {}, badge('psp_etat', v.etat))))))] : [];
  modal(`${x.label} — ventes du ${FC_DOW_LONG[dd.dow].toLowerCase()} ${d(dd.date)}`, el('div', {},
    el('div', { class: 'row vj-detail-head' }, c.statut ? badge('vj_statut', c.statut) : null, vjPctBadge(c.pct_recu, c.statut, c.net_recu, c.net), qual,
      c.source ? el('span', { class: 'small muted' }, 'Statut ' + VJ_SOURCE[c.source]) : null),
    el('div', { class: 'kv vj-detail-kv' },
      kv('Commandes', String(c.n_commandes)), kv('Ventes', vjEur(c.ventes)), kv('Remboursements', c.remboursements ? '− ' + vjEur(c.remboursements) : '—'),
      kv('Vendu', el('strong', {}, vjEur(c.vendu))), kv('Frais estimés', vjEur(c.frais)), kv('Net attendu', el('strong', {}, vjEur(c.net))),
      c.net_recu !== null && c.net_recu !== undefined ? kv('Net reçu', `${vjEur(c.net_recu)}` + (c.pct_recu !== null && c.pct_recu !== undefined ? ` (${vjPct(c.pct_recu)})` : '')) : [],
      c.n_tx ? kv('Transactions prestataire', `${c.n_tx}` + (c.n_tx_sans_versement ? ` (dont ${c.n_tx_sans_versement} pas encore dans un versement)` : '')) : []),
    parts, ...vers), []);
}

// Paramètres : règles du prévisionnel (administrateurs). Taux saisis en %, stockés en fraction.
async function pspForecastRulesSettings(body) {
  let f;
  try { f = await api('GET', '/api/psp/forecast?' + qs({ rules_only: '1' })); } catch (e) { return; }
  const admin = isAdmin();
  const MODES = { jours: 'J + n jours', hebdo: 'hebdomadaire', mensuel: 'mensuel' };
  const pctOut = v => (v === null || v === undefined) ? '' : String(Math.round(Number(v) * 100000) / 1000).replace('.', ',');
  body.append(el('h3', {}, 'Prévisionnel : délais et frais par prestataire'),
    el('p', { class: 'small muted' }, 'Mode « J + n » : arrivée au jour ouvré suivant la vente + n jours. Hebdomadaire : ventes de la semaine (lundi → dimanche) versées le jour indiqué de la semaine suivante (1 = lundi). ',
      'Mensuel : ventes du mois versées le jour indiqué du mois suivant. Montant attendu = brut × part versée − brut × frais. Les dates de validité portent sur la date de vente (bascule PayPal).'));
  body.appendChild(el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ['Prestataire', 'Part', 'Ventes du', 'au', 'Mode', 'n jours', 'Jour sem.', 'Jour mois', 'Part versée (%)', 'Frais (%)', 'Qualité', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, f.rules.map(r => {
      const i = {};
      const inp = (k, val, w, type) => (i[k] = el('input', { value: val === null || val === undefined ? '' : val, style: `width:${w}px`, type: type || null, disabled: admin ? null : true }));
      const sel = (k, opts, val) => { const s = el('select', { disabled: admin ? null : true }, Object.entries(opts).map(([v, l]) => el('option', { value: v, selected: v === val ? 'selected' : null }, l))); i[k] = s; return s; };
      const orig = { valid_from: r.valid_from || '', valid_to: r.valid_to || '', mode: r.mode, delay_days: String(r.delay_days), weekday: r.weekday === null ? '' : String(r.weekday),
        month_day: r.month_day === null ? '' : String(r.month_day), share: pctOut(r.share), fee_rate: pctOut(r.fee_rate), quality: r.quality };
      return el('tr', { title: r.note || '' }, el('td', {}, r.provider_label), el('td', {}, r.part),
        el('td', {}, inp('valid_from', orig.valid_from, 130, 'date')), el('td', {}, inp('valid_to', orig.valid_to, 130, 'date')),
        el('td', {}, sel('mode', MODES, r.mode)), el('td', {}, inp('delay_days', orig.delay_days, 50)), el('td', {}, inp('weekday', orig.weekday, 40)),
        el('td', {}, inp('month_day', orig.month_day, 40)), el('td', {}, inp('share', orig.share, 60)), el('td', {}, inp('fee_rate', orig.fee_rate, 60)),
        el('td', {}, sel('quality', { mesure: 'mesurée', estimation: 'estimation', hypothese: 'hypothèse' }, r.quality)),
        el('td', {}, admin ? el('button', { class: 'small', onclick: () => {
          const ch = {};
          for (const [k, x] of Object.entries(i)) if (String(x.value).trim() !== orig[k]) ch[k] = String(x.value).trim();
          for (const k of ['share', 'fee_rate']) if (ch[k] !== undefined) {
            const v = Number(ch[k].replace(',', '.'));
            if (ch[k] === '' || isNaN(v)) return toast('Taux invalide', true);
            ch[k] = String(Math.round(v * 1000) / 100000);
          }
          if (!Object.keys(ch).length) return toast('Aucune modification');
          act(() => api('POST', `/api/psp/forecast-rules/${r.id}`, ch), 'Règle enregistrée').then(render);
        } }, 'Enregistrer') : null));
    })))));
}

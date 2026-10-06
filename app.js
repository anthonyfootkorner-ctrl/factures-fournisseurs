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
  ['#/', 'Tableau de bord'], ['#/factures', 'Factures'], ['#/a-verifier', 'À vérifier'],
  ['#/fournisseurs', 'Fournisseurs'], ['#/imports', 'Imports'], ['#/parametres', 'Paramètres'],
];
let reviewCount = null;

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
async function render() {
  if (currentTimer) { clearInterval(currentTimer); currentTimer = null; }
  const app = $('#app');
  if (!S.user) return renderLogin();
  await loadLookups().catch(() => {});
  const hash = location.hash || '#/';
  const main = el('main', { class: 'main' });
  const nav = el('nav', {}, NAV.map(([h, label]) => {
    const active = h === '#/' ? hash === '#/' || hash === '' : hash.startsWith(h);
    const a = el('a', { href: h, class: active ? 'active' : '' }, label);
    if (h === '#/a-verifier') a.appendChild(el('span', { class: 'count', id: 'review-count', style: 'display:none' }));
    return a;
  }));
  const demoBtn = el('button', { class: 'small', onclick: () => { S.demo = !S.demo; try { localStorage.setItem('sf_demo', S.demo ? '1' : '0'); } catch (e) {} render(); } },
    S.demo ? 'Revenir aux données réelles' : 'Voir les données de démo');
  const side = el('aside', { class: 'side' },
    el('div', { class: 'logo' }, 'Factures fournisseurs', el('small', {}, 'Suivi & règlements')),
    nav,
    el('div', { class: 'foot' }, el('div', {}, S.user.name), el('div', {}, L.role[S.user.role]), demoBtn, ' ',
      el('button', { class: 'small', onclick: async () => { await SB.logout(); S.user = null; render(); } }, 'Se déconnecter'),
      ' ', el('button', { class: 'small', onclick: changeOwnPassword }, 'Mot de passe')));
  app.replaceChildren(el('div', { class: 'layout' }, side, main));
  if (S.demo) main.appendChild(el('div', { class: 'demo-banner' }, 'MODE DÉMONSTRATION — données fictives, séparées des données réelles'));
  const view = el('div');
  main.appendChild(view);
  updateReviewCount();
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
    g.appendChild(svg('line', { x1: padL, x2: W - 6, y1: y, y2: y, stroke: '#eef0f3' }));
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

// ------------------------------------------------------------------ tableau de bord
async function viewDashboard(view) {
  const p = Object.assign({ company_id: '', supplier_id: '', from: '', to: '' }, getHashParams());
  const filters = filterBar(p, ['company_id', 'supplier_id', 'from', 'to'], np => { location.hash = '#/?' + new URLSearchParams(np); });
  view.append(el('h1', {}, 'Tableau de bord'), filters);
  const data = await api('GET', '/api/dashboard?' + qs(p));
  const base = { company_id: p.company_id, supplier_id: p.supplier_id, from: p.from, to: p.to };
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
  for (const cur of curs) {
    const c = data.currencies[cur];
    const box = el('section', {});
    if (curs.length > 1) box.appendChild(el('h2', {}, 'Devise : ' + cur));
    const kpi = (lab, v, sub, cls, href) => el('div', { class: 'kpi ' + (cls || '') }, el('a', { href: href || null }, el('div', { class: 'l' }, lab), el('div', { class: 'v' }, money(v, cur)), sub ? el('div', { class: 's' }, sub) : null));
    box.appendChild(el('div', { class: 'kpis' },
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
      el('div', { class: 'legend' }, el('span', {}, el('i', { style: 'background:#4a78c2' }), 'Validé'), el('span', {}, el('i', { style: 'background:#a9c1ea' }), 'À vérifier'),
        el('span', {}, el('i', { style: 'background:#d9534f' }), 'En retard (à régulariser)'), el('span', {}, el('i', { style: 'background:#b8bfcc' }), 'Sans échéance (non réparti)')));
    // Balance âgée
    const ag = c.balance_agee;
    const agItems = [['non_echu', 'Non échu', '#4a78c2'], ['r1_30', '1–30 j', '#e5a740'], ['r31_60', '31–60 j', '#e07b39'], ['r61_90', '61–90 j', '#d9534f'], ['r90p', '> 90 j', '#8e1f1a'], ['sans_echeance', 'Sans échéance', '#b8bfcc'], ['litige', 'En litige', '#7a3fb8']];
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
  if (!forced.validation) view.appendChild(filterBar(p, ['search', 'supplier_id', 'company_id', 'doc_type', 'validation', 'payment', 'situation', 'duplicate', 'from', 'to', 'due_to'], np => go(np)));
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
  const fields = [['name', 'Raison sociale'], ['trade_name', 'Nom commercial'], ['siren', 'SIREN'], ['siret', 'SIRET'], ['vat', 'N° TVA'], ['address', 'Adresse'], ['email', 'E-mail'], ['phone', 'Téléphone'], ['payment_terms', 'Conditions de paiement habituelles'], ['notes', 'Notes']];
  const inputs = {};
  const form = el('div', { class: 'fields' }, fields.map(([k, l]) => { inputs[k] = el(k === 'notes' || k === 'address' ? 'textarea' : 'input', { value: s[k] || '', disabled: ro ? true : null }); return [el('div', { class: 'lab' }, l), el('div', { class: 'val' }, inputs[k])]; }));
  const aliases = el('textarea', { disabled: ro ? true : null }); aliases.value = s.aliases.join('\n');
  form.append(el('div', { class: 'lab' }, 'Noms alternatifs / variantes (un par ligne)'), el('div', { class: 'val' }, aliases));
  const info = el('div', { class: 'panel' }, el('h2', {}, 'Fiche'), form,
    ro ? null : el('div', { style: 'margin-top:10px' }, el('button', { class: 'primary', onclick: async () => {
      const body = {}; for (const [k] of fields) if ((s[k] || '') !== inputs[k].value) body[k] = inputs[k].value;
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
async function viewImports(view) {
  view.appendChild(el('h1', {}, 'Imports'));
  const ws = workerState(S.lookups.worker_last_seen);
  view.appendChild(el('div', { class: 'callout ' + (ws.ok ? 'info' : '') }, 'Poste de traitement (lecture des factures) : ', el('span', { class: 'badge ' + ws.cls }, ws.label),
    ws.ok ? '' : ' — les fichiers déposés sont conservés et seront traités dès que le poste sera de nouveau allumé.'));
  if (canWrite() && !S.demo) {
    const label = el('input', { placeholder: 'Libellé du lot (facultatif), ex. « Factures septembre »' });
    const fileInput = el('input', { type: 'file', multiple: true, accept: '.pdf,.xlsx,.xls,.csv,.zip,.jpg,.jpeg,.png', style: 'display:none' });
    const list = el('div');
    const drop = el('div', { class: 'drop', onclick: () => fileInput.click() }, el('strong', {}, 'Déposez vos factures ici ou cliquez pour choisir'),
      'PDF (y compris scannés), Excel XLSX/XLS, CSV, ZIP (avec sous-dossiers), images JPG/PNG — plusieurs fichiers à la fois');
    const start = async files => {
      if (!files.length) return;
      const b = await act(() => api('POST', '/api/batches', { label: label.value }));
      list.replaceChildren();
      const rows = [...files].map(f => { const bar = el('div', { style: 'width:0%' }); const st = el('span', { class: 'small muted' }, 'en attente d\'envoi');
        list.appendChild(el('div', { class: 'row', style: 'align-items:center;margin:4px 0' }, el('span', { class: 'grow' }, f.name), el('div', { class: 'progress', style: 'width:180px' }, bar), st)); return { f, bar, st }; });
      for (const r of rows) {
        try {
          if (r.f.size > 100 * 1024 * 1024) throw new Error('fichier trop volumineux');
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
    view.appendChild(el('div', { class: 'panel' }, el('label', { class: 'f', style: 'margin-bottom:10px' }, 'Lot', label), drop, fileInput, list,
      el('p', { class: 'small muted' }, 'Les fichiers sont contrôlés (format réel, taille, archives piégées) puis traités en arrière-plan : une erreur sur un fichier ne bloque pas les autres. Le contenu des documents est traité comme une donnée, jamais exécuté.')));
  }
  const batches = await api('GET', '/api/batches?' + qs({}));
  view.appendChild(el('div', { class: 'panel table-wrap' }, el('h2', {}, 'Lots importés'), el('table', {}, el('thead', {}, el('tr', {}, ['Lot', 'Libellé', 'Date', 'Par', 'Fichiers', 'En cours', 'Erreurs', 'Doublons', 'À mapper', 'Factures'].map(h => el('th', {}, h)))),
    el('tbody', {}, batches.length ? batches.map(b => el('tr', { class: 'click', onclick: () => { location.hash = '#/imports/' + b.id; } }, el('td', {}, '#' + b.id), el('td', {}, b.label || '—'), el('td', {}, dt(b.created_at)), el('td', {}, b.user_name || '—'),
      el('td', {}, b.items), el('td', {}, b.pending ? el('span', { class: 'badge b-info' }, b.pending) : '0'), el('td', {}, b.errors ? el('span', { class: 'badge b-bad' }, b.errors) : '0'),
      el('td', {}, b.duplicates ? el('span', { class: 'badge b-warn' }, b.duplicates) : '0'), el('td', {}, b.mapping ? el('span', { class: 'badge b-warn' }, b.mapping) : '0'), el('td', {}, b.invoices)))
      : el('tr', {}, el('td', { colspan: 10, class: 'empty' }, 'Aucun import'))))));
}

async function viewBatch(view, id) {
  const container = el('div');
  view.appendChild(container);
  const draw = async () => {
    const b = await api('GET', '/api/batches/' + id);
    const pending = b.items.filter(i => ['en_attente', 'traitement'].includes(i.status)).length;
    const counts = {};
    b.items.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
    const done = b.items.length - pending;
    container.replaceChildren(
      el('div', { class: 'row', style: 'align-items:center;margin-bottom:12px' }, el('h1', { style: 'margin:0' }, `Lot #${b.id}` + (b.label ? ' — ' + b.label : '')), el('div', { class: 'grow' }),
        el('a', { class: 'btn small', href: '#/factures?batch_id=' + id }, 'Voir les factures du lot'), el('a', { class: 'btn small', href: '#/imports' }, '← Imports')),
      el('div', { class: 'panel' }, el('div', { class: 'row', style: 'align-items:center' }, el('div', { class: 'progress grow' }, el('div', { style: `width:${b.items.length ? done / b.items.length * 100 : 0}%` })),
        el('span', {}, `${done} / ${b.items.length} traité(s)`), Object.entries(counts).map(([k, n]) => el('span', {}, badge('item', k), ' ', n)))),
      el('div', { class: 'panel table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['#', 'Fichier / provenance', 'Type', 'Taille', 'Statut', 'Résultat', 'Factures', ''].map(h => el('th', {}, h)))),
        el('tbody', {}, b.items.map(it => el('tr', {}, el('td', {}, it.id),
          el('td', {}, el('div', {}, it.filename), it.provenance !== it.filename ? el('div', { class: 'small muted' }, it.provenance) : null),
          el('td', {}, it.kind || '—'), el('td', { class: 'nowrap' }, it.size ? (it.size / 1024).toFixed(0) + ' Ko' : '—'),
          el('td', {}, badge('item', it.status), it.attempts > 1 ? el('div', { class: 'small muted' }, it.attempts + ' tentatives') : null),
          el('td', { class: 'small' }, it.message || '', it.status === 'correspondance' && it.mapping && canWrite() ? mappingEditor(it) : null),
          el('td', {}, it.invoices_created ? el('a', { href: `#/factures?document_id=${it.document_id}&batch_id=${id}` }, it.invoices_created) : (it.status === 'doublon' && it.document_id ? el('a', { href: '#/factures?document_id=' + it.document_id }, 'voir l\'original') : '—')),
          el('td', {}, canWrite() && ['erreur', 'termine'].includes(it.status) && it.kind && it.kind !== 'zip' ? el('button', { class: 'small', onclick: () => act(() => api('POST', `/api/import-items/${it.id}/retry`), 'Relance programmée').then(draw) }, 'Relancer') : null,
            canWrite() && it.status === 'erreur' && it.kind === 'zip' ? el('button', { class: 'small', onclick: () => act(() => api('POST', `/api/import-items/${it.id}/retry`)).then(draw) }, 'Relancer') : null)))))),
      el('p', { class: 'small muted' }, 'La relance d\'un fichier remplace les factures issues de la tentative précédente (sans créer de doublon) tant qu\'elles n\'ont été ni validées ni réglées.'));
    return pending;
  };
  const pending = await draw();
  if (pending) currentTimer = setInterval(async () => { if (!location.hash.startsWith('#/imports/' + id)) { clearInterval(currentTimer); return; } const p = await draw().catch(() => 0); if (!p) { clearInterval(currentTimer); updateReviewCount(); } }, 1500);
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
    const lim = { max_upload_mb: el('input', { type: 'number', value: st.max_upload_mb }), zip_max_entries: el('input', { type: 'number', value: st.zip_max_entries }), zip_max_total_mb: el('input', { type: 'number', value: st.zip_max_total_mb }), zip_max_ratio: el('input', { type: 'number', value: st.zip_max_ratio }) };
    p.append(el('h2', {}, 'Règles de contrôle'), el('div', { class: 'fields' },
      el('div', { class: 'lab' }, 'Tolérance d\'arrondi HT + TVA = TTC (centimes)'), el('div', { class: 'val' }, tol),
      el('div', { class: 'lab' }, 'Calcul « N jours fin de mois »'), el('div', { class: 'val' }, fdm),
      el('div', { class: 'lab' }, 'Validation automatique'), el('div', { class: 'val' }, auto),
      el('div', { class: 'lab' }, 'Taille max. d\'un fichier (Mo)'), el('div', { class: 'val' }, lim.max_upload_mb),
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

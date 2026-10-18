// Encaissements négoce (créances clients) — chargé avant app.js, branché par app.js sur la route #/negoce.
// S'appuie sur les helpers globaux d'app.js (el, money, d, isoDate, modal, toast, act, supAvatar, areaChart, barChart, SB, S).
const NEGOCE = (() => {
  const rpc = async (fn, params) => {
    try { return await SB.rpc(fn, params); }
    catch (e) { if (e.status === 401) { await SB.logout(); S.user = null; render(); } throw e; }
  };
  const SIT = {
    a_encaisser: ['À encaisser', 'b-info'], partielle: ['Partiellement encaissée', 'b-info'], en_retard: ['En retard', 'b-bad'], encaissee: ['Encaissée', 'b-ok'],
    litige: ['En litige', 'b-bad'], annulee: ['Annulée', ''], a_imputer: ['Avoir à imputer', 'b-warn'], impute: ['Avoir imputé', 'b-ok'],
  };
  const TYPES = { client: 'Client', intra_groupe: 'Intra-groupe', marque: 'Marque (marketing)', autre: 'Autre' };
  const MODES = { VIR: 'Virement', PRE: 'Prélèvement CIC', CAP: 'Prélèvement CA', CAV: 'Virement CA', LCR: 'LCR', CHQ: 'Chèque', COMP: 'Compensation' };
  const sit = k => { const v = SIT[k] || [k, '']; return el('span', { class: 'badge ' + v[1] }, v[0]); };
  const mode = k => MODES[k] || k || '—';
  const canWrite = () => S.user && ['admin', 'finance'].includes(S.user.role);
  const addDays = (iso, n) => { const x = new Date(iso + 'T12:00:00'); x.setDate(x.getDate() + n); return isoDate(x); };
  const moisLib = (ym, long) => new Date(ym + '-01T12:00:00').toLocaleDateString('fr-FR', long ? { month: 'long', year: 'numeric' } : { month: 'short', year: '2-digit' });
  const finMois = ym => { const x = new Date(ym + '-01T12:00:00'); x.setMonth(x.getMonth() + 1); x.setDate(0); return isoDate(x); };
  const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  const link = (path, extra) => '#/negoce' + path + (Object.keys(clean(extra || {})).length ? '?' + new URLSearchParams(clean(extra)) : '');
  const params = () => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
  const toCents = s => { const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return isNaN(v) ? null : Math.round(v * 100); };
  let famillesCache = null;

  // ------------------------------------------------------------------ menu secondaire + filtres
  function subnav(active) {
    const items = [['', 'Tableau de bord'], ['/clients', 'Clients'], ['/factures', 'Factures de vente'], ['/encaissements', 'Encaissements']];
    return el('div', { class: 'tabs negoce-sub' }, items.map(([h, l]) => el('a', { href: link(h), class: 'tabbtn' + (active === h ? ' on' : '') }, l)));
  }
  async function famillesList() {
    if (famillesCache) return famillesCache;
    const cs = await rpc('negoce_customers', { p: { all: true } }).catch(() => []);
    famillesCache = { familles: [...new Set(cs.map(c => c.famille).filter(Boolean))].sort(), clients: cs.map(c => [c.id, c.name]).sort((a, b) => a[1].localeCompare(b[1])) };
    return famillesCache;
  }
  async function aside(p, go, o = {}) {
    const lk = await famillesList();
    const selF = (p.famille || '').split(',').filter(Boolean), selT = (p.type || '').split(',').filter(Boolean);
    const toggle = (key, sel, k) => go({ ...p, [key]: (sel.includes(k) ? sel.filter(x => x !== k) : [...sel, k]).join(',') });
    const checks = (key, sel, opts) => el('div', { class: 'f-checks' }, opts.map(([k, l]) => el('label', { class: 'f-check' + (sel.includes(k) ? ' on' : '') },
      el('input', { type: 'checkbox', checked: sel.includes(k) ? 'checked' : null, onchange: () => toggle(key, sel, k) }), el('span', {}, l))));
    const from = el('input', { type: 'date', value: p.from || '' }), to = el('input', { type: 'date', value: p.to || '' });
    const csel = el('select', { onchange: () => go({ ...p, customer_id: csel.value }) }, el('option', { value: '' }, 'Tous les clients'),
      lk.clients.map(([v, l]) => el('option', { value: v, selected: String(p.customer_id || '') === String(v) ? 'selected' : null }, l)));
    return el('aside', { class: 'synth-filters' }, el('h2', {}, 'Filtres'),
      el('div', { class: 'f-label' }, 'Client'), csel,
      el('div', { class: 'f-label' }, 'Type de client'), checks('type', selT, Object.entries(TYPES)),
      lk.familles.length ? [el('div', { class: 'f-label' }, 'Famille Fastmag'), checks('famille', selF, lk.familles.map(f => [f, f]))] : null,
      el('div', { class: 'f-label' }, o.dateLabel || 'Dates de facture'),
      el('div', { class: 'f-dates' }, el('label', { class: 'f' }, 'Du', from), el('label', { class: 'f' }, 'Au', to)),
      el('button', { class: 'primary small f-apply', onclick: () => go({ ...p, from: from.value, to: to.value }) }, 'Appliquer les dates'),
      el('button', { class: 'small f-reset', onclick: () => go({}) }, 'Réinitialiser les filtres'),
      o.note ? el('p', { class: 'muted small f-note' }, o.note) : null);
  }
  const filterOf = p => ({ customer_id: p.customer_id || '', famille: p.famille || '', type: p.type || '', from: p.from || '', to: p.to || '', company_id: p.company_id || '' });

  // ------------------------------------------------------------------ tableau de bord
  async function viewDash(view) {
    const p = params();
    const go = np => { location.hash = link('', np); };
    const f = filterOf(p);
    const left = el('div', { class: 'synth-main dash' });
    const asideBox = el('div', { class: 'aside-col' });
    view.append(el('h1', {}, 'Encaissements négoce'), subnav(''), el('div', { class: 'synth-layout' }, left, asideBox));
    asideBox.appendChild(await aside(p, go, { note: 'Les échéances ne dépendent pas des dates de facture ; l\'onglet « Facturé » et les listes, oui.' }));
    const dsh = await rpc('negoce_dashboard', { p: f });
    const cur = 'EUR', today = dsh.today, monday = dsh.semaine_courante;
    const invLink = extra => link('/factures', { ...f, ...extra });
    // cartes
    const w3 = dsh.semaines.slice(0, 3);
    const total3 = w3.reduce((s, w) => s + w.total, 0), n3 = w3.reduce((s, w) => s + w.n, 0), max3 = Math.max(1, ...w3.map(w => w.total));
    const card3 = el('a', { class: 'card brand', href: invLink({ situation: 'a_encaisser,partielle', due_from: monday, due_to: addDays(monday, 20) }) },
      el('div', { class: 'k' }, 'À encaisser dans les 3 prochaines semaines'),
      el('div', { class: 'v' }, money(total3, cur)), el('div', { class: 's' }, `${n3} échéance(s) · du ${d(monday)} au ${d(addDays(monday, 20))}`),
      el('div', { class: 'mini' }, w3.map((w, i) => el('span', {}, el('span', {}, ['Cette semaine', 'Semaine prochaine', 'Dans 2 semaines'][i], ' ', el('span', { class: 'muted' }, `${d(w.semaine).slice(0, 5)} → ${d(addDays(w.semaine, 6)).slice(0, 5)}`)),
        el('b', {}, money(w.total, cur)), el('span', { class: 'bar' }, el('i', { style: `width:${w.total / max3 * 100}%` }))))));
    const r = dsh.retard;
    const cardLate = el('a', { class: 'card ' + (r.total ? 'bad' : 'ok'), href: invLink({ situation: 'en_retard' }) },
      el('div', { class: 'k' }, 'En retard de paiement'), el('div', { class: 'v' }, money(r.total, cur)),
      el('div', { class: 's' }, r.n ? `${r.n} facture(s) · ${r.clients} client(s)` : 'Aucun retard'),
      el('div', { class: 'mini' }, el('span', {}, el('span', {}, 'Encours total ouvert'), el('b', {}, money(dsh.total_ouvert, cur))),
        dsh.avoirs.n ? el('span', {}, el('span', {}, `${dsh.avoirs.n} avoir(s) à imputer`), el('b', {}, money(dsh.avoirs.total, cur))) : null,
        dsh.litiges.n ? el('span', {}, el('span', {}, `${dsh.litiges.n} facture(s) en litige`), el('b', { class: 'fc-bad' }, money(dsh.litiges.total, cur))) : null));
    const mois = dsh.mois; let mi = Math.max(0, mois.findIndex(m => m.mois === today.slice(0, 7)));
    const cardMois = el('div', { class: 'card' });
    const renderMois = () => { const m = mois[mi];
      cardMois.replaceChildren(el('div', { class: 'k' }, 'Échéances du mois', el('span', { class: 'mnav' },
          el('button', { type: 'button', disabled: mi === 0, onclick: () => { mi--; renderMois(); } }, '‹'), el('button', { type: 'button', disabled: mi >= mois.length - 1, onclick: () => { mi++; renderMois(); } }, '›'))),
        el('a', { class: 'v', href: invLink({ due_from: m.mois + '-01', due_to: finMois(m.mois), situation: 'a_encaisser,partielle,en_retard' }) }, money(m.total, cur)),
        el('div', { class: 's' }, el('b', { class: 'cap' }, moisLib(m.mois, true)), ` · ${m.n} échéance(s)` + (m.dont_retard ? ` · ${money(m.dont_retard, cur)} déjà en retard` : ''))); };
    if (mois.length) renderMois();
    left.appendChild(el('div', { class: 'dash-kpis' }, card3, cardLate, cardMois));
    // graphique
    const chartBox = el('div'), note = el('div', { class: 'muted small' });
    const tabs = [
      ['semaines', 'Par semaine', () => { note.textContent = 'Montants à encaisser par semaine d\'échéance (12 prochaines semaines, hors retards). Cliquez un point pour voir les factures.';
        return areaChart(dsh.semaines.slice(0, 12).map(w => ({ label: d(w.semaine).slice(0, 5), v: w.total, href: invLink({ due_from: w.semaine, due_to: addDays(w.semaine, 6), situation: 'a_encaisser,partielle,en_retard' }),
          title: `Semaine du ${d(w.semaine)} : ${money(w.total, cur)} (${w.n})` + (w.clients.length ? ' — ' + w.clients.slice(0, 3).map(c => c.customer_name + ' ' + money(c.total)).join(', ') : '') }))); }],
      ['mois', 'Par mois', () => { note.textContent = 'À encaisser par mois d\'échéance ; les mois passés sont des retards.';
        return areaChart(mois.map(m => ({ label: moisLib(m.mois), v: m.total, cls: m.mois < today.slice(0, 7) ? 'late' : '', href: invLink({ due_from: m.mois + '-01', due_to: finMois(m.mois), situation: 'a_encaisser,partielle,en_retard' }),
          title: `${moisLib(m.mois, true)} : ${money(m.total, cur)} (${m.n})` + (m.dont_retard ? ` — dont retard ${money(m.dont_retard, cur)}` : '') }))); }],
      ['facture', 'Facturé / encaissé', () => { note.textContent = 'Par mois de facture : facturé TTC (orange) et part déjà encaissée (vert) ; les avoirs ne sont pas déduits.';
        const ms = dsh.facture_mensuel.slice(-12);
        return ms.length ? barChart(ms.map(m => ({ label: moisLib(m.mois), values: [{ v: m.encaisse, cls: 'bar-ok', title: `${moisLib(m.mois, true)} — encaissé ${money(m.encaisse, cur)}` }, { v: Math.max(0, m.factures - m.encaisse), cls: 'bar', title: `reste ${money(m.factures - m.encaisse, cur)} sur ${money(m.factures, cur)} facturés` + (m.avoirs ? ` · avoirs ${money(m.avoirs, cur)}` : '') }] })), { h: 230 }) : el('div', { class: 'muted' }, 'Aucune facture sur la période.'); }],
    ];
    const tabBar = el('div', { class: 'tabs' });
    const show = k => { tabBar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === k)); chartBox.replaceChildren(tabs.find(t => t[0] === k)[2]()); };
    tabs.forEach(([k, l]) => tabBar.appendChild(el('button', { type: 'button', 'data-k': k, onclick: () => show(k) }, l)));
    show('semaines');
    left.appendChild(el('div', { class: 'card chart-card' }, el('div', { class: 'card-head' }, el('h2', {}, 'Vue d\'ensemble'), tabBar), chartBox, note));
    // listes
    const listEch = el('div', { class: 'list' }, dsh.prochaines.length ? dsh.prochaines.map(x => el('a', { href: link('/factures/' + x.sales_invoice_id) },
      supAvatar(x.customer_name), el('span', {}, el('div', { class: 't' }, x.customer_name), el('div', { class: 'm' }, `${x.piece} · échéance le ${d(x.due)}` + (x.estimated ? ' (estimée)' : ''))),
      el('span', { class: 'r' }, money(x.amount, cur), el('div', { class: 'm' }, x.due === today ? 'aujourd\'hui' : x.due < addDays(today, 7) ? 'cette semaine' : '')))) : el('div', { class: 'muted' }, 'Aucune échéance à venir.'));
    const listDeb = el('div', { class: 'list' }, dsh.debiteurs.length ? dsh.debiteurs.map(x => el('a', { href: link('/clients/' + x.customer_id) },
      supAvatar(x.customer_name), el('span', {}, el('div', { class: 't' }, x.customer_name), el('div', { class: 'm' }, `${x.n} facture(s) ouverte(s)` + (x.customer_famille ? ' · ' + x.customer_famille : ''))),
      el('span', { class: 'r' }, money(x.total, cur), el('div', { class: 'm' + (x.retard ? ' fc-bad' : '') }, x.retard ? `en retard : ${money(x.retard, cur)}` + (x.plus_ancienne ? ` (depuis le ${d(x.plus_ancienne)})` : '') : 'à jour')))) : el('div', { class: 'muted' }, 'Rien à encaisser.'));
    left.appendChild(el('div', { class: 'grid2 dash-lists' },
      el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, 'Prochaines échéances'), el('a', { class: 'more', href: invLink({ due_from: today, situation: 'a_encaisser,partielle' }) }, 'Tout voir')), listEch),
      el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, 'Clients débiteurs'), el('a', { class: 'more', href: link('/clients') }, 'Tous les clients')), listDeb)));
    if (dsh.promesses.length) left.appendChild(el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, 'Promesses de paiement')),
      el('div', { class: 'list' }, dsh.promesses.map(x => el('a', { href: link('/clients/' + x.customer_id) }, supAvatar(x.customer_name),
        el('span', {}, el('div', { class: 't' }, x.customer_name), el('div', { class: 'm' }, x.text || '')),
        el('span', { class: 'r' }, x.promised_amount ? money(x.promised_amount, cur) : '', el('div', { class: 'm' + (x.promised_date < today ? ' fc-bad' : '') }, 'promis pour le ' + d(x.promised_date))))))));
    left.appendChild(el('div', { class: 'card todo' }, el('div', { class: 'card-head' }, el('h2', {}, 'Mettre à jour')),
      el('div', { class: 'row' }, canWrite() ? el('button', { class: 'small primary', onclick: importFastmag }, 'Importer un export Fastmag') : null,
        el('a', { class: 'btn small', href: link('/factures', { situation: 'a_imputer' }) }, 'Avoirs à imputer' + (dsh.avoirs.n ? ` (${dsh.avoirs.n})` : '')),
        el('a', { class: 'btn small', href: link('/factures', { situation: 'litige' }) }, 'Litiges' + (dsh.litiges.n ? ` (${dsh.litiges.n})` : '')))));
  }

  // ------------------------------------------------------------------ import d'un export Fastmag depuis le navigateur
  const FM = { piece: 'Piece', nature: 'nature', customer_code: 'CLIENT', customer_name: 'NomClient', nom_commercial: 'nomcommercial', famille: 'familleclient', code_externe: 'CodeExterne',
    vat: 'NoTVA', email: 'email', phone: 'Tel1', address: 'Adresse1', city: 'Ville', postal_code: 'CodePostal', country: 'pays', representant: 'NomRepresentant', payment_mode: 'ModReg',
    payment_terms: 'delaireg', store_code: 'codemag', reference_cde: 'referencecde', libelle: 'designation' };
  const fmDate = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec((s || '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : (/^\d{4}-\d{2}-\d{2}/.test(s || '') ? s.slice(0, 10) : null); };
  const fmCents = s => { s = (s || '').trim().replace(/[\s ]/g, ''); if (!s) return null; s = (s.includes(',') && s.includes('.')) ? s.replace(/,/g, '') : s.replace(',', '.'); const v = parseFloat(s); return isNaN(v) ? null : Math.round(v * 100); };
  function parseFastmag(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const head = lines[0].split('\t').map(h => h.trim());
    const idx = Object.fromEntries(head.map((h, i) => [h, i]));
    if (idx.Piece === undefined || idx.nature === undefined) throw new Error('Ce fichier ne ressemble pas à un export de factures Fastmag (colonnes Piece / nature absentes).');
    const rows = [];
    for (const l of lines.slice(1)) {
      const c = l.split('\t'); const g = k => (c[idx[k]] || '').trim();
      if (!g('Piece')) continue;
      const r = {}; for (const [k, col] of Object.entries(FM)) r[k] = g(col);
      r.date = fmDate(g('Date')); r.due_date = fmDate(g('DateEcheance'));
      r.ttc = fmCents(g('TotalTTCNetDevise')) || fmCents(g('TotalTTCDevise')); r.ht = fmCents(g('TotalHTNetDevise')) || fmCents(g('TotalHT'));
      r.credit_limit = fmCents(g('CreditAccorde')) || null; r.blocked = !['', '0'].includes(g('CliBloquer'));
      if (r.date && r.ttc !== null) rows.push(r);
    }
    return rows;
  }
  function importFastmag() {
    const inp = el('input', { type: 'file', accept: '.xls,.txt,.tsv,.csv' });
    const info = el('p', { class: 'muted small' }, 'Fichier texte tabulé exporté de Fastmag (écran des factures de vente). Les pièces déjà connues sont ignorées, les montants et échéances modifiés sont mis à jour.');
    const out = el('div', { class: 'small' });
    modal('Importer un export Fastmag', el('div', {}, info, inp, out), [{ label: 'Importer', fn: async close => {
      const f = inp.files[0]; if (!f) { toast('Choisissez un fichier', true); throw new Error(); }
      const buf = await f.arrayBuffer();
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if (/�/.test(text)) text = new TextDecoder('iso-8859-1').decode(buf);
      const rows = parseFastmag(text);
      out.textContent = `${rows.length} pièce(s) lue(s)…`;
      const tot = {};
      for (let i = 0; i < rows.length; i += 400) {
        const r = await rpc('negoce_import', { p: { rows: rows.slice(i, i + 400) } });
        for (const [k, v] of Object.entries(r)) tot[k] = (tot[k] || 0) + v;
        out.textContent = `${Math.min(i + 400, rows.length)} / ${rows.length} traitées`;
      }
      famillesCache = null;
      toast(`Import terminé : ${tot.pieces_creees || 0} nouvelle(s) pièce(s), ${tot.pieces_mises_a_jour || 0} mise(s) à jour, ${tot.clients_crees || 0} client(s) créé(s)`);
      close(); render();
    } }]);
  }

  // ------------------------------------------------------------------ clients
  async function viewCustomers(view) {
    const p = params();
    const q = el('input', { type: 'search', placeholder: 'Rechercher un client…', value: p.q || '' });
    const showAll = el('input', { type: 'checkbox', checked: p.all ? 'checked' : null });
    view.append(el('h1', {}, 'Clients négoce'), subnav('/clients'));
    const box = el('div', { class: 'panel' }); view.appendChild(box);
    const load = async () => {
      const cs = await rpc('negoce_customers', { p: { q: q.value, all: showAll.checked } });
      const tot = cs.reduce((a, c) => ({ enc: a.enc + c.encours, ret: a.ret + c.retard, av: a.av + c.avoirs }), { enc: 0, ret: 0, av: 0 });
      box.replaceChildren(el('div', { class: 'row', style: 'margin-bottom:12px;align-items:center' }, q, el('label', { class: 'f-inline' }, showAll, ' Inclure les clients inactifs'),
          el('span', { class: 'muted small' }, `${cs.length} client(s) · encours ${money(tot.enc)} · en retard ${money(tot.ret)} · avoirs ${money(tot.av)}`)),
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Client'), el('th', {}, 'Famille'), el('th', {}, 'Type'), el('th', {}, 'Règlement'), el('th', { class: 'num' }, 'Encours'),
            el('th', { class: 'num' }, 'En retard'), el('th', { class: 'num' }, 'Avoirs'), el('th', {}, 'Prochaine échéance'), el('th', {}, 'Dernière facture'))),
          el('tbody', {}, cs.map(c => el('tr', { class: 'clickable', onclick: () => { location.hash = link('/clients/' + c.id); } },
            el('td', {}, el('div', { class: 'cell-av' }, supAvatar(c.name, 'sm'), el('span', {}, c.name, c.blocked ? el('span', { class: 'badge b-bad', style: 'margin-left:6px' }, 'Bloqué') : null, c.active ? null : el('span', { class: 'badge', style: 'margin-left:6px' }, 'Inactif')))),
            el('td', {}, c.famille || '—'), el('td', {}, TYPES[c.type] || c.type), el('td', {}, mode(c.payment_mode) + (c.payment_terms ? ' · ' + c.payment_terms : '')),
            el('td', { class: 'num' }, money(c.encours)), el('td', { class: 'num' + (c.retard ? ' fc-bad' : '') }, c.retard ? money(c.retard) : '—'), el('td', { class: 'num' }, c.avoirs ? money(c.avoirs) : '—'),
            el('td', {}, c.prochaine_echeance ? d(c.prochaine_echeance) : '—'), el('td', {}, d(c.derniere_facture)))))));
    };
    let t; q.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); }; showAll.onchange = load;
    await load();
  }

  async function viewCustomer(view, id) {
    const cs = await rpc('negoce_customers', { p: { all: true } });
    const c = cs.find(x => x.id === id);
    if (!c) { view.appendChild(el('div', { class: 'panel empty' }, 'Client introuvable.')); return; }
    const dsh = await rpc('negoce_dashboard', { p: { customer_id: id } });
    const inv = await rpc('negoce_invoices', { p: { customer_id: id, limit: 1000 } });
    view.append(el('div', { class: 'crumb' }, el('a', { href: link('/clients') }, 'Clients négoce'), ' › ', c.name),
      el('h1', { class: 'with-av' }, supAvatar(c.name), c.name, el('span', { class: 'muted small' }, c.famille || '', c.code ? ` · code Fastmag ${c.code}` : '')));
    const kpi = (lab, v, cls) => el('div', { class: 'kpi ' + (cls || '') }, el('div', { class: 'l' }, lab), el('div', { class: 'v' }, v));
    view.appendChild(el('div', { class: 'kpis' }, kpi('Encours', money(c.encours)), kpi('En retard', money(c.retard), c.retard ? 'bad' : 'ok'), kpi('Avoirs disponibles', money(c.avoirs), c.avoirs ? 'warn' : ''),
      kpi('CA 12 mois (TTC)', money(c.ca_12m)), kpi('Prochaine échéance', c.prochaine_echeance ? d(c.prochaine_echeance) : '—')));
    // fiche + actions
    const sel = (name, opts, val) => el('select', { name }, opts.map(([v, l]) => el('option', { value: v, selected: String(val || '') === String(v) ? 'selected' : null }, l)));
    const fType = sel('type', Object.entries(TYPES), c.type), fMode = sel('payment_mode', [['', '—'], ...Object.entries(MODES)], c.payment_mode);
    const fTerms = el('input', { value: c.payment_terms || '', placeholder: '45J, 60J, 45FDM…' }), fActive = el('input', { type: 'checkbox', checked: c.active ? 'checked' : null });
    const fNotes = el('textarea', { rows: 3 }, c.notes || '');
    const save = () => act(() => rpc('negoce_customer_update', { p_id: id, p_changes: { type: fType.value, payment_mode: fMode.value, payment_terms: fTerms.value, active: fActive.checked, notes: fNotes.value } }), 'Client enregistré').then(() => { famillesCache = null; });
    const fiche = el('div', { class: 'panel' }, el('h2', {}, 'Fiche client'),
      el('div', { class: 'grid2' },
        el('div', {}, el('label', { class: 'f' }, 'Type', fType), el('label', { class: 'f' }, 'Mode de règlement habituel', fMode), el('label', { class: 'f' }, 'Délai de paiement', fTerms),
          el('label', { class: 'f-inline' }, fActive, ' Client actif')),
        el('div', {}, el('label', { class: 'f' }, 'Notes', fNotes), el('div', { class: 'muted small' }, [c.representant ? 'Représentant : ' + c.representant : null].filter(Boolean).join(' · ')))),
      canWrite() ? el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: save }, 'Enregistrer'),
        el('button', { onclick: () => receiptModal(c, inv.items.filter(i => i.doc_type === 'facture' && i.balance > 0 && i.status === 'ouverte')) }, 'Enregistrer un encaissement'),
        el('button', { onclick: () => noteModal(c) }, 'Relance / promesse')) : null);
    // graphique facturé / encaissé
    const ms = dsh.facture_mensuel.slice(-12);
    const chart = el('div', { class: 'panel' }, el('h2', {}, 'Facturé et encaissé par mois'),
      ms.length ? barChart(ms.map(m => ({ label: moisLib(m.mois), values: [{ v: m.encaisse, cls: 'bar-ok', title: `${moisLib(m.mois, true)} — encaissé ${money(m.encaisse)}` }, { v: Math.max(0, m.factures - m.encaisse), cls: 'bar', title: `reste ${money(m.factures - m.encaisse)} sur ${money(m.factures)}` }] })), { h: 200 }) : el('div', { class: 'muted' }, 'Aucune facture.'),
      el('div', { class: 'legend' }, el('span', {}, el('i', { style: 'background:#3ecf8e' }), 'Encaissé'), el('span', {}, el('i', { style: 'background:#ff6b1a' }), 'Reste à encaisser')));
    view.appendChild(el('div', { class: 'grid2' }, fiche, chart));
    // factures
    const open = inv.items.filter(i => i.balance > 0 && i.status !== 'annulee');
    view.appendChild(invoiceTable(open, 'Pièces ouvertes (' + open.length + ')', true));
    const closed = inv.items.filter(i => !(i.balance > 0 && i.status !== 'annulee'));
    if (closed.length) { const det = el('details', {}, el('summary', {}, `Pièces soldées ou annulées (${closed.length})`)); det.appendChild(invoiceTable(closed, null)); view.appendChild(el('div', { class: 'panel' }, det)); }
  }

  function invoiceTable(items, title, withChecks) {
    const tbody = el('tbody', {}, items.map(i => el('tr', { class: 'clickable' + (i.situation === 'en_retard' ? ' row-bad' : ''), onclick: () => { location.hash = link('/factures/' + i.id); } },
      el('td', {}, i.piece, i.installments ? el('span', { class: 'badge b-info', style: 'margin-left:6px', title: 'Plan de règlement' }, `${i.installments} éch.`) : null),
      el('td', {}, i.doc_type === 'avoir' ? 'Avoir' : 'Facture'), el('td', {}, d(i.invoice_date)),
      el('td', {}, i.doc_type === 'avoir' ? '—' : d(i.last_due || i.due_date) + (i.due_estimated ? ' *' : '')), el('td', {}, mode(i.payment_mode)),
      el('td', { class: 'num' }, money(i.amount_ttc)), el('td', { class: 'num' }, money(i.balance)), el('td', {}, sit(i.situation)))));
    return el('div', { class: 'panel' }, title ? el('h2', {}, title) : null,
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Pièce'), el('th', {}, 'Type'), el('th', {}, 'Date'), el('th', {}, 'Échéance'), el('th', {}, 'Mode'), el('th', { class: 'num' }, 'TTC'), el('th', { class: 'num' }, 'Solde'), el('th', {}, 'Situation'))), tbody),
      items.some(i => i.due_estimated) ? el('div', { class: 'muted small' }, '* échéance absente de Fastmag, estimée à partir du délai de paiement.') : null);
  }

  function receiptModal(c, openInvoices, preset) {
    const date = el('input', { type: 'date', value: isoDate(new Date()) }), amount = el('input', { placeholder: '0,00', value: preset ? moneyIn(preset.amount) : '' });
    const method = el('select', {}, [['Virement', 'Virement'], ['Prélèvement', 'Prélèvement'], ['LCR', 'LCR'], ['Chèque', 'Chèque'], ['Compensation', 'Compensation'], ['Autre', 'Autre']].map(([v, l]) => el('option', { value: v }, l)));
    const ref = el('input', { placeholder: 'Référence (libellé banque, n° de remise…)' }), com = el('input', { placeholder: 'Commentaire' });
    const checks = openInvoices.map(i => ({ i, cb: el('input', { type: 'checkbox', checked: preset && preset.ids && preset.ids.includes(i.id) ? 'checked' : null }) }));
    const total = el('span', { class: 'muted small' });
    const upd = () => { const s = checks.filter(x => x.cb.checked).reduce((a, x) => a + x.i.balance, 0); total.textContent = s ? `Factures cochées : ${money(s)}` : 'Aucune facture cochée : imputation automatique de la plus ancienne à la plus récente.'; if (s && !amount.value) amount.value = moneyIn(s); };
    checks.forEach(x => x.cb.onchange = upd); upd();
    const list = el('div', { class: 'check-list' }, checks.map(x => el('label', { class: 'f-inline' }, x.cb, ` ${x.i.piece} · ${d(x.i.due_date)} · solde ${money(x.i.balance)}`)));
    modal('Encaissement — ' + c.name, el('div', {},
      el('div', { class: 'grid2' }, el('label', { class: 'f' }, 'Date', date), el('label', { class: 'f' }, 'Montant encaissé (€)', amount)),
      el('div', { class: 'grid2' }, el('label', { class: 'f' }, 'Mode', method), el('label', { class: 'f' }, 'Référence', ref)),
      el('label', { class: 'f' }, 'Commentaire', com), el('h3', {}, 'Factures réglées'), total, list),
      [{ label: 'Enregistrer', fn: async close => {
        const amt = toCents(amount.value); if (!amt || amt <= 0) { toast('Montant invalide', true); throw new Error(); }
        let rest = amt; const allocs = [];
        for (const x of checks) { if (!x.cb.checked || rest <= 0) continue; const a = Math.min(rest, x.i.balance); allocs.push({ sales_invoice_id: x.i.id, amount: a }); rest -= a; }
        const r = await act(() => rpc('negoce_receipt_add', { p: { customer_id: c.id, date: date.value, amount: amt, method: method.value, reference: ref.value, comment: com.value, allocations: allocs } }));
        toast(`Encaissement enregistré : ${r.factures_lettrees} facture(s) lettrée(s)` + (r.non_impute ? ` — ${money(r.non_impute)} non imputé (acompte)` : ''));
        close(); render();
      } }]);
  }

  function noteModal(c, invoiceId) {
    const kind = el('select', {}, [['relance', 'Relance'], ['promesse', 'Promesse de paiement'], ['litige', 'Litige'], ['note', 'Note']].map(([v, l]) => el('option', { value: v }, l)));
    const pd = el('input', { type: 'date' }), pa = el('input', { placeholder: 'Montant promis (€)' }), txt = el('textarea', { rows: 3, placeholder: 'Qui, quoi, quand…' });
    modal('Relance / promesse — ' + c.name, el('div', {}, el('label', { class: 'f' }, 'Type', kind), el('div', { class: 'grid2' }, el('label', { class: 'f' }, 'Date promise', pd), el('label', { class: 'f' }, 'Montant promis', pa)), el('label', { class: 'f' }, 'Texte', txt)),
      [{ label: 'Enregistrer', fn: async close => { await act(() => rpc('negoce_note_add', { p: { customer_id: c.id, sales_invoice_id: invoiceId || null, kind: kind.value, promised_date: pd.value || null, promised_amount: toCents(pa.value), text: txt.value } }), 'Enregistré'); close(); render(); } }]);
  }

  // ------------------------------------------------------------------ factures de vente
  async function viewInvoices(view) {
    const p = params();
    const go = np => { location.hash = link('/factures', np); };
    const f = { ...filterOf(p), situation: p.situation || '', due_from: p.due_from || '', due_to: p.due_to || '', q: p.q || '', doc_type: p.doc_type || '', limit: 300, offset: +(p.offset || 0) };
    const left = el('div', { class: 'synth-main' }), asideBox = el('div', { class: 'aside-col' });
    view.append(el('h1', {}, 'Factures de vente'), subnav('/factures'), el('div', { class: 'synth-layout' }, left, asideBox));
    asideBox.appendChild(await aside(p, go, {}));
    const res = await rpc('negoce_invoices', { p: f });
    const q = el('input', { type: 'search', placeholder: 'N° de pièce, client, référence…', value: p.q || '' });
    q.onchange = () => go({ ...p, q: q.value, offset: '' });
    const sitSel = el('select', { onchange: () => go({ ...p, situation: sitSel.value, offset: '' }) }, el('option', { value: '' }, 'Toutes situations'),
      [['a_encaisser,partielle,en_retard', 'Ouvertes'], ...Object.entries(SIT).map(([k, v]) => [k, v[0]])].map(([v, l]) => el('option', { value: v, selected: (p.situation || '') === v ? 'selected' : null }, l)));
    const dueFrom = el('input', { type: 'date', value: p.due_from || '' }), dueTo = el('input', { type: 'date', value: p.due_to || '' });
    left.appendChild(el('div', { class: 'panel' }, el('div', { class: 'row' }, q, sitSel, el('label', { class: 'f' }, 'Échéance du', dueFrom), el('label', { class: 'f' }, 'au', dueTo),
      el('button', { class: 'small', onclick: () => go({ ...p, due_from: dueFrom.value, due_to: dueTo.value, offset: '' }) }, 'Filtrer'),
      canWrite() ? el('button', { class: 'small primary', onclick: importFastmag }, 'Importer Fastmag') : null),
      el('div', { class: 'muted small', style: 'margin-top:8px' }, `${res.total} pièce(s) · TTC net ${money(res.sum_ttc)} · solde net ${money(res.sum_balance)}`)));
    const tbody = el('tbody', {}, res.items.map(i => el('tr', { class: 'clickable' + (i.situation === 'en_retard' ? ' row-bad' : ''), onclick: () => { location.hash = link('/factures/' + i.id); } },
      el('td', {}, i.piece, i.installments ? el('span', { class: 'badge b-info', style: 'margin-left:6px' }, `${i.installments} éch.`) : null),
      el('td', {}, el('a', { href: link('/clients/' + i.customer_id), onclick: e => e.stopPropagation() }, i.customer_name)), el('td', {}, i.doc_type === 'avoir' ? 'Avoir' : 'Facture'),
      el('td', {}, d(i.invoice_date)), el('td', {}, i.doc_type === 'avoir' ? '—' : d(i.last_due || i.due_date) + (i.due_estimated ? ' *' : '')), el('td', {}, mode(i.payment_mode)),
      el('td', { class: 'num' }, money(i.amount_ttc)), el('td', { class: 'num' }, money(i.balance)), el('td', {}, sit(i.situation)))));
    left.appendChild(el('div', { class: 'panel' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Pièce'), el('th', {}, 'Client'), el('th', {}, 'Type'), el('th', {}, 'Date'), el('th', {}, 'Échéance'), el('th', {}, 'Mode'), el('th', { class: 'num' }, 'TTC'), el('th', { class: 'num' }, 'Solde'), el('th', {}, 'Situation'))), tbody),
      res.total > f.limit ? el('div', { class: 'row', style: 'margin-top:10px' }, f.offset > 0 ? el('button', { class: 'small', onclick: () => go({ ...p, offset: Math.max(0, f.offset - f.limit) }) }, '‹ Précédent') : null,
        el('span', { class: 'muted small' }, `${f.offset + 1}–${Math.min(res.total, f.offset + f.limit)} sur ${res.total}`),
        f.offset + f.limit < res.total ? el('button', { class: 'small', onclick: () => go({ ...p, offset: f.offset + f.limit }) }, 'Suivant ›') : null) : null));
  }

  async function viewInvoice(view, id) {
    const data = await rpc('negoce_invoice_get', { p_id: id });
    if (!data) { view.appendChild(el('div', { class: 'panel empty' }, 'Pièce introuvable.')); return; }
    const v = data.invoice;
    view.append(el('div', { class: 'crumb' }, el('a', { href: link('/factures') }, 'Factures de vente'), ' › ', el('a', { href: link('/clients/' + v.customer_id) }, v.customer_name), ' › ', v.piece),
      el('h1', {}, (v.doc_type === 'avoir' ? 'Avoir ' : 'Facture ') + v.piece, ' ', sit(v.situation)));
    const row = (k, val) => el('tr', {}, el('th', {}, k), el('td', {}, val));
    const infos = el('div', { class: 'panel' }, el('h2', {}, 'Pièce'), el('table', { class: 'kv' }, el('tbody', {},
      row('Client', el('a', { href: link('/clients/' + v.customer_id) }, v.customer_name)), row('Date', d(v.invoice_date)),
      row('Échéance', v.doc_type === 'avoir' ? '—' : d(v.due_date) + (v.due_estimated ? ' (estimée)' : '')), row('Mode / délai', mode(v.payment_mode) + (v.payment_terms ? ' · ' + v.payment_terms : '')),
      row('Montant HT', money(v.amount_ht)), row('TVA', money(v.amount_tva)), row('Montant TTC', money(v.amount_ttc)),
      row(v.doc_type === 'avoir' ? 'Reste à imputer' : 'Reste à encaisser', el('b', {}, money(v.balance))),
      v.reference_cde ? row('Référence commande', v.reference_cde) : null, v.store_code ? row('Magasin / dépôt', v.store_code) : null, v.representant ? row('Représentant', v.representant) : null,
      row('Source', v.source + (v.status === 'litige' && v.litige_reason ? ' · litige : ' + v.litige_reason : '')))));
    // échéancier
    const plan = el('div', { class: 'panel' });
    const renderPlan = () => {
      const items = data.installments;
      plan.replaceChildren(el('h2', {}, 'Échéancier'), items.length ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Échéance'), el('th', { class: 'num' }, 'Montant'), el('th', {}, 'Mode'), el('th', {}, 'Commentaire'))),
        el('tbody', {}, items.map(s => el('tr', {}, el('td', {}, d(s.due_date)), el('td', { class: 'num' }, money(s.amount)), el('td', {}, mode(s.payment_mode)), el('td', {}, s.comment || '')))))
        : el('p', { class: 'muted' }, v.doc_type === 'avoir' ? 'Un avoir n\'a pas d\'échéance.' : `Échéance unique le ${d(v.due_date)}. Vous pouvez la découper en plusieurs règlements (plan de financement).`),
        canWrite() && v.doc_type === 'facture' ? el('div', { class: 'actions' }, el('button', { onclick: () => planModal(v, items) }, items.length ? 'Modifier le plan' : 'Créer un plan de règlement'),
          items.length ? el('button', { class: 'danger', onclick: () => act(() => rpc('negoce_installments_set', { p_invoice: v.id, p_items: [] }), 'Plan supprimé').then(render) }, 'Supprimer le plan') : null) : null);
    };
    renderPlan();
    // encaissements / imputations
    const allocs = el('div', { class: 'panel' }, el('h2', {}, v.doc_type === 'avoir' ? 'Imputations de cet avoir' : 'Encaissements imputés'),
      data.allocations.length ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Mode'), el('th', {}, 'Référence'), el('th', { class: 'num' }, 'Montant'), el('th', {}))),
        el('tbody', {}, data.allocations.map(a => el('tr', {}, el('td', {}, d(a.date)), el('td', {}, a.credit_id ? 'Avoir' : (a.method || '—')), el('td', {}, a.reference || ''), el('td', { class: 'num' }, money(a.amount)),
          el('td', {}, canWrite() ? el('button', { class: 'small danger', onclick: () => confirmBox('Retirer cette imputation ?', 'La facture redeviendra ouverte pour ce montant.', 'Retirer', async () => { await rpc('negoce_allocation_delete', { p_id: a.id }); render(); }) }, 'Retirer') : null)))))
        : el('p', { class: 'muted' }, 'Aucun encaissement imputé.'),
      canWrite() ? el('div', { class: 'actions' },
        v.doc_type === 'facture' && v.balance > 0 ? el('button', { class: 'primary', onclick: async () => { const inv = await rpc('negoce_invoices', { p: { customer_id: v.customer_id, situation: 'a_encaisser,partielle,en_retard', limit: 500 } }); receiptModal({ id: v.customer_id, name: v.customer_name }, inv.items, { ids: [v.id], amount: v.balance }); } }, 'Enregistrer un encaissement') : null,
        v.doc_type === 'facture' && v.balance > 0 ? el('button', { onclick: () => creditModal(v) }, 'Imputer un avoir') : null,
        v.doc_type === 'avoir' && v.balance > 0 ? el('button', { onclick: () => creditTargetModal(v) }, 'Imputer sur une facture') : null,
        el('button', { onclick: () => noteModal({ id: v.customer_id, name: v.customer_name }, v.id) }, 'Relance / promesse'),
        v.status !== 'litige' ? el('button', { onclick: () => { const r = el('input', { placeholder: 'Motif' }); modal('Mettre en litige', el('label', { class: 'f' }, 'Motif du litige', r), [{ label: 'Confirmer', cls: 'danger', fn: async close => { await act(() => rpc('negoce_invoice_set_status', { p_id: v.id, p_status: 'litige', p_reason: r.value })); close(); render(); } }]); } }, 'Litige') : el('button', { onclick: () => act(() => rpc('negoce_invoice_set_status', { p_id: v.id, p_status: 'ouverte' })).then(render) }, 'Lever le litige'),
        v.status !== 'annulee' ? el('button', { class: 'danger', onclick: () => confirmBox('Annuler cette pièce ?', 'Elle ne comptera plus dans l\'encours (réversible).', 'Annuler la pièce', async () => { await rpc('negoce_invoice_set_status', { p_id: v.id, p_status: 'annulee' }); render(); }) }, 'Annuler la pièce')
          : el('button', { onclick: () => act(() => rpc('negoce_invoice_set_status', { p_id: v.id, p_status: 'ouverte' })).then(render) }, 'Rouvrir')) : null);
    view.appendChild(el('div', { class: 'grid2' }, infos, el('div', {}, plan, allocs)));
    if (data.notes.length) view.appendChild(el('div', { class: 'panel' }, el('h2', {}, 'Relances et notes'), el('ul', {}, data.notes.map(n => el('li', {}, `${d(n.date)} — ${n.kind}` + (n.promised_date ? ` (promis pour le ${d(n.promised_date)}${n.promised_amount ? ', ' + money(n.promised_amount) : ''})` : '') + (n.text ? ' : ' + n.text : ''))))));
  }

  function planModal(v, existing) {
    const rows = el('div', { class: 'plan-rows' });
    const total = el('div', { class: 'small' });
    const addRow = (due, amt, m) => {
      const dd = el('input', { type: 'date', value: due || '' }), aa = el('input', { value: amt ? moneyIn(amt) : '', placeholder: '0,00' }), mm = el('input', { value: m || '', placeholder: 'Mode (VIR, LCR…)' });
      const r = el('div', { class: 'plan-row' }, dd, aa, mm, el('button', { class: 'small danger', type: 'button', onclick: () => { r.remove(); upd(); } }, '×'));
      aa.oninput = upd; rows.appendChild(r); upd();
    };
    const upd = () => { const s = [...rows.querySelectorAll('.plan-row')].reduce((a, r) => a + (toCents(r.children[1].value) || 0), 0); const diff = v.amount_ttc - s;
      total.textContent = `Total des échéances : ${money(s)} — facture : ${money(v.amount_ttc)}` + (diff ? ` — écart ${money(diff)}` : ' ✓'); total.className = 'small ' + (diff ? 'fc-bad' : 'fc-ok'); };
    if (existing.length) existing.forEach(s => addRow(s.due_date, s.amount, s.payment_mode)); else { addRow(v.due_date, Math.round(v.amount_ttc / 2)); addRow(v.due_date ? addDays(v.due_date, 30) : '', v.amount_ttc - Math.round(v.amount_ttc / 2)); }
    modal('Plan de règlement — ' + v.piece, el('div', {}, el('p', { class: 'muted small' }, 'Découpez la facture en plusieurs échéances. Le total doit être égal au TTC. Le prévisionnel et les retards suivront ces dates.'),
      el('div', { class: 'plan-head' }, el('span', {}, 'Date'), el('span', {}, 'Montant (€)'), el('span', {}, 'Mode'), el('span')), rows,
      el('button', { class: 'small', type: 'button', onclick: () => addRow('', 0) }, '+ Ajouter une échéance'), total),
      [{ label: 'Enregistrer le plan', fn: async close => {
        const items = [...rows.querySelectorAll('.plan-row')].map(r => ({ due_date: r.children[0].value, amount: toCents(r.children[1].value) || 0, payment_mode: r.children[2].value })).filter(x => x.amount > 0);
        if (items.some(x => !x.due_date)) { toast('Chaque échéance doit avoir une date', true); throw new Error(); }
        await act(() => rpc('negoce_installments_set', { p_invoice: v.id, p_items: items }), 'Plan enregistré'); close(); render();
      } }]);
  }

  async function creditModal(v) {
    const res = await rpc('negoce_invoices', { p: { customer_id: v.customer_id, doc_type: 'avoir', situation: 'a_imputer', limit: 200 } });
    if (!res.items.length) { toast('Aucun avoir disponible pour ce client', true); return; }
    const sel = el('select', {}, res.items.map(a => el('option', { value: a.id }, `${a.piece} · ${d(a.invoice_date)} · disponible ${money(a.balance)}`)));
    modal('Imputer un avoir sur ' + v.piece, el('label', { class: 'f' }, 'Avoir', sel), [{ label: 'Imputer', fn: async close => { await act(() => rpc('negoce_credit_allocate', { p_credit: +sel.value, p_invoice: v.id, p_amount: null }), 'Avoir imputé'); close(); render(); } }]);
  }
  async function creditTargetModal(av) {
    const res = await rpc('negoce_invoices', { p: { customer_id: av.customer_id, doc_type: 'facture', situation: 'a_encaisser,partielle,en_retard', limit: 300 } });
    if (!res.items.length) { toast('Aucune facture ouverte pour ce client', true); return; }
    const sel = el('select', {}, res.items.map(i => el('option', { value: i.id }, `${i.piece} · ${d(i.due_date)} · solde ${money(i.balance)}`)));
    modal('Imputer l\'avoir ' + av.piece, el('label', { class: 'f' }, 'Facture', sel), [{ label: 'Imputer', fn: async close => { await act(() => rpc('negoce_credit_allocate', { p_credit: av.id, p_invoice: +sel.value, p_amount: null }), 'Avoir imputé'); close(); render(); } }]);
  }

  // ------------------------------------------------------------------ encaissements (liste des règlements reçus)
  async function viewReceipts(view) {
    view.append(el('h1', {}, 'Encaissements reçus'), subnav('/encaissements'));
    const res = await rpc('negoce_invoices', { p: { situation: 'encaissee,partielle', limit: 1000 } }).catch(() => ({ items: [] }));
    const paid = res.items.filter(i => i.paid > 0);
    view.appendChild(el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'Les encaissements se saisissent depuis la fiche d\'un client ou d\'une facture ; le rapprochement automatique avec la banque arrivera dans une prochaine étape.'),
      paid.length ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Client'), el('th', {}, 'Pièce'), el('th', {}, 'Échéance'), el('th', { class: 'num' }, 'TTC'), el('th', { class: 'num' }, 'Encaissé'), el('th', { class: 'num' }, 'Solde'))),
        el('tbody', {}, paid.map(i => el('tr', { class: 'clickable', onclick: () => { location.hash = link('/factures/' + i.id); } }, el('td', {}, i.customer_name), el('td', {}, i.piece), el('td', {}, d(i.due_date)), el('td', { class: 'num' }, money(i.amount_ttc)), el('td', { class: 'num fc-ok' }, money(i.paid)), el('td', { class: 'num' }, money(i.balance))))))
        : el('div', { class: 'muted' }, 'Aucun encaissement enregistré pour le moment.')));
  }

  async function renderRoute(view, parts) {
    if (parts[1] === 'clients' && parts[2]) return viewCustomer(view, +parts[2]);
    if (parts[1] === 'clients') return viewCustomers(view);
    if (parts[1] === 'factures' && parts[2]) return viewInvoice(view, +parts[2]);
    if (parts[1] === 'factures') return viewInvoices(view);
    if (parts[1] === 'encaissements') return viewReceipts(view);
    return viewDash(view);
  }
  return { render: renderRoute };
})();

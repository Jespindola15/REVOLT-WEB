// Interfaz del menú (Fase 1): pantallas separadas, navegación con mouse, teclado y joystick, pausa.
// No toca la lógica del juego: todo lo que necesita del juego lo recibe en "api" desde main.js.
//
//   Teclado:  ↑ ↓ moverse · ← → cambiar opción (o de auto en el garage) · Enter aceptar · Esc volver / pausa
//   Joystick: cruceta o stick · A aceptar · B volver · LB/RB grupo de autos · Start pausa

const FOCUSABLE = 'button, input, summary';

export function initUI(api) {
  const $ = id => document.getElementById(id);
  const body = document.body;
  const menu = $('scr-menu'), pause = $('pause');
  const pages = [...menu.querySelectorAll('.page')];
  const optBody = $('opt-body');
  let page = 'home', stack = [], lastHome = null;
  // Recorrido para armar la carrera: AUTO → PISTA → REGLAS (o salida, en la práctica). null = página suelta
  let flow = null;
  const FLOWS = {
    race: [['garage', 'Auto'], ['tracks', 'Pista'], ['race', 'Reglas']],
    practice: [['garage', 'Auto'], ['tracks', 'Pista'], ['practice', 'Salida']],
  };

  const sfx = (name, o = {}) => { try { api.audio.play(name, o); } catch (e) {} };
  const visible = el => !!el && !el.disabled && el.getClientRects().length > 0 && !el.closest('[hidden]');

  // ---------- Páginas del menú ----------
  const pageEl = (p = page) => pages.find(el => el.dataset.page === p);
  function goPage(p, { sound = true, back = false } = {}) {
    if (!pageEl(p)) p = 'home';
    if (!back && p !== page && page !== 'home') stack.push(page);
    if (p === 'home') stack = [];
    page = p;
    for (const el of pages) el.hidden = el.dataset.page !== p;
    const cur = pageEl();
    // las opciones son una sola: se mudan a la página que se abre (menú o pausa)
    const os = cur.querySelector('.opt-slot');
    if (os && !os.contains(optBody)) os.appendChild(optBody);
    if (p === 'options') syncOptions();
    if (p === 'home') flow = null;
    if (p === 'garage') requestAnimationFrame(() => { const st = $('g-strip'), sel = st.querySelector('[aria-selected=true]'); if (sel) st.scrollLeft = Math.max(0, sel.offsetLeft - (st.clientWidth - sel.offsetWidth) / 2); });
    renderSteps(cur);
    refreshSummary();
    if (p === 'tracks') openTracks();
    layoutScene();
    if (sound) sfx(back || p === 'home' ? 'menuupdown' : 'menunext', { vol: 0.55, rate: back || p === 'home' ? 0.85 : 1 });
    focusDefault(cur, p === 'home' ? lastHome : p === 'tracks' ? $('tracksel').querySelector('[aria-pressed=true]') : null);
  }
  function goBack() {
    const prev = stack.pop() || 'home';
    goPage(prev, { back: true });
  }
  // ir a un paso del recorrido (si ya pasaste por ahí, es como volver)
  function goStep(p) {
    const i = stack.lastIndexOf(p);
    if (i >= 0) { stack = stack.slice(0, i); goPage(p, { back: true }); } else goPage(p);
  }
  // botón grande del garage y de las pistas: en el recorrido, "siguiente"; si no, elegir y volver
  function flowNext(from) {
    const f = flow && FLOWS[flow], i = f ? f.findIndex(x => x[0] === from) : -1;
    if (f && f[i + 1]) goStep(f[i + 1][0]); else goBack();
  }
  function renderSteps(cur) {
    // textos de los botones grandes según el paso
    $('g-choose').textContent = flow ? 'Siguiente: pista ▶' : 'Elegir';
    $('t-choose').textContent = flow === 'race' ? 'Siguiente: reglas ▶' : flow === 'practice' ? 'Siguiente ▶' : 'Elegir';
    const ol = cur.querySelector('.steps'); if (!ol) return;
    const f = flow && FLOWS[flow];
    const i = f ? f.findIndex(x => x[0] === page) : -1;
    ol.hidden = i < 0;
    if (i < 0) return;
    ol.innerHTML = f.map(([p, label], k) => `<li class="${k < i ? 'done' : k === i ? 'cur' : ''}"><button type="button" data-step="${p}" ${k === i ? 'aria-current="step"' : ''}><em>${k + 1}</em>${label}</button></li>`).join('');
  }

  // ---------- Foco ----------
  function focusables(root) { return [...root.querySelectorAll(FOCUSABLE)].filter(visible); }
  function focusEl(el, sound = false) {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (sound) sfx('menuupdown', { vol: 0.4 });
  }
  function defaultIn(root) {
    if (root === $('scr-lobby')) return [$('btn-start'), $('btn-ready')].find(visible);
    if (root === $('scr-results')) return [$('btn-cup-next'), $('btn-res-back')].find(visible);
    if (root === pageEl('home') && visible(lastHome)) return lastHome;
    return [...root.querySelectorAll('[data-default]')].find(visible) || root.querySelector('.mm-item') && [...root.querySelectorAll('.mm-item')].find(visible) || focusables(root).find(e => e.tagName !== 'INPUT');
  }
  function focusDefault(root, prefer) {
    if (!root) return;
    // en celular no se enfoca nada (no abrir el teclado ni marcar botones)
    if (!body.classList.contains('kbd-nav') && matchMedia('(pointer: coarse)').matches) return;
    focusEl(visible(prefer) ? prefer : defaultIn(root));
  }
  // ¿dónde se navega ahora? (null = manejando: las teclas son del juego)
  function navRoot() {
    if (!pause.hidden) return pause.querySelector('.page:not([hidden])');
    const m = api.G.mode;
    if (m === 'menu' && !menu.hidden) return pageEl();
    if (m === 'lobby') return $('scr-lobby');
    if (m === 'results') return $('scr-results');
    return null;
  }

  // movimiento espacial: el elemento más cercano en esa dirección (sirve para listas, grillas y filas)
  function move(dir, root) {
    const list = focusables(root); if (!list.length) return false;
    const cur = document.activeElement;
    if (!list.includes(cur)) { focusEl(defaultIn(root) || list[0], true); return true; }
    const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bs = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const q = el.getBoundingClientRect(), x = q.left + q.width / 2, y = q.top + q.height / 2;
      let main, gap;
      if (dir === 'down' || dir === 'up') {
        main = dir === 'down' ? y - cy : cy - y;
        if (main < 6 || (dir === 'down' ? q.top < r.top + 4 : q.bottom > r.bottom - 4)) continue;
        gap = Math.max(0, q.left - r.right, r.left - q.right);
      } else {
        main = dir === 'right' ? x - cx : cx - x;
        if (main < 6 || (dir === 'right' ? q.left < r.left + 4 : q.right > r.right - 4)) continue;
        gap = Math.max(0, q.top - r.bottom, r.top - q.bottom);
      }
      const score = main + gap * 3 + Math.abs(dir === 'up' || dir === 'down' ? x - cx : y - cy) * 0.05;
      if (score < bs) { bs = score; best = el; }
    }
    // en las listas del menú principal y la pausa se da la vuelta
    if (!best && (dir === 'up' || dir === 'down') && root.querySelector('.mm')) best = dir === 'down' ? list[0] : list[list.length - 1];
    if (!best) return false;
    focusEl(best, true);
    return true;
  }

  // ← → : opciones (cambian al moverse), sliders, auto en el garage o movimiento normal
  function horiz(d, root, fromPad) {
    const cur = document.activeElement;
    if (cur?.type === 'range' && root.contains(cur)) {
      if (!fromPad) return 'native';
      const st = +cur.step || 1, v = Math.min(+cur.max, Math.max(+cur.min, +cur.value + d * st));
      if (v !== +cur.value) { cur.value = v; cur.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    }
    if (cur?.tagName === 'INPUT' && cur.type === 'text') return 'native';
    if (api.G.mode === 'menu' && page === 'garage' && pause.hidden) {
      api.stepCar(d);
      // el garage se redibuja: si el foco quedó en la nada, va a la flecha
      requestAnimationFrame(() => { if (!root.contains(document.activeElement)) focusEl($(d < 0 ? 'g-prev' : 'g-next')); });
      return true;
    }
    const grp = cur?.closest('[data-autoselect]');
    if (grp && root.contains(grp)) {
      const btns = [...grp.querySelectorAll('button')].filter(visible), i = btns.indexOf(cur), nb = btns[i + d];
      if (nb) { focusEl(nb); nb.click(); }
      return true;
    }
    return move(d < 0 ? 'left' : 'right', root);
  }

  function activate() {
    const cur = document.activeElement, root = navRoot();
    if (!root) return;
    if (!root.contains(cur) || cur === body) { focusEl(defaultIn(root), true); return; }
    if (cur.tagName === 'BUTTON' || cur.tagName === 'SUMMARY') cur.click();
  }

  // Esc / B
  function back() {
    if (!pause.hidden) {
      if (!$('pz-opts').hidden) showPauseMain(true); else resume();
      return true;
    }
    if (api.isDriving()) { openPause(); return true; }
    const m = api.G.mode, cur = document.activeElement;
    if (cur?.tagName === 'INPUT' && cur.type === 'text') { cur.blur(); if (m === 'menu') focusDefault(pageEl(), lastHome); return true; }
    if (m === 'menu') { if (page !== 'home') goBack(); return true; }
    // en la sala y en los resultados, el primer Esc marca el botón de salir y el segundo lo aprieta
    const btn = m === 'lobby' ? $('btn-leave') : m === 'results' ? $('btn-res-back') : null;
    if (btn && visible(btn)) { if (cur === btn) btn.click(); else focusEl(btn, true); return true; }
    return false;
  }

  // ---------- Teclado ----------
  window.addEventListener('keydown', e => {
    const paused = !pause.hidden;
    if (e.code === 'Escape') {
      if (api.G.mode === 'loading') return;
      if (back()) { e.preventDefault(); e.stopImmediatePropagation(); markNav(); }
      return;
    }
    const root = navRoot();
    if (!root) return; // manejando: las teclas son del juego
    const t = e.target;
    let used = false;
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { used = move(e.code === 'ArrowUp' ? 'up' : 'down', root); if (t?.type === 'range') e.preventDefault(); }
    else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const r = horiz(e.code === 'ArrowLeft' ? -1 : 1, root, false);
      if (r === 'native') { markNav(); if (paused) e.stopImmediatePropagation(); return; }
      used = r;
    }
    else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat) {
      if (t?.id === 'name') { t.blur(); focusDefault(pageEl(), lastHome); used = true; }
      else if (!root.contains(document.activeElement) || document.activeElement === body) { focusEl(defaultIn(root), true); used = true; }
      // con un botón enfocado, el navegador ya hace el clic solo
    }
    if (used) { e.preventDefault(); markNav(); }
    // con la pausa abierta no le llega ninguna tecla al juego (ni manejar ni disparar)
    if (paused) e.stopImmediatePropagation();
  }, true);

  // marca de foco bien visible solo cuando se navega con teclado o joystick
  function markNav() { body.classList.add('kbd-nav'); }
  window.addEventListener('mousemove', () => body.classList.remove('kbd-nav'), { passive: true });
  window.addEventListener('pointerdown', () => body.classList.remove('kbd-nav'), { passive: true });

  // ---------- Joystick ----------
  const held = {}, nextRep = {};
  const REPEAT = new Set(['up', 'down', 'left', 'right']);
  function padFire(k) {
    if (k === 'start') {
      if (!pause.hidden) resume();
      else if (api.isDriving()) openPause();
      return;
    }
    const root = navRoot(); if (!root) return;
    markNav();
    if (k === 'up' || k === 'down') move(k, root);
    else if (k === 'left' || k === 'right') horiz(k === 'left' ? -1 : 1, root, true);
    else if (k === 'a') activate();
    else if (k === 'b') back();
    else if ((k === 'lb' || k === 'rb') && api.G.mode === 'menu' && page === 'garage' && pause.hidden) {
      const tabs = [...$('g-tabs').querySelectorAll('button')], i = tabs.findIndex(b => b.getAttribute('aria-selected') === 'true');
      tabs[(i + (k === 'rb' ? 1 : -1) + tabs.length) % tabs.length]?.click();
    }
  }
  function pollPad(t) {
    requestAnimationFrame(pollPad);
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null; for (const p of pads) if (p) { gp = p; break; }
    if (!gp) return;
    const b = i => !!gp.buttons[i]?.pressed, ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    const st = { start: b(9) };
    // fuera de la carrera (o en pausa) el joystick maneja el menú
    if (navRoot()) Object.assign(st, { up: b(12) || ay < -0.6, down: b(13) || ay > 0.6, left: b(14) || ax < -0.6, right: b(15) || ax > 0.6, a: b(0), b: b(1), lb: b(4), rb: b(5) });
    for (const k of ['start', 'up', 'down', 'left', 'right', 'a', 'b', 'lb', 'rb']) {
      if (!st[k]) { held[k] = 0; continue; }
      if (!held[k]) { held[k] = t; nextRep[k] = t + 380; padFire(k); }
      else if (REPEAT.has(k) && t >= nextRep[k]) { nextRep[k] = t + 110; padFire(k); }
    }
  }
  requestAnimationFrame(pollPad);
  function padStatus() {
    const el = $('pad-status'); if (!el) return;
    const gp = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(Boolean);
    el.textContent = gp ? 'conectado: ' + gp.id.replace(/\s*\(.*$/, '').slice(0, 28) : 'sin conectar';
    el.classList.toggle('on', !!gp);
  }
  window.addEventListener('gamepadconnected', padStatus);
  window.addEventListener('gamepaddisconnected', padStatus);

  // ---------- Mouse / toque ----------
  menu.addEventListener('click', e => {
    const st = e.target.closest('[data-step]');
    if (st) { if (st.dataset.step !== page) goStep(st.dataset.step); return; }
    const go = e.target.closest('[data-go]');
    if (go) {
      if (go.classList.contains('mm-item')) {
        lastHome = go;
        const f = go.dataset.go;
        // CARRERA y PRÁCTICA: primero el auto, después la pista y al final las reglas
        if (FLOWS[f]) { flow = f; goPage('garage'); return; }
        flow = null;
      }
      goPage(go.dataset.go); return;
    }
    if (e.target.closest('[data-back]')) goBack();
  });
  $('g-choose').addEventListener('click', () => flowNext('garage'));
  $('t-choose').addEventListener('click', () => flowNext('tracks'));
  let hoverT = 0, hoverEl = null;
  document.addEventListener('mouseover', e => {
    const it = e.target.closest?.('.mm-item');
    if (!it || it === hoverEl) return;
    hoverEl = it;
    const now = performance.now(); if (now - hoverT < 60) return; hoverT = now;
    sfx('menuupdown', { vol: 0.3 });
  });
  document.addEventListener('focusin', e => { if (e.target.classList?.contains('mm-item') && menu.contains(e.target)) lastHome = e.target; });

  // ---------- Pausa ----------
  function showPauseMain(sound) {
    $('pz-opts').hidden = true; $('pz-main').hidden = false;
    if (sound) sfx('menuupdown', { vol: 0.5, rate: 0.85 });
    focusDefault($('pz-main'), $('pz-options'));
  }
  function openPause() {
    if (!pause.hidden || !api.isDriving()) return;
    const online = api.online();
    $('pause-title').textContent = online ? 'MENÚ' : 'PAUSA';
    $('pause-sub').textContent = online ? 'La carrera sigue · tu auto queda frenado' : (api.G.mode === 'practice' ? 'Práctica' : 'Carrera') + ' · ' + api.trackName();
    $('pz-restart').hidden = online;
    $('pz-quit').querySelector('b').textContent = online ? 'Salir de la partida' : 'Salir al menú';
    $('pz-opts').hidden = true; $('pz-main').hidden = false;
    pause.hidden = false;
    api.setPaused(true);
    sfx('pickup', { vol: 0.45 });
    focusDefault($('pz-main'));
  }
  function closePause() { if (pause.hidden) return false; pause.hidden = true; api.setPaused(false); return true; }
  function resume() { if (closePause()) { sfx('menunext', { vol: 0.5 }); document.activeElement?.blur?.(); } }
  $('pz-resume').onclick = resume;
  $('pz-restart').onclick = () => { closePause(); sfx('menunext', { vol: 0.6 }); api.restartRace(); };
  $('pz-quit').onclick = () => { closePause(); sfx('menuupdown', { vol: 0.5, rate: 0.85 }); api.leaveRace(); };
  $('pz-options').onclick = () => {
    $('pz-opts').querySelector('.opt-slot').appendChild(optBody);
    $('pz-opts-sub').textContent = api.online() ? 'La carrera sigue' : 'Juego en pausa';
    syncOptions();
    $('pz-main').hidden = true; $('pz-opts').hidden = false;
    sfx('menunext', { vol: 0.55 });
    focusDefault($('pz-opts'));
  };
  pause.querySelector('#pz-opts [data-back]').onclick = () => showPauseMain(true);
  // si te vas a otra pestaña en práctica o contra la PC, el juego se pausa solo
  document.addEventListener('visibilitychange', () => { if (document.hidden && api.isDriving() && !api.online()) openPause(); });

  // ---------- Opciones propias de la interfaz ----------
  function setPressed(id, v) { for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.v === String(v)); }
  function syncOptions() {
    setPressed('opt-mute', api.audio.muted ? 1 : 0);
    setPressed('opt-quality', quality);
    padStatus();
  }
  $('opt-mute').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const want = b.dataset.v === '1';
    if (api.audio.muted !== want) api.audio.toggleMute();
    syncOptions();
    if (!want) sfx('menuupdown', { vol: 0.5 });
  });
  let quality = ['baja', 'media', 'alta'].includes(api.store.get('rv.quality', 'alta')) ? api.store.get('rv.quality', 'alta') : 'alta';
  api.setQuality(quality);
  $('opt-quality').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    quality = b.dataset.v; api.store.set('rv.quality', quality); api.setQuality(quality);
    syncOptions(); sfx('menuupdown', { vol: 0.5 });
  });

  // ---------- Escena 3D detrás del menú: el auto/pista quedan en el espacio libre al lado del panel ----------
  const wide = () => matchMedia('(min-width: 641px)').matches;
  function layoutScene() {
    const m = api.G.mode;
    const inMenu = m === 'menu' && !menu.hidden;
    $('g-hero').hidden = !(inMenu && page === 'garage');
    $('t-hero').hidden = !(inMenu && page === 'tracks');
    $('sel-chip').hidden = inMenu && (page === 'garage' || page === 'tracks');
    api.setMenuZoom(inMenu && page === 'garage' ? 0.78 : 1);
    let sx = 0, sy = 0;
    if (m === 'menu' || m === 'lobby' || m === 'results') {
      const box = m === 'menu' ? menu.querySelector('.band') : $(m === 'lobby' ? 'scr-lobby' : 'scr-results').querySelector('.panel');
      if (box && visible(box)) {
        // medidas sin las animaciones de entrada (offset* no incluye transform)
        if (wide()) sx = (box.offsetLeft + box.offsetWidth) / 2;
        else if (m === 'menu') sy = Math.max(0, box.offsetHeight / 2); // panel abajo: la escena se ve arriba
      }
    }
    api.setViewShift(sx, sy);
  }
  window.addEventListener('resize', () => layoutScene());

  // ---------- Pistas: tarjetas con la silueta y datos reales ----------
  const DIFF = ['', 'Fácil', 'Media', 'Difícil', 'Extrema'];
  const stars = d => d ? '★'.repeat(d) + '☆'.repeat(4 - d) : '';
  const infoTxt = i => [i.difficulty ? DIFF[i.difficulty] : null, i.lengthM ? i.lengthM + ' m' : null].filter(Boolean).join(' · ');
  let heroId = null;
  function decorateTracks() {
    const names = new Map(api.tracks().map(t => [t.id, t.name]));
    for (const b of $('tracksel').querySelectorAll('button[data-id]')) {
      if (b.dataset.deco) continue;
      b.dataset.deco = '1';
      const id = b.dataset.id;
      // foto característica de la pista (la imagen de carga del juego); se baja recién al verla
      b.innerHTML = `<span class="tc-map"><img alt="" loading="lazy" src="${api.trackPhoto(id)}"></span><b>${names.get(id) || id}</b><i class="tc-stars"></i>`;
      api.trackInfo(id).then(i => {
        const st = b.querySelector('.tc-stars');
        st.textContent = stars(i.difficulty); st.title = i.difficulty ? 'Dificultad: ' + DIFF[i.difficulty] : '';
      });
    }
  }
  function showHero(id) {
    if (!id) return;
    heroId = id;
    const name = api.tracks().find(t => t.id === id)?.name || id;
    $('t-name').textContent = name;
    const chosen = id === api.trackId();
    $('t-state').textContent = chosen ? 'Pista elegida' : 'Enter o clic para elegirla';
    $('t-state').classList.toggle('on', chosen);
    api.trackInfo(id).then(i => {
      if (heroId !== id) return;
      const img = $('t-map'); img.src = api.trackPhoto(id); img.alt = name;
      const rec = api.recordText(id);
      const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
      $('t-data').innerHTML =
        row('Dificultad', i.difficulty ? `<span class="stars">${stars(i.difficulty)}</span> ${DIFF[i.difficulty]}` : '<span class="na">Sin dato</span>') +
        row('Largo', i.lengthM ? i.lengthM + ' m' : '<span class="na">Sin dato</span>') +
        row('Bonus', i.bonus) +
        row('Atajos', i.forks ? 'Sí' : 'No') +
        row('Récord', rec ? `${rec.lap} <small>${rec.car} · ${rec.name}</small>` : '<span class="na">Todavía no</span>');
    });
    const t = $('t-hero'); t.classList.remove('swap'); void t.offsetWidth; t.classList.add('swap');
  }
  function openTracks() {
    decorateTracks();
    $('tracks-count').textContent = api.tracks().length + ' pistas';
    showHero(api.trackId());
  }
  $('tracksel').addEventListener('focusin', e => { const b = e.target.closest('button[data-id]'); if (b) showHero(b.dataset.id); });
  $('tracksel').addEventListener('mouseover', e => { const b = e.target.closest('button[data-id]'); if (b && b.dataset.id !== heroId) showHero(b.dataset.id); });
  // al elegir una pista (lo hace main.js con su carga de siempre) se actualiza la ficha
  $('tracksel').addEventListener('click', e => { const b = e.target.closest('button[data-id]'); if (b) { sfx('menunext', { vol: 0.5 }); requestAnimationFrame(() => showHero(b.dataset.id)); } });
  new MutationObserver(() => { if (page === 'tracks') decorateTracks(); }).observe($('tracksel'), { childList: true });

  // ---------- Resumen de auto y pista (datos reales del juego) ----------
  function refreshSummary() {
    const car = api.carName(), trk = api.trackName();
    for (const el of document.querySelectorAll('.sum-car')) el.textContent = car;
    for (const el of document.querySelectorAll('.sum-track')) el.textContent = trk;
    const tid = api.trackId();
    if (tid) api.trackInfo(tid).then(i => {
      if (api.trackId() !== tid) return;
      for (const el of document.querySelectorAll('.track-sum img')) el.src = api.trackPhoto(tid);
      for (const el of document.querySelectorAll('.sum-track-info')) el.textContent = infoTxt(i);
    });
    $('mm-garage-sub').textContent = api.carCount() + ' autos para elegir';
    $('garage-count').textContent = api.carCount() + ' autos · ' + api.groupCount() + ' grupos';
    const chip = $('sel-chip');
    const html = `<span><em>Auto</em><b></b></span><span><em>Pista</em><b></b></span>`;
    if (!chip.firstChild) chip.innerHTML = html;
    const [a, b] = chip.querySelectorAll('b'); a.textContent = car; b.textContent = trk;
  }
  // cuando cambian el auto o la pista (lo hace main.js), se actualiza el resumen
  let sumQueued = false;
  const queueSummary = () => { if (sumQueued) return; sumQueued = true; requestAnimationFrame(() => { sumQueued = false; if (api.G.mode !== 'loading') refreshSummary(); }); };
  new MutationObserver(queueSummary).observe($('lc-name'), { childList: true, characterData: true, subtree: true });
  new MutationObserver(queueSummary).observe($('tracksel'), { attributes: true, subtree: true, attributeFilter: ['aria-pressed'] });

  // ---------- Lo llama main.js cada vez que cambia de pantalla ----------
  function onShow(id) {
    // cualquier cambio de pantalla cierra la pausa (terminó la carrera, se cortó la sala, etc.)
    closePause();
    if (id === 'scr-menu') {
      for (const el of pages) el.hidden = el.dataset.page !== page;
      goPage(page, { sound: false, back: true });
    } else if (id === 'scr-lobby' || id === 'scr-results') {
      focusDefault($(id));
    }
    layoutScene();
  }

  return { onShow, openPause, refreshSummary, isPaused: () => !pause.hidden };
}

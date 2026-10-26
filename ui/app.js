const { invoke, convertFileSrc } = window.__TAURI__.core;
const $ = (s) => document.querySelector(s);
const form = $('#form');
const fform = $('#fform');

let lib = { version: 1, settings: {}, folders: [], items: [] };
let dataDir = '';
let view = null; // open folder id, or null for Home
let editing = null; // item being edited, or null when adding
let editingFolder = null; // folder being renamed, or null when creating

const toast = (msg, isError = true) => {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  if (!t.matches(':popover-open')) t.showPopover();
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.hidePopover(), 5000);
};
const save = () => invoke('save_library', { json: JSON.stringify(lib) }).catch((e) => toast('Save failed: ' + e));
const commit = () => {
  save();
  render();
  fetchIcons();
};

const kindOf = (t) => (/\.exe$/i.test(t) ? 'exe' : 'uri'); // .lnk and URIs go through the shell
const nameOf = (p) => p.split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const byName = (a, b) => a.name.localeCompare(b.name);
const assetSrc = (c) => convertFileSrc(dataDir + '\\' + c.replaceAll('/', '\\'));
const newItem = (f) => ({ id: crypto.randomUUID(), args: '', cwd: '', source: 'manual', sourceId: '', cover: null, folderId: view, hidden: false, ...f });

// ---- rendering -----------------------------------------------------------

const inFolder = (i) => lib.folders.some((f) => f.id === i.folderId);

function render() {
  if (view && !lib.folders.some((f) => f.id === view)) view = null;
  const q = $('#q').value.trim().toLowerCase();
  const visible = lib.items.filter((i) => !i.hidden);
  let tiles;
  if (q) tiles = visible.filter((i) => i.name.toLowerCase().includes(q)).sort(byName).map((i) => tile(i));
  else if (view) tiles = visible.filter((i) => i.folderId === view).sort(byName).map((i) => tile(i));
  else tiles = [...lib.folders].sort(byName).map((f) => tile(f, true)).concat(visible.filter((i) => !inFolder(i)).sort(byName).map((i) => tile(i)));
  $('#grid').replaceChildren(...tiles);
  $('#empty').hidden = tiles.length > 0 || !!q;
  $('#empty').classList.toggle('home', !view); // the wordmark is for the empty library, not an empty folder
  $('#back').hidden = $('#crumb').hidden = !view || !!q;
  $('#newfolder').hidden = !!view;
  $('#crumb').textContent = lib.folders.find((f) => f.id === view)?.name ?? '';
  if (view + '|' + q !== lastKey) sel = 0;
  lastKey = view + '|' + q;
  select(sel);
  renderSide(visible);
}

// Sidebar: pinned folders/items, all folders, recently launched.
function renderSide(visible) {
  const rows = (title, list) => {
    if (!list.length) return [];
    const h = document.createElement('h3');
    h.textContent = title;
    return [h, ...list.map((o) => srow(o, lib.folders.includes(o)))];
  };
  const pinned = [...lib.folders, ...visible].filter((o) => o.pinned).sort(byName);
  const recent = visible.filter((i) => i.lastLaunched).sort((a, b) => b.lastLaunched - a.lastLaunched).slice(0, 8);
  const all = [...rows('Pinned', pinned), ...rows('Folders', [...lib.folders].sort(byName)), ...rows('Recent', recent)];
  if (!all.length) {
    const p = document.createElement('p');
    p.textContent = 'Right-click a game or folder to pin it here. Recently launched games show up here too.';
    all.push(p);
  }
  $('#sidelist').replaceChildren(...all);
}
function srow(o, isFolder) {
  const b = document.createElement('button');
  b.className = isFolder ? 'srow folder' : 'srow';
  b.classList.toggle('on', o.id === view);
  b.dataset.id = o.id;
  const n = document.createElement('span');
  n.textContent = o.name;
  b.append(cover(o, isFolder), n);
  return b;
}

function tile(o, isFolder = false) {
  const d = document.createElement('div');
  d.className = isFolder ? 'tile folder' : 'tile';
  d.dataset.id = o.id;
  const n = document.createElement('div');
  n.className = 'name';
  n.textContent = isFolder ? `${o.name} (${lib.items.filter((i) => !i.hidden && i.folderId === o.id).length})` : o.name;
  d.append(cover(o, isFolder), n);
  return d;
}

function cover(o, isFolder) {
  const c = document.createElement('span');
  c.className = 'cover';
  const src = o.cover ?? o.icon; // a cover the user picked wins over the exe's icon
  if (src) {
    c.classList.toggle('icon', !o.cover);
    const img = new Image();
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    img.src = assetSrc(src);
    c.append(img);
  } else {
    c.textContent = isFolder ? '📁' : o.name.charAt(0).toUpperCase();
    c.style.background = `hsl(${hue(o.name)} 45% 40%)`;
  }
  return c;
}

// Which item/folder is under the event (a grid tile or a sidebar row), if any.
function tileOf(e) {
  const t = e.target.closest?.('[data-id]');
  if (!t) return null;
  const isFolder = t.classList.contains('folder');
  return { isFolder, obj: (isFolder ? lib.folders : lib.items).find((x) => x.id === t.dataset.id) };
}

$('#q').oninput = () => {
  $('#grid').classList.add('kb'); // show which result Enter will launch
  render();
};
$('#back').onclick = () => {
  view = null;
  render();
};

async function launchItem(item) {
  try {
    await invoke('launch', { id: item.id });
    item.lastLaunched = Date.now();
    await save();
    render();
    if (st().exitOnLaunch) invoke('quit'); // frees all of the launcher's RAM while the game runs
  } catch (e) {
    toast(String(e));
    if (String(e).startsWith('not found')) openDialog(item); // lets the user fix the path, or remove it
  }
}
function activate(o, isFolder) {
  if (isFolder) {
    view = o.id;
    $('#q').value = '';
    render();
  } else launchItem(o);
}

// ---- click, context menu, drag ------------------------------------------

let suppressClick = false;
$('#grid').onclick = $('#side').onclick = (e) => {
  const t = tileOf(e);
  if (!suppressClick && t) activate(t.obj, t.isFolder);
};

// ---- keyboard: type to search, arrows to move, Enter to open --------------

let sel = 0;
let lastKey = '';
function select(i) {
  const tiles = [...$('#grid').children];
  sel = Math.max(0, Math.min(i, tiles.length - 1));
  tiles.forEach((t, n) => t.classList.toggle('sel', n === sel));
  tiles[sel]?.scrollIntoView({ block: 'nearest' });
}
addEventListener('pointerdown', () => $('#grid').classList.remove('kb'), true);

// Sliders draw their own fill (see style.css): keep it at the value.
const fillRange = (r) => r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min)) * 100 + '%');
addEventListener('input', (e) => e.target.type === 'range' && fillRange(e.target));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideMenu();
    if (document.querySelector('dialog[open]')) return; // the dialog closes itself
    if ($('#q').value) {
      $('#q').value = '';
      render();
    } else if (view) {
      view = null;
      render();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  const inSearch = e.target === $('#q');
  if (!inSearch && e.target !== document.body) return; // a focused button/select keeps its own keys
  if (!inSearch && e.key.length === 1 && e.key !== ' ') return $('#q').focus(); // the keystroke lands in the box
  const tiles = [...$('#grid').children];
  const cols = tiles.filter((t) => t.offsetTop === tiles[0]?.offsetTop).length || 1;
  const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
  if (move && (!inSearch || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    if (inSearch) $('#q').blur();
    $('#grid').classList.add('kb');
    select(sel + move);
  } else if (e.key === 'Enter' && tiles[sel]) {
    const t = tileOf({ target: tiles[sel] });
    activate(t.obj, t.isFolder);
  }
});

const menu = $('#menu');
const hideMenu = () => (menu.hidden = true);
function showMenu(e, entries) {
  menu.replaceChildren(
    ...entries.map(([label, fn]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        hideMenu();
        fn();
      };
      return b;
    }),
  );
  menu.hidden = false;
  menu.style.left = Math.max(0, Math.min(e.clientX, innerWidth - menu.offsetWidth)) + 'px';
  menu.style.top = Math.max(0, Math.min(e.clientY, innerHeight - menu.offsetHeight)) + 'px';
}
addEventListener('pointerdown', (e) => e.target.closest('#menu') || hideMenu(), true);

$('#grid').oncontextmenu = $('#side').oncontextmenu = (e) => {
  e.preventDefault();
  const t = tileOf(e);
  if (!t) return;
  const o = t.obj;
  const pin = [o.pinned ? 'Unpin from sidebar' : 'Pin to sidebar', () => ((o.pinned = !o.pinned), commit())];
  const entries = t.isFolder
    ? [pin, ['Rename…', () => openFolderDialog(o)], ['Set cover…', () => setCover(o)], ...(o.cover ? [['Remove cover', () => dropCover(o)]] : []), ['Delete folder', () => deleteFolder(o)]]
    : [
        ['Launch', () => launchItem(o)],
        pin,
        ['Edit…', () => openDialog(o)],
        ['Set cover…', () => setCover(o)],
        ...(o.cover ? [['Remove cover', () => dropCover(o)]] : []),
        ...(inFolder(o) ? [['Move to Home', () => moveItem(o, null)]] : []),
        ...lib.folders.filter((f) => f.id !== o.folderId).sort(byName).map((f) => [`Move to “${f.name}”`, () => moveItem(o, f.id)]),
        ['Remove', () => removeItem(o)],
      ];
  showMenu(e, entries);
};

function moveItem(item, folderId) {
  item.folderId = folderId;
  commit();
}

// Pointer-based drag (HTML5 drag-and-drop is disabled by Tauri's file-drop handling on Windows).
let drag = null;
const dropTarget = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest('.folder, #back:not([hidden])');
$('#grid').onpointerdown = $('#side').onpointerdown = (e) => {
  const t = e.button === 0 && tileOf(e);
  if (t) e.preventDefault(); // also keeps sidebar buttons from taking focus, so typing still searches
  if (t && !t.isFolder) drag = { item: t.obj, x0: e.clientX, y0: e.clientY, y: e.clientY, ghost: null, over: null, timer: 0 };
};
addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!e.buttons) return endDrag(e, true); // button was released outside the window
  drag.y = e.clientY;
  if (!drag.ghost) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    drag.ghost = document.createElement('div');
    drag.ghost.id = 'ghost';
    drag.ghost.textContent = drag.item.name;
    document.body.append(drag.ghost);
    // Scroll while the pointer is near the top/bottom edge, so folders far up the list stay reachable.
    const grid = $('#grid');
    const r = grid.getBoundingClientRect();
    drag.timer = setInterval(() => grid.scrollBy(0, drag.y < r.top + 70 ? -14 : drag.y > r.bottom - 70 ? 14 : 0), 16);
  }
  drag.ghost.style.left = e.clientX + 8 + 'px';
  drag.ghost.style.top = e.clientY + 8 + 'px';
  const over = dropTarget(e);
  if (over !== drag.over) {
    drag.over?.classList.remove('over');
    over?.classList.add('over');
    drag.over = over;
  }
});
function endDrag(e, cancelled) {
  if (!drag) return;
  const { item, ghost, over, timer } = drag;
  drag = null;
  if (!ghost) return; // a plain click
  clearInterval(timer);
  ghost.remove();
  over?.classList.remove('over');
  suppressClick = true;
  setTimeout(() => (suppressClick = false));
  const target = cancelled ? null : dropTarget(e); // recomputed: the list may have scrolled under a still pointer
  if (target) moveItem(item, target.id === 'back' ? null : target.dataset.id);
}
addEventListener('pointerup', (e) => endDrag(e, false));
addEventListener('pointercancel', (e) => endDrag(e, true));

// ---- covers ----------------------------------------------------------------

// Downscale in the webview (max 300x450, webp) so we never keep a full-size image in memory or on disk.
function setCover(o) {
  const pick = $('#pick');
  pick.value = '';
  pick.onchange = async () => {
    const file = pick.files[0];
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, 300 / bmp.width, 450 / bmp.height);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s);
      c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      o.cover = await saveCanvas(c, o.id, o.cover);
      commit();
    } catch (err) {
      toast('Cover failed: ' + err);
    }
  };
  pick.click();
}
async function saveCanvas(c, stem, old) {
  const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.85));
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  return invoke('save_cover', { stem, bytes, old });
}

// Icons: each item's is pulled once from its exe (Steam/Epic: the game's exe) and stored like a cover.
// `icon` undefined = not tried yet, null = it has none.
async function fetchIcons() {
  if (fetchIcons.busy) return;
  fetchIcons.busy = true;
  let tried = false;
  for (const i of lib.items) {
    if (i.icon !== undefined) continue;
    i.icon = null;
    tried = true;
    try {
      const px = new Uint8ClampedArray(await invoke('icon', { target: i.target, source: i.source, sourceId: i.sourceId }));
      if (!px.length) continue;
      i.icon = await saveCanvas(trimIcon(px), i.id + '-icon', null);
      render();
    } catch (e) {
      console.warn('icon', i.name, e);
    }
  }
  fetchIcons.busy = false;
  if (tried) save(); // also records the nulls, so a missing icon isn't looked for on every start
}
// 256x256 RGBA -> canvas cropped to the opaque pixels (small icons sit in the top-left corner of the 256 box).
function trimIcon(px) {
  let [x0, y0, x1, y1] = [256, 256, 0, 0];
  for (let p = 3; p < px.length; p += 4) {
    if (!px[p]) continue;
    const x = (p >> 2) & 255;
    const y = p >> 10;
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
  }
  const side = Math.max(x1 - x0, y1 - y0, 1); // square, so the tile can center it
  const c = document.createElement('canvas');
  c.width = c.height = side;
  c.getContext('2d').putImageData(new ImageData(px, 256, 256), -x0 + (side - (x1 - x0)) / 2, -y0 + (side - (y1 - y0)) / 2);
  return c;
}
function dropIcon(o) {
  if (o.icon) invoke('remove_cover', { path: o.icon }).catch(toast);
  delete o.icon; // fetched again
}

function dropCover(o) {
  invoke('remove_cover', { path: o.cover }).catch(toast);
  o.cover = null;
  commit();
}

// ---- item dialog -----------------------------------------------------------

function openDialog(item) {
  editing = item;
  form.name.value = item?.name ?? '';
  form.target.value = item?.target ?? '';
  form.args.value = item?.args ?? '';
  $('#remove').hidden = !item;
  $('#dlg').showModal();
}
$('#add').onclick = () => openDialog(null);
$('#cancel').onclick = () => $('#dlg').close();
$('#remove').onclick = () => {
  $('#dlg').close();
  removeItem(editing);
};
function removeItem(item) {
  // Imported items are hidden, not deleted, so a rescan doesn't bring them back.
  if (item.source === 'manual') {
    lib.items = lib.items.filter((i) => i !== item);
    if (item.cover) dropCover(item);
    dropIcon(item);
  } else item.hidden = true;
  commit();
}
$('#browse').onclick = async () => {
  const p = await window.__TAURI__.dialog.open({ filters: [{ name: 'Apps', extensions: ['exe', 'lnk', 'bat', 'cmd'] }] });
  if (!p) return;
  form.target.value = p;
  if (!form.name.value) form.name.value = nameOf(p);
};
form.onsubmit = (e) => {
  e.preventDefault();
  const target = form.target.value.trim();
  const f = { name: form.name.value.trim(), target, args: form.args.value.trim(), kind: kindOf(target) };
  if (editing && editing.target !== target) dropIcon(editing);
  if (editing) Object.assign(editing, f);
  else lib.items.push(newItem(f));
  $('#dlg').close();
  commit();
};

// ---- folder dialog ---------------------------------------------------------

function openFolderDialog(folder) {
  editingFolder = folder;
  fform.name.value = folder?.name ?? '';
  $('#fdlg').showModal();
}
$('#newfolder').onclick = () => openFolderDialog(null);
$('#fcancel').onclick = () => $('#fdlg').close();
fform.onsubmit = (e) => {
  e.preventDefault();
  const name = fform.name.value.trim();
  if (editingFolder) editingFolder.name = name;
  else lib.folders.push({ id: crypto.randomUUID(), name, cover: null });
  $('#fdlg').close();
  commit();
};
// In-page confirm: window.confirm is replaced by the dialog plugin with an async function (always truthy),
// and the plugin's native ask() never showed a window here.
function confirmDialog(text, yes) {
  const d = $('#cdlg');
  $('#ctext').textContent = text;
  $('#cyes').textContent = yes;
  d.returnValue = '';
  d.showModal();
  return new Promise((r) => d.addEventListener('close', () => r(d.returnValue === 'yes'), { once: true }));
}
async function deleteFolder(f) {
  if (!(await confirmDialog(`Delete folder “${f.name}”? Its items go back to Home.`, 'Delete'))) return;
  lib.items.forEach((i) => i.folderId === f.id && (i.folderId = null));
  lib.folders = lib.folders.filter((x) => x !== f);
  if (f.cover) invoke('remove_cover', { path: f.cover }).catch(toast);
  commit();
}

// ---- appearance: theme + background ----------------------------------------

const bg = $('#bg');
const sform = $('#sform');
let bgUrl = '';
const st = () => ({ theme: 'system', material: 'acrylic', edge: 8, side: 'right', ...lib.settings, bg: { file: null, dim: 0.6, blur: 0, ...lib.settings.bg } });
const patchSettings = (p) => (lib.settings = { ...lib.settings, ...p });
const patchBg = (p) => patchSettings({ bg: { ...st().bg, ...p } });

// The image is detached while the window is minimized, so a GIF isn't decoded and animated for nobody.
// (WebView2 doesn't flip document.hidden on minimize, hence the window API; it's kept as a fallback.)
// Not detected: a window merely covered by a game. exit-on-launch is the fix for that.
let minimized = false;
function syncBg() {
  const want = document.hidden || minimized ? '' : bgUrl;
  if (!want) bg.removeAttribute('src');
  else if (bg.getAttribute('src') !== want) bg.src = want;
}
document.addEventListener('visibilitychange', syncBg);
const appWindow = window.__TAURI__.window.getCurrentWindow();
appWindow.onResized(async () => {
  minimized = await appWindow.isMinimized();
  syncBg();
});

$('#wmin').onclick = () => appWindow.minimize();
$('#wmax').onclick = () => appWindow.toggleMaximize();
$('#wclose').onclick = () => appWindow.close();
appWindow.onResized(async () => {
  const max = await appWindow.isMaximized();
  $('#wmax').textContent = max ? '\uE923' : '\uE922'; // restore / maximize glyphs
  $('#wmax').title = max ? 'Restore' : 'Maximize';
});

// Native blur of the desktop behind the window. Off when nothing shows through (opaque, or a background image).
let lastFx;
function applyWindow(theme, fx) {
  if (theme + fx === lastFx) return;
  lastFx = theme + fx;
  appWindow.setTheme(theme === 'system' ? null : theme).catch(toast); // acrylic/mica tint follows the window theme
  (fx ? appWindow.setEffects({ effects: [fx] }) : appWindow.clearEffects()).catch(toast);
}

function applyAppearance() {
  const { theme, material, edge, side, bg: b } = st();
  document.body.classList.toggle('side-left', side === 'left');
  const root = document.documentElement.style;
  root.colorScheme = theme === 'system' ? 'light dark' : theme; // all colors are system colors
  root.setProperty('--a', b.dim);
  root.setProperty('--edge', edge + 'px');
  applyWindow(theme, b.dim < 1 && !b.file && material !== 'none' ? material : null);
  bgUrl = b.file ? assetSrc(b.file) : '';
  syncBg();
  $('#shade').style.opacity = b.dim;
  bg.style.filter = b.blur ? `blur(${b.blur}px)` : '';
  bg.style.transform = b.blur ? 'scale(1.06)' : ''; // hides the faded edges the blur leaves
}

$('#gear').onclick = () => {
  const s = st();
  sform.theme.value = s.theme;
  sform.material.value = s.material;
  sform.side.value = s.side;
  sform.edge.value = s.edge;
  sform.dim.value = s.bg.dim;
  sform.blur.value = s.bg.blur;
  sform.querySelectorAll('[type=range]').forEach(fillRange);
  sform.exit.checked = !!s.exitOnLaunch;
  const n = lib.items.filter((i) => i.hidden).length;
  $('#unhide').textContent = `Restore ${n} hidden game${n === 1 ? '' : 's'}`;
  $('#unhide').disabled = !n;
  window.__TAURI__.app.getVersion().then((v) => ($('#ver').textContent = 'Limitless Launcher ' + v));
  $('#sdlg').showModal();
};
sform.exit.onchange = () => {
  patchSettings({ exitOnLaunch: sform.exit.checked });
  save();
};
$('#unhide').onclick = () => {
  lib.items.forEach((i) => (i.hidden = false));
  $('#unhide').disabled = true;
  commit();
};
for (const k of ['theme', 'material', 'side']) {
  sform[k].onchange = () => {
    patchSettings({ [k]: sform[k].value });
    applyAppearance();
    save();
  };
}
for (const k of ['dim', 'blur', 'edge']) {
  sform[k].oninput = () => {
    if (k === 'edge') patchSettings({ edge: +sform.edge.value });
    else patchBg({ [k]: +sform[k].value });
    applyAppearance();
  };
  sform[k].onchange = save;
}

$('#bgpick').onclick = async () => {
  const path = await window.__TAURI__.dialog.open({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
  if (path) useBg(path);
};
async function useBg(path) {
  try {
    const [file, size] = await invoke('import_bg', { path, old: st().bg.file });
    patchBg({ file });
    applyAppearance();
    save();
    await bg.decode().catch(() => {});
    const mb = size / 2 ** 20;
    if (mb > 10 || bg.naturalWidth > 1920) toast(`Large background (${mb.toFixed(1)} MB, ${bg.naturalWidth}px wide): big or animated images can use a lot of RAM.`, false);
  } catch (e) {
    toast('Background failed: ' + e);
  }
}
$('#bgclear').onclick = () => {
  const { file } = st().bg;
  if (file) invoke('remove_bg', { path: file }).catch(toast);
  patchBg({ file: null });
  applyAppearance();
  save();
};

// ---- add by drop, scan, startup -------------------------------------------

function addPaths(paths) {
  for (const p of paths) {
    if (lib.items.some((i) => i.target === p)) continue;
    lib.items.push(newItem({ name: nameOf(p), kind: kindOf(p), target: p }));
  }
  commit();
}
window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
  if (payload.type === 'drop') addPaths(payload.paths);
});

// Adds games not already known (hidden ones count as known); never touches existing entries.
async function rescan() {
  try {
    const found = await invoke('scan');
    const known = new Set(lib.items.map((i) => i.source + '\0' + i.sourceId));
    const fresh = found.filter((f) => !known.has(f.source + '\0' + f.sourceId));
    for (const f of fresh) lib.items.push(newItem({ ...f, folderId: null }));
    if (fresh.length) commit();
    toast(`Found ${found.length} games, ${fresh.length} new`, false);
  } catch (e) {
    toast('Scan failed: ' + e);
  }
}
$('#rescan').onclick = rescan;

// ---- updates ----------------------------------------------------------------

// One check against GitHub per start (no polling). Installing runs the new installer, which restarts the app.
let pendingUpdate = null;
async function checkUpdate(manual) {
  try {
    pendingUpdate = await window.__TAURI__.updater.check();
  } catch (e) {
    if (manual) toast('Update check failed: ' + e);
    return;
  }
  $('#update').hidden = !pendingUpdate;
  if (pendingUpdate) $('#updver').textContent = `Version ${pendingUpdate.version} is available`;
  else if (manual) toast("You're on the latest version", false);
}
$('#checkupd').onclick = () => checkUpdate(true);
$('#updgo').onclick = async () => {
  const b = $('#updgo');
  b.disabled = true;
  b.textContent = 'Downloading…';
  let got = 0;
  let total = 0;
  try {
    await save();
    await pendingUpdate.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
      else if (ev.event === 'Progress' && total) b.textContent = `Downloading… ${Math.round(((got += ev.data.chunkLength) / total) * 100)}%`;
      else if (ev.event === 'Finished') b.textContent = 'Installing…';
    });
  } catch (e) {
    toast('Update failed: ' + e);
    b.disabled = false;
    b.textContent = 'Update';
  }
};

(async () => {
  try {
    dataDir = await invoke('data_dir');
    const raw = await invoke('load_library');
    if (raw) lib = { ...lib, ...JSON.parse(raw) };
    // "Light" (Windows' legacy blur-behind) was dropped: on Windows 11 it draws black and flickers while moving.
    if (lib.settings.material === 'blur') lib.settings.material = 'acrylic';
  } catch (e) {
    toast('Load failed: ' + e);
  }
  applyAppearance();
  render();
  appWindow.show(); // window starts hidden so there's no flash of the wrong theme
  if (!lib.items.length) rescan(); // first run
  else fetchIcons();
  checkUpdate(false);
})();

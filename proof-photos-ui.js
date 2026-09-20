/* proof-photos-ui.js
 * Volunteer-side proof-of-volunteering photos: the button shown on events the volunteer
 * attended (application status 'completed') and the modal where they upload / delete photos.
 *
 * Load AFTER supabase-client.js and proof-photos.js. It injects its own modal and styles,
 * so a page only needs:
 *
 *   ProofPhotosUI.init({ onChange: () => rerenderMyPage() });
 *   await ProofPhotosUI.load([{ id, attendance_photo_url }, ...]);   // completed applications
 *   ...${ProofPhotosUI.buttonHtml({ appId, title })}...              // where the button belongs
 */
const ProofPhotosUI = (() => {
  const cache = {};            // { [applicationId]: { req, photos, legacyUrl, state } }
  let onChange = () => {};
  let current = null;          // { appId, title }
  let busy = false;
  let dom = null;

  const CSS = `
.btn-proof {
  font-family: inherit; cursor: pointer;
  border: 1px solid rgba(99, 102, 241, 0.45); background: var(--white, #fff);
  color: var(--sky, #6366F1); font-weight: 700; font-size: 0.85rem;
  padding: 9px 18px; border-radius: var(--radius-sm, 10px); transition: all 0.2s ease;
}
.btn-proof:hover { background: rgba(99, 102, 241, 0.08); }
.btn-proof.is-done { border-color: #10B981; color: #10B981; }
.proof-overlay {
  position: fixed; inset: 0; z-index: 250; display: flex; align-items: flex-start; justify-content: center;
  padding: 24px; overflow-y: auto; -webkit-overflow-scrolling: touch;
  background: rgba(11, 17, 32, 0.7); backdrop-filter: blur(8px);
}
.proof-overlay[hidden] { display: none; }
.proof-dialog {
  background: var(--white, #fff); border: 1px solid var(--line, rgba(99, 102, 241, 0.16));
  border-radius: var(--radius-lg, 24px); width: 100%; max-width: 540px; margin: 24px auto; padding: 32px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.25); color: var(--ink, #1E1B4B);
}
.proof-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
.proof-head h3 { margin: 0; font-size: 1.1rem; }
.proof-close { background: none; border: none; font-size: 1.5rem; color: var(--ink-soft, #475569); cursor: pointer; }
.proof-hint { font-size: 0.9rem; line-height: 1.5; margin: 0 0 10px; white-space: pre-line; }
.proof-count { font-size: 0.85rem; font-weight: 600; color: #B45309; margin: 0 0 4px; min-height: 1em; }
.proof-count.is-ok { color: #166534; }
.proof-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; margin: 14px 0; }
.proof-thumb {
  position: relative; aspect-ratio: 1 / 1; overflow: hidden; border-radius: var(--radius-sm, 10px);
  border: 1px solid var(--line, rgba(99, 102, 241, 0.16)); background: var(--paper-dim, #F1ECE4);
}
.proof-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; cursor: pointer; }
.proof-thumb-remove {
  position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; border: none; border-radius: 50%;
  background: rgba(15, 23, 42, 0.78); color: #fff; font-size: 1rem; line-height: 1; cursor: pointer;
}
.proof-thumb-remove:hover { background: #B91C1C; }
.proof-empty { grid-column: 1 / -1; font-size: 0.88rem; color: var(--ink-soft, #475569); }
.proof-status { font-size: 0.85rem; margin: 0 0 12px; min-height: 1em; }
.proof-footer { display: flex; gap: 10px; justify-content: flex-end; }
.proof-footer button { font-family: inherit; font-weight: 700; font-size: 0.9rem; border-radius: var(--radius-sm, 10px); padding: 11px 22px; cursor: pointer; }
.proof-btn-close { border: 1px solid var(--line, rgba(99, 102, 241, 0.16)); background: var(--white, #fff); color: var(--ink, #1E1B4B); }
.proof-btn-add { border: none; color: #fff; background: linear-gradient(135deg, #6366F1 0%, #3B82F6 100%); }
.proof-btn-add:disabled { opacity: 0.55; cursor: not-allowed; }
`;

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  /** rows: [{ id, attendance_photo_url? }] -> fills the cache (requirement + uploaded photos). */
  async function load(rows) {
    const list = (rows || []).filter(r => r && r.id != null);
    if (!list.length) return;
    const ids = list.map(r => String(r.id));
    const [reqs, photos] = await Promise.all([
      getProofRequirementsByApplication(ids),
      getProofPhotos(ids),
    ]);
    list.forEach(r => {
      const id = String(r.id);
      const req = reqs[id] || { ...PROOF_DEFAULT_REQ };
      const uploaded = photos[id] || [];
      const legacyUrl = r.attendance_photo_url || '';
      cache[id] = { req, photos: uploaded, legacyUrl, state: proofState(req, uploaded.length + (legacyUrl ? 1 : 0)) };
    });
  }

  function buttonHtml({ appId, title, extraClass }) {
    if (appId == null) return '';
    const info = cache[String(appId)];
    let label = '📷 Нотолгооны зураг';
    let cls = 'btn-proof' + (extraClass ? ' ' + extraClass : '');
    if (info && info.state.required) {
      if (info.state.ok) {
        label = `✓ Зураг илгээсэн (${info.state.count})`;
        cls += ' is-done';
      } else {
        label = `📷 Зураг оруулах (${info.state.count}/${info.req.min})`;
      }
    }
    return `<button type="button" class="${cls}" data-proof-app-id="${esc(appId)}" data-proof-title="${esc(title || '')}">${label}</button>`;
  }

  function setStatus(msg, kind) {
    dom.status.textContent = msg || '';
    dom.status.style.color = kind === 'error' ? '#991B1B' : kind === 'ok' ? '#166534' : '';
  }

  function render() {
    const info = current && cache[current.appId];
    if (!info) {
      dom.hint.textContent = '';
      dom.count.textContent = '';
      dom.grid.innerHTML = '';
      dom.add.disabled = true;
      return;
    }
    const { req, photos, legacyUrl, state } = info;

    if (!req.required) {
      dom.hint.textContent = 'Энэ ажилд байгууллага нотолгооны зураг шаардаагүй байна.';
      dom.count.textContent = '';
    } else {
      dom.hint.innerHTML = `<strong>Шаардлага: ${proofRangeText(req)}</strong>` +
        (req.description ? `<br>${esc(req.description)}` : '');
      dom.count.textContent = state.ok
        ? `✓ Шаардлага хангасан (${state.count}/${req.max})`
        : `Илгээсэн ${state.count}/${req.max} — дор хаяж ${state.missing} зураг дутуу байна.`;
      dom.count.classList.toggle('is-ok', state.ok);
    }

    const thumbs = [];
    if (legacyUrl) {
      thumbs.push(`<div class="proof-thumb"><img src="${esc(legacyUrl)}" alt="Ирцийн зураг" data-open="${esc(legacyUrl)}"></div>`);
    }
    photos.forEach(ph => {
      thumbs.push(`<div class="proof-thumb"><img src="${esc(ph.url)}" alt="Нотолгооны зураг" data-open="${esc(ph.url)}">` +
        `<button type="button" class="proof-thumb-remove" data-remove="${esc(ph.id)}" aria-label="Зургийг устгах" title="Устгах">&times;</button></div>`);
    });
    dom.grid.innerHTML = thumbs.length ? thumbs.join('') : '<p class="proof-empty">Одоогоор зураг оруулаагүй байна.</p>';

    dom.add.disabled = busy || !state.canAdd;
    dom.add.textContent = (req.required && !state.canAdd) ? 'Дээд хэмжээнд хүрсэн' : '📷 Зураг нэмэх';
  }

  async function refresh() {
    const prev = cache[current.appId];
    await load([{ id: current.appId, attendance_photo_url: prev ? prev.legacyUrl : '' }]);
    render();
    onChange();
  }

  async function open(appId, title) {
    current = { appId: String(appId), title: title || '' };
    dom.title.textContent = title ? `Нотолгооны зураг: ${title}` : 'Нотолгооны зураг';
    setStatus('');
    render();
    dom.overlay.hidden = false;
    try {
      await refresh();
    } catch (err) {
      console.error(err);
      setStatus('Мэдээлэл татахад алдаа гарлаа: ' + proofErrorMessage(err), 'error');
    }
  }

  function close() {
    dom.overlay.hidden = true;
    current = null;
  }

  async function onFilesPicked() {
    const info = current && cache[current.appId];
    const picked = Array.from(dom.file.files || []);
    dom.file.value = '';
    if (!info || !picked.length) return;

    const files = picked.slice(0, info.req.required ? info.state.slotsLeft : 0);
    if (!files.length) return;

    busy = true;
    dom.add.disabled = true;
    let done = 0;
    let failure = '';
    for (const file of files) {
      setStatus(`Илгээж байна… (${done + 1}/${files.length})`);
      try {
        await uploadProofPhoto(current.appId, file);
        done++;
      } catch (err) {
        console.error(err);
        failure = proofErrorMessage(err);
        break;
      }
    }
    busy = false;

    try { await refresh(); } catch (err) { console.error(err); }

    if (failure) {
      setStatus(`${done} зураг илгээгдлээ. Алдаа: ${failure}`, 'error');
    } else if (picked.length > files.length) {
      setStatus(`${done} зураг илгээгдлээ. Дээд хэмжээнээс хэтэрсэн ${picked.length - files.length} зургийг оруулаагүй.`, 'ok');
    } else {
      setStatus(`${done} зураг амжилттай илгээгдлээ.`, 'ok');
    }
  }

  async function onGridClick(e) {
    const removeBtn = e.target.closest('[data-remove]');
    const openEl = e.target.closest('[data-open]');
    if (openEl && !removeBtn) {
      window.open(openEl.getAttribute('data-open'), '_blank');
      return;
    }
    if (!removeBtn || !current || busy) return;

    const info = cache[current.appId];
    const photo = info && info.photos.find(ph => String(ph.id) === removeBtn.getAttribute('data-remove'));
    if (!photo) return;
    if (!confirm('Энэ зургийг устгах уу?')) return;

    busy = true;
    removeBtn.disabled = true;
    try {
      await deleteProofPhoto(photo);
      setStatus('Зургийг устгалаа.', 'ok');
    } catch (err) {
      console.error(err);
      setStatus('Устгахад алдаа гарлаа: ' + proofErrorMessage(err), 'error');
    }
    busy = false;
    try { await refresh(); } catch (err) { console.error(err); }
  }

  function buildDom() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'proof-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="proof-dialog" role="dialog" aria-modal="true" aria-labelledby="proofDialogTitle">
        <div class="proof-head">
          <h3 id="proofDialogTitle">Нотолгооны зураг</h3>
          <button class="proof-close" type="button" aria-label="Хаах">&times;</button>
        </div>
        <p class="proof-hint"></p>
        <p class="proof-count"></p>
        <div class="proof-grid"></div>
        <p class="proof-status"></p>
        <input type="file" accept="image/*" multiple hidden>
        <div class="proof-footer">
          <button class="proof-btn-close" type="button">Хаах</button>
          <button class="proof-btn-add" type="button">📷 Зураг нэмэх</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    dom = {
      overlay,
      title: overlay.querySelector('#proofDialogTitle'),
      hint: overlay.querySelector('.proof-hint'),
      count: overlay.querySelector('.proof-count'),
      grid: overlay.querySelector('.proof-grid'),
      status: overlay.querySelector('.proof-status'),
      file: overlay.querySelector('input[type="file"]'),
      add: overlay.querySelector('.proof-btn-add'),
    };

    overlay.querySelector('.proof-close').addEventListener('click', close);
    overlay.querySelector('.proof-btn-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
    dom.add.addEventListener('click', () => dom.file.click());
    dom.file.addEventListener('change', onFilesPicked);
    dom.grid.addEventListener('click', onGridClick);

    // One delegated listener: any [data-proof-app-id] button on the page opens the modal.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-proof-app-id]');
      if (btn) open(btn.getAttribute('data-proof-app-id'), btn.getAttribute('data-proof-title'));
    });
  }

  function init(opts) {
    onChange = (opts && opts.onChange) || (() => {});
    if (!dom) buildDom();
  }

  return { init, load, buttonHtml, open };
})();

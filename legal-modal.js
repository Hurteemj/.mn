/* legal-modal.js
 * Shows the Terms and Conditions / Privacy Policy inside the sign-up page (a pop-up)
 * instead of opening a new tab. It loads the two existing pages and shows their text,
 * so there is only one copy of each document to maintain.
 *
 * Any link whose href is exactly "terms_and_conditions.html" or "privacy_policy.html"
 * is picked up automatically. Ctrl/Cmd-click or middle-click still opens the real page.
 * Needs the .legal-* styles from the page's stylesheet.
 */
(function () {
  const DOCS = {
    'terms_and_conditions.html': 'Үйлчилгээний нөхцөл',
    'privacy_policy.html': 'Нууцлалын бодлого',
  };
  const cache = {};
  let overlay, modal, titleEl, bodyEl, closeBtns, lastFocus, currentKey;

  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'legal-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="legal-modal" role="dialog" aria-modal="true" aria-labelledby="legalTitle">
        <div class="legal-head">
          <h3 id="legalTitle"></h3>
          <button type="button" class="legal-close" aria-label="Хаах">&times;</button>
        </div>
        <div class="legal-body" tabindex="0"></div>
        <div class="legal-foot">
          <button type="button" class="btn btn-outline legal-close">Хаах</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    modal = overlay.querySelector('.legal-modal');
    titleEl = overlay.querySelector('#legalTitle');
    bodyEl = overlay.querySelector('.legal-body');
    closeBtns = overlay.querySelectorAll('.legal-close');

    closeBtns.forEach(b => b.addEventListener('click', close));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    bodyEl.addEventListener('click', onBodyClick);
    document.addEventListener('keydown', onKeydown);
  }

  async function load(key) {
    if (cache[key]) return cache[key];
    const res = await fetch(key, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const content = doc.querySelector('.content-box');
    if (!content) throw new Error('Content not found');

    const frag = document.createDocumentFragment();
    const intro = doc.querySelectorAll('.intro-box p')[1];
    if (intro && intro.textContent.trim()) {
      const updated = document.createElement('p');
      updated.className = 'legal-updated';
      updated.textContent = intro.textContent.trim();
      frag.appendChild(updated);
    }
    Array.from(content.childNodes).forEach(n => frag.appendChild(document.importNode(n, true)));
    cache[key] = frag;
    return frag;
  }

  function prepareLinks() {
    bodyEl.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (href.startsWith('#') || DOCS[href]) return;
      a.target = '_blank';
      a.rel = 'noopener';
    });
  }

  async function open(key, trigger) {
    build();
    lastFocus = trigger || document.activeElement;
    currentKey = key;
    titleEl.textContent = DOCS[key];
    bodyEl.textContent = 'Ачааллаж байна…';
    bodyEl.scrollTop = 0;
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    closeBtns[0].focus();

    try {
      const frag = await load(key);
      if (currentKey !== key || overlay.hidden) return;
      bodyEl.replaceChildren(frag.cloneNode(true));
      bodyEl.scrollTop = 0;
      prepareLinks();
    } catch (err) {
      console.error(err);
      if (currentKey !== key) return;
      bodyEl.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = 'Баримтыг энд харуулж чадсангүй. ';
      const a = document.createElement('a');
      a.href = key;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Шинэ цонхонд нээх';
      p.appendChild(a);
      bodyEl.appendChild(p);
    }
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    currentKey = null;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // Links inside the pop-up: table-of-contents jumps stay inside it, and a link
  // to the other document swaps the pop-up's content.
  function onBodyClick(e) {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      e.preventDefault();
      const target = bodyEl.querySelector('#' + CSS.escape(href.slice(1)));
      if (target) bodyEl.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' });
    } else if (DOCS[href]) {
      e.preventDefault();
      open(href, lastFocus);
    }
  }

  function onKeydown(e) {
    if (!overlay || overlay.hidden) return;
    if (e.key === 'Escape') {
      close();
    } else if (e.key === 'Tab') {
      // keep keyboard focus inside the pop-up
      const items = Array.from(modal.querySelectorAll('button, a[href], [tabindex="0"]'));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || (overlay && overlay.contains(a))) return;
    const key = a.getAttribute('href');
    if (!DOCS[key]) return;
    e.preventDefault();
    open(key, a);
  });
})();

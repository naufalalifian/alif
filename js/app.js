/* ============================================================================
   app.js — Logika aplikasi PrintCost (Digital Printing)
   ----------------------------------------------------------------------------
   Bagian:
     A. Data awal & penyimpanan pengaturan (REST Table API + localStorage)
     B. Mesin hitung harga (per halaman, per dokumen, per order)
     C. Unggah & analisa file (drag & drop, multi file, progress)
     D. Panel review: thumbnail grid + modal perbesar + koreksi 2x
     E. Panel pengaturan harga & parameter deteksi
     F. Riwayat order + ekspor CSV
   ========================================================================= */
(function () {
  'use strict';

  /* =========================================================================
     A. DATA AWAL & PENYIMPANAN
     ========================================================================= */
  const DEFAULT_RULES = [
    { id: 'warna-penuh',  nama: 'Warna — gambar penuh 1 halaman',        mode: 'warna', kategori: 'penuh',  harga: 2000, aktif: true },
    { id: 'warna-hampir', nama: 'Warna — gambar hampir penuh',           mode: 'warna', kategori: 'hampir', harga: 1500, aktif: true },
    { id: 'warna-biasa',  nama: 'Warna — tulisan / gambar biasa',        mode: 'warna', kategori: 'biasa',  harga: 1000, aktif: true },
    { id: 'hp-penuh',     nama: 'Hitam putih — gambar penuh 1 halaman',  mode: 'hp',    kategori: 'penuh',  harga: 1000, aktif: true },
    { id: 'hp-hampir',    nama: 'Hitam putih — gambar hampir penuh',     mode: 'hp',    kategori: 'hampir', harga: 750,  aktif: true },
    { id: 'hp-biasa',     nama: 'Hitam putih — tulisan / gambar kecil',  mode: 'hp',    kategori: 'biasa',  harga: 500,  aktif: true }
  ];

  const DEFAULT_UMUM = {
    id: 'default',
    nama_toko: 'Digital Printing',
    kontak: '',
    catatan_nota: 'Harga belum termasuk finishing. Silakan konfirmasi sebelum cetak.',
    ambang_kosong: 1,     // % tinta minimum, di bawah ini dianggap kosong
    ambang_hampir: 38,    // % luas halaman tertutup gambar -> "hampir penuh"
    ambang_penuh: 62,     // % luas halaman tertutup gambar -> "penuh"
    ambang_warna: 0.05,   // % piksel berwarna minimum -> dianggap WARNA
    harga_kosong: 0,
    minimal_order: 0,
    biaya_tambahan: 0,
    diskon_persen: 0,
    kualitas: 'seimbang'
  };

  const KATEGORI_LABEL = { penuh: 'Gambar penuh', hampir: 'Gambar hampir penuh', biasa: 'Biasa', kosong: 'Kosong' };
  const MODE_LABEL = { warna: 'Warna', hp: 'Hitam putih' };

  const LS_SET = 'printcost_settings_v1';
  const LS_HIS = 'printcost_history_v1';

  const state = {
    umum: Object.assign({}, DEFAULT_UMUM),
    rules: DEFAULT_RULES.map(r => Object.assign({}, r)),
    docs: [],            // dokumen yang sudah dianalisa
    activeDoc: null,
    history: []
  };

  /* --------------------------- Util singkat ------------------------------ */
  const $  = s => document.querySelector(s);
  const $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));

  function rupiah(n) {
    return 'Rp ' + Math.round(n || 0).toLocaleString('id-ID');
  }
  function angka(n, d) {
    return (Math.round((n || 0) * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).toFixed(d || 0);
  }
  function bacaLS(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function tulisLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function toast(msg, tipe) {
    const box = $('#toast-box');
    const el = document.createElement('div');
    el.className = 'toast' + (tipe ? ' toast-' + tipe : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3600);
  }

  /* ------------------ Muat / simpan pengaturan (REST + LS) ---------------- */
  // Permintaan dengan batas waktu agar UI tidak pernah menggantung
  async function fetchTimeOut(url, opsi, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 5000);
    try {
      return await fetch(url, Object.assign({ signal: ctrl.signal }, opsi || {}));
    } finally { clearTimeout(t); }
  }

  async function muatPengaturan() {
    // 1) Ambil dari REST Table API bila tersedia
    try {
      const r1 = await fetchTimeOut('tables/pengaturan_harga?limit=100', null, 5000);
      if (r1 && r1.ok) {
        const j = await r1.json();
        if (j && Array.isArray(j.data) && j.data.length) {
          state.rules = j.data.map(row => ({
            id: row.id, nama: row.nama, mode: row.mode, kategori: row.kategori,
            harga: Number(row.harga) || 0, aktif: row.aktif !== false
          }));
        }
      }
    } catch (e) { /* timeout / server tidak tersedia */ }
    try {
      const r2 = await fetchTimeOut('tables/pengaturan_umum/default', null, 5000);
      if (r2 && r2.ok) {
        const u = await r2.json();
        if (u && u.id) {
          Object.keys(DEFAULT_UMUM).forEach(k => { if (u[k] !== undefined && u[k] !== null) state.umum[k] = u[k]; });
        }
      }
    } catch (e) { /* pakai localStorage */ }

    // 2) Timpa dengan perubahan lokal yang belum tersimpan
    const lokal = bacaLS(LS_SET, null);
    if (lokal) {
      if (lokal.umum) Object.keys(DEFAULT_UMUM).forEach(k => { if (lokal.umum[k] !== undefined) state.umum[k] = lokal.umum[k]; });
      if (Array.isArray(lokal.rules) && lokal.rules.length) {
        lokal.rules.forEach(lr => {
          const f = state.rules.find(r => r.id === lr.id);
          if (f) Object.assign(f, lr);
        });
      }
    }
    state.history = bacaLS(LS_HIS, []) || [];
  }

  async function simpanPengaturan() {
    tulisLS(LS_SET, { umum: state.umum, rules: state.rules });
    let ok = true;
    try {
      for (const r of state.rules) {
        const res = await fetchTimeOut('tables/pengaturan_harga/' + encodeURIComponent(r.id), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nama: r.nama, mode: r.mode, kategori: r.kategori, harga: r.harga, aktif: r.aktif })
        }, 6000);
        if (!res || !res.ok) ok = false;
      }
      const res2 = await fetchTimeOut('tables/pengaturan_umum/default', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.umum)
      }, 6000);
      if (!res2 || !res2.ok) ok = false;
    } catch (e) { ok = false; }
    return ok;
  }

  /* =========================================================================
     B. MESIN HITUNG HARGA
     ======================================================================= */
  function ruleUntuk(mode, kategori) {
    return state.rules.find(r => r.aktif && r.mode === mode && r.kategori === kategori);
  }

  function hargaHalaman(page) {
    if (page.kategori === 'kosong') return Number(state.umum.harga_kosong) || 0;
    const r = ruleUntuk(page.mode, page.kategori) ||
              ruleUntuk(page.mode, 'biasa') ||
              state.rules.find(x => x.aktif);
    return r ? Number(r.harga) || 0 : 0;
  }

  function hitungDokumen(doc) {
    const ringkas = {
      semua: doc.pages.length, warna: 0, hp: 0, kosong: 0,
      warnaPenuh: 0, warnaHampir: 0, warnaBiasa: 0,
      hpPenuh: 0, hpHampir: 0, hpBiasa: 0, harga1x: 0
    };
    doc.pages.forEach(p => {
      if (p.mode === 'warna') ringkas.warna++; else ringkas.hp++;
      if (p.kategori === 'kosong') ringkas.kosong++;
      if (p.kategori !== 'kosong') {
        const key = p.mode === 'warna'
          ? (p.kategori === 'penuh' ? 'warnaPenuh' : p.kategori === 'hampir' ? 'warnaHampir' : 'warnaBiasa')
          : (p.kategori === 'penuh' ? 'hpPenuh' : p.kategori === 'hampir' ? 'hpHampir' : 'hpBiasa');
        ringkas[key]++;
      }
      p.harga = hargaHalaman(p);
      ringkas.harga1x += p.harga;
    });
    doc.ringkas = ringkas;
    doc.subtotal = Math.round(ringkas.harga1x * (Number(doc.rangkap) || 1));
    return ringkas;
  }

  function hitungOrder() {
    let subtotal = 0, halaman = 0;
    state.docs.forEach(d => { hitungDokumen(d); subtotal += d.subtotal; halaman += d.pages.length * (Number(d.rangkap) || 1); });
    const biaya = Number(state.umum.biaya_tambahan) || 0;
    const diskonPersen = Number(state.umum.diskon_persen) || 0;
    const diskon = Math.round(subtotal * diskonPersen / 100);
    let total = subtotal + biaya - diskon;
    const minimal = Number(state.umum.minimal_order) || 0;
    const kurang = total < minimal ? minimal - total : 0;
    return { subtotal, biaya, diskon, diskonPersen, total, minimal, kurang, halaman };
  }

  /* =========================================================================
     C. UNGGAH & ANALISA FILE
     ======================================================================= */
  let memproses = false;

  async function tambahFile(fileList) {
    const files = Array.prototype.slice.call(fileList);
    if (!files.length || memproses) return;
    memproses = true;
    tampilkanLoading(true);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      $('#load-title').textContent = 'Menganalisa: ' + file.name;
      $('#load-sub').textContent = 'Halaman ' + (i + 1) + ' dari ' + files.length;
      setProgress(0, '');
      try {
        const hasil = await Analyzer.analyzeFile(
          file, state.umum,
          (cur, tot) => setProgress(cur / tot, 'Halaman ' + cur + ' / ' + tot),
          (fase) => { $('#load-phase').textContent = fase; }
        );
        const doc = {
          uid: 'doc' + Date.now() + Math.random().toString(36).slice(2, 6),
          nama: file.name,
          ukuran: file.size,
          jenis: hasil.kind,
          pages: hasil.pages,
          note: hasil.note,
          source: hasil.source,
          rangkap: 1,
          minimal: false,
          buatTanggal: new Date().toISOString()
        };
        hitungDokumen(doc);
        state.docs.push(doc);
        state.activeDoc = doc.uid;
        susunTab();
        renderSemua();
        toast('Selesai: ' + file.name + ' (' + doc.pages.length + ' halaman)', 'ok');
      } catch (err) {
        console.error(err);
        toast('Gagal membaca ' + file.name + ': ' + err.message, 'err');
      }
    }

    setProgress(1, '');
    tampilkanLoading(false);
    memproses = false;
    pindahPanel('panel-hasil');
  }

  function setProgress(frac, teks) {
    $('#progress-bar').style.width = Math.max(0, Math.min(100, frac * 100)) + '%';
    $('#progress-teks').textContent = teks || '';
  }
  function tampilkanLoading(on) { $('#loading').classList.toggle('aktif', !!on); }

  function hapusDokumen(uid) {
    state.docs = state.docs.filter(d => d.uid !== uid);
    if (state.activeDoc === uid) state.activeDoc = state.docs[0] ? state.docs[0].uid : null;
    susunTab(); renderSemua();
  }

  function susunTab() {
    const wrap = $('#doc-tabs');
    wrap.innerHTML = '';
    state.docs.forEach(d => {
      const b = document.createElement('button');
      b.className = 'doc-tab' + (d.uid === state.activeDoc ? ' aktif' : '');
      b.innerHTML = '<span class="doc-tab-nama">' + escapeAttr(d.nama) + '</span>' +
        '<span class="doc-tab-meta">' + d.pages.length + ' hal • ' + rupiah(d.subtotal) + '</span>';
      b.onclick = () => { state.activeDoc = d.uid; susunTab(); renderSemua(); };
      wrap.appendChild(b);
    });
  }

  function escapeAttr(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const aktifDoc = () => state.docs.find(d => d.uid === state.activeDoc) || null;

  /* =========================================================================
     D. RENDER HASIL + REVIEW
     ======================================================================= */
  function renderSemua() {
    renderRingkasan();
    renderReview();
    renderOrder();
    renderOrderDetail();
    renderAturanRingkas();
    susunTab();
  }

  /* Ringkasan aturan harga aktif (panel Unggah) */
  function renderAturanRingkas() {
    const wrap = $('#aturan-ringkas');
    if (!wrap) return;
    wrap.innerHTML = '';
    state.rules.forEach(r => {
      const el = document.createElement('div');
      el.className = 'stat' + (r.aktif ? '' : ' nonaktif');
      el.style.opacity = r.aktif ? '1' : '.45';
      el.innerHTML = '<span class="stat-nilai" style="font-size:20px">' + rupiah(r.harga) + '</span>' +
        '<span class="stat-label"><span class="pill pill-' + r.mode + '">' + MODE_LABEL[r.mode] + '</span> ' +
        KATEGORI_LABEL[r.kategori] + (r.aktif ? '' : ' (nonaktif)') + '</span>';
      wrap.appendChild(el);
    });
  }

  /* Rincian tiap file (panel Total Order) */
  function renderOrderDetail() {
    const wrap = $('#order-detail-list');
    if (!wrap) return;
    if (!state.docs.length) { wrap.innerHTML = '<p class="kosong-info">Belum ada file.</p>'; return; }
    wrap.innerHTML = '';
    state.docs.forEach(d => {
      const r = d.ringkas;
      const el = document.createElement('div');
      el.className = 'riwayat-item';
      el.innerHTML = '<div class="riwayat-head"><div><strong>' + escapeAttr(d.nama) + '</strong>' +
        '<div class="riwayat-meta">' + d.pages.length + ' halaman × ' + (d.rangkap || 1) + ' rangkap</div></div>' +
        '<div class="riwayat-total">' + rupiah(d.subtotal) + '</div></div>' +
        '<div class="riwayat-meta">' +
          '<span class="pill pill-warna">Warna</span> penuh ' + r.warnaPenuh + ' • hampir ' + r.warnaHampir + ' • biasa ' + r.warnaBiasa + '<br>' +
          '<span class="pill pill-hp">Hitam putih</span> penuh ' + r.hpPenuh + ' • hampir ' + r.hpHampir + ' • biasa ' + r.hpBiasa +
          (r.kosong ? ' • kosong ' + r.kosong : '') +
        '</div>';
      wrap.appendChild(el);
    });
  }

  function renderRingkasan() {
    const doc = aktifDoc();
    const kotak = $('#ringkasan');
    if (!doc) { kotak.innerHTML = '<p class="kosong-info">Belum ada file yang dianalisa.</p>'; return; }
    const r = doc.ringkas;
    kotak.innerHTML =
      '<div class="stat-grid">' +
        stat('Jumlah halaman', doc.pages.length, '') +
        stat('Halaman warna', r.warna, 'c-warna') +
        stat('Halaman hitam putih', r.hp, 'c-hp') +
        stat('Halaman kosong', r.kosong, '') +
      '</div>' +
      '<table class="tabel-rinci">' +
        '<thead><tr><th>Kategori halaman</th><th>Jumlah</th><th>Harga/satuan</th><th>Subtotal</th></tr></thead>' +
        '<tbody>' + barisRinci('warna', 'penuh', r.warnaPenuh) + barisRinci('warna', 'hampir', r.warnaHampir) +
          barisRinci('warna', 'biasa', r.warnaBiasa) + barisRinci('hp', 'penuh', r.hpPenuh) +
          barisRinci('hp', 'hampir', r.hpHampir) + barisRinci('hp', 'biasa', r.hpBiasa) +
          (r.kosong ? '<tr class="baris-kosong"><td>Halaman kosong</td><td>' + r.kosong + '</td><td>' + rupiah(state.umum.harga_kosong) + '</td><td>' + rupiah((state.umum.harga_kosong || 0) * r.kosong) + '</td></tr>' : '') +
        '</tbody>' +
        '<tfoot><tr><td colspan="3">Harga 1x cetak</td><td>' + rupiah(r.harga1x) + '</td></tr>' +
        '<tr><td colspan="3">Dikali rangkap (' + (doc.rangkap || 1) + '×)</td><td class="tebal">' + rupiah(doc.subtotal) + '</td></tr></tfoot>' +
      '</table>' +
      (doc.note ? '<p class="catatan-kecil">' + escapeAttr(doc.note) + '</p>' : '') +
      '<div class="aksi-doc">' +
        '<label class="inline-field">Rangkap / jumlah salinan' +
          '<input type="number" min="1" step="1" value="' + (doc.rangkap || 1) + '" id="rangkap-doc">' +
        '</label>' +
        '<button class="btn btn-ghost" id="btn-hapus-doc"><i class="fa-solid fa-trash"></i> Hapus file ini</button>' +
        '<button class="btn btn-ghost" id="btn-tambah-file"><i class="fa-solid fa-circle-plus"></i> Tambah file lagi</button>' +
      '</div>';

    $('#rangkap-doc').addEventListener('input', e => {
      doc.rangkap = Math.max(1, parseInt(e.target.value, 10) || 1);
      renderSemua();
    });
    $('#btn-hapus-doc').addEventListener('click', () => hapusDokumen(doc.uid));
    $('#btn-tambah-file').addEventListener('click', () => $('#file-input').click());
  }

  function stat(label, nilai, kelas) {
    return '<div class="stat ' + (kelas || '') + '"><span class="stat-nilai">' + nilai + '</span><span class="stat-label">' + label + '</span></div>';
  }
  function barisRinci(mode, kategori, jumlah) {
    const r = ruleUntuk(mode, kategori);
    const harga = r ? Number(r.harga) || 0 : 0;
    return '<tr class="' + (jumlah ? '' : 'baris-nol') + '">' +
      '<td><span class="pill pill-' + mode + '">' + MODE_LABEL[mode] + '</span> ' + KATEGORI_LABEL[kategori] + '</td>' +
      '<td>' + jumlah + ' hal</td><td>' + rupiah(harga) + '</td><td>' + rupiah(harga * jumlah) + '</td></tr>';
  }

  function renderReview() {
    const doc = aktifDoc();
    const wrap = $('#review-grid');
    if (!doc) { wrap.innerHTML = ''; return; }

    const grid = document.createElement('div');
    grid.className = 'grid-halaman';
    doc.pages.forEach(p => grid.appendChild(kartuHalaman(doc, p)));
    wrap.innerHTML = '';
    wrap.appendChild(grid);
  }

  function kartuHalaman(doc, p) {
    const el = document.createElement('figure');
    el.className = 'kartu-halaman mode-' + p.mode + ' kat-' + p.kategori + (p.edited ? ' sudah-edit' : '');
    const badgeReview = p.reviewCount >= 2 ? '<span class="lencana lencana-ok" title="Sudah direview 2x">✓ 2×</span>'
      : p.reviewCount === 1 ? '<span class="lencana lencana-1" title="Sudah direview 1x">✓ 1×</span>' : '';
    const badgeEdit = p.edited ? '<span class="lencana lencana-edit" title="Jenis halaman diubah manual">✎</span>' : '';

    el.innerHTML =
      '<div class="kartu-head">' +
        '<span class="hal-no">Hal. ' + p.no + '</span>' +
        '<span class="lencana-wrap">' + badgeEdit + badgeReview + '</span>' +
      '</div>' +
      '<button class="kartu-img" type="button" aria-label="Perbesar halaman ' + p.no + '">' +
        (p.thumb ? '<img src="' + p.thumb + '" alt="Halaman ' + p.no + '">' : '<span class="tanpa-pratinjau"><i class="fa-solid fa-eye-slash"></i></span>') +
        '<span class="kartu-zoom"><i class="fa-solid fa-magnifying-glass-plus"></i> Perbesar</span>' +
      '</button>' +
      '<figcaption>' +
        '<div class="tag-baris">' +
          '<span class="pill pill-' + p.mode + '">' + MODE_LABEL[p.mode] + '</span>' +
          '<span class="pill pill-kat">' + KATEGORI_LABEL[p.kategori] + '</span>' +
        '</div>' +
        '<div class="kartu-harga">' + rupiah(p.harga) + '</div>' +
        (p.konfiden === 'rendah' ? '<div class="peringatan-kecil"><i class="fa-solid fa-triangle-exclamation"></i> perlu dicek</div>' : '') +
        (p.catatan ? '<div class="kartu-catatan">' + escapeAttr(p.catatan) + '</div>' : '') +
      '</figcaption>';

    el.querySelector('.kartu-img').addEventListener('click', () => bukaReview(doc.uid, p.no));
    return el;
  }

  /* --------------------- Modal review (perbesar + koreksi) --------------- */
  const modal = {
    docUid: null, pageNo: 1, zoom: 1, cache: {}
  };

  function bukaReview(docUid, pageNo) {
    modal.docUid = docUid; modal.pageNo = pageNo; modal.cache = {};
    $('#modal-review').classList.add('aktif');
    document.body.classList.add('modal-terbuka');
    renderModal();
  }
  function tutupReview() {
    $('#modal-review').classList.remove('aktif');
    document.body.classList.remove('modal-terbuka');
    renderSemua();
  }

  async function renderModal() {
    const doc = state.docs.find(d => d.uid === modal.docUid);
    if (!doc) return tutupReview();
    const p = doc.pages.find(x => x.no === modal.pageNo);
    if (!p) return tutupReview();

    $('#rv-judul').textContent = doc.nama + ' — halaman ' + p.no + ' dari ' + doc.pages.length;
    $('#rv-alasan').textContent = p.alasan || '';
    $('#rv-zoom-info').textContent = Math.round(modal.zoom * 100) + '%';

    // Tombol-tombol koreksi: aktifkan sesuai nilai saat ini
    $$('#rv-mode button').forEach(b => b.classList.toggle('aktif', b.dataset.mode === p.mode));
    $$('#rv-kat button').forEach(b => b.classList.toggle('aktif', b.dataset.kat === p.kategori));
    $('#rv-catatan').value = p.catatan || '';

    // Info metrik deteksi
    const m = p.metrics;
    $('#rv-metrik').innerHTML = m
      ? 'Deteksi otomatis: tinta ' + angka(m.inkPct, 2) + '% • piksel berwarna ' + angka(m.coloredPct, 2) +
        '% • luas gambar ' + angka(m.clusterBBox * 100, 0) + '% halaman' +
        (p.autoMode ? ' • hasil awal: ' + MODE_LABEL[p.autoMode] + ' / ' + KATEGORI_LABEL[p.autoKategori] : '')
      : 'Halaman ini tidak dianalisa otomatis — atur jenisnya secara manual.';

    // Status review 2x
    const st = $('#rv-status');
    const rc = p.reviewCount || 0;
    st.innerHTML = '<span class="status-dot ' + (rc >= 2 ? 'ok' : rc === 1 ? 'satu' : 'nol') + '"></span> ' +
      'Sudah dikoreksi/dikonfirmasi <strong>' + rc + '×</strong> dari 2× koreksi yang disarankan' +
      (p.edited ? ' • <em>jenis halaman diubah manual</em>' : '');
    $('#rv-konfirmasi').innerHTML = rc >= 2
      ? '<i class="fa-solid fa-check-double"></i> Sudah 2× dikoreksi — klik lagi bila ingin menambah'
      : '<i class="fa-solid fa-check"></i> Konfirmasi halaman ini (koreksi ke-' + (rc + 1) + ')';

    $('#rv-harga').textContent = rupiah(p.harga);
    $('#rv-harga-rule').textContent = p.kategori === 'kosong'
      ? 'Halaman kosong'
      : 'Mengikuti aturan: ' + MODE_LABEL[p.mode] + ' / ' + KATEGORI_LABEL[p.kategori];

    // Gambar besar
    const img = $('#rv-gambar');
    const spinner = $('#rv-loading-gambar');
    spinner.style.display = 'flex';
    img.style.opacity = 0.25;
    let src = null;
    if (doc.source && doc.source.type === 'pdf') {
      const w = Math.round(1000 * modal.zoom);
      const key = 'w' + w;
      if (modal.cache[key]) src = modal.cache[key];
      else {
        try { src = await Analyzer.renderPdfPreview(doc.source, p.no, w); modal.cache[key] = src; }
        catch (e) { src = p.thumb; }
      }
    } else {
      src = p.preview || p.thumb;
    }
    spinner.style.display = 'none';
    img.style.opacity = 1;
    img.src = src;
    img.style.maxWidth = (modal.zoom * 100) + '%';
  }

  function ubahZoom(delta) {
    modal.zoom = Math.max(0.5, Math.min(4, Math.round((modal.zoom + delta) * 100) / 100));
    renderModal();
  }

  function koreksi(mode, kategori) {
    const doc = state.docs.find(d => d.uid === modal.docUid);
    const p = doc && doc.pages.find(x => x.no === modal.pageNo);
    if (!p) return;
    const berubah = p.mode !== mode || p.kategori !== kategori;
    p.mode = mode; p.kategori = kategori;
    // Ditandai "diubah manual" bila berbeda dari hasil deteksi otomatis
    if (p.autoMode) {
      p.edited = (p.mode !== p.autoMode || p.kategori !== p.autoKategori);
    } else {
      p.edited = true; // halaman tidak dianalisa otomatis -> selalu manual
    }
    hitungDokumen(doc);
    $('#rv-catatan').value = p.catatan || '';
    toast('Halaman ' + p.no + ': ' + MODE_LABEL[mode] + ' / ' + KATEGORI_LABEL[kategori] + ' — ' + rupiah(p.harga), 'ok');
    $('#rv-harga').textContent = rupiah(p.harga);
    renderModal();
    renderReview();
    susunTab();
  }

  function konfirmasiHalaman() {
    const doc = state.docs.find(d => d.uid === modal.docUid);
    const p = doc && doc.pages.find(x => x.no === modal.pageNo);
    if (!p) return;
    p.catatan = $('#rv-catatan').value.trim();
    p.reviewCount = (p.reviewCount || 0) + 1;
    toast('Halaman ' + p.no + ' dikonfirmasi — sudah ' + p.reviewCount + '× dari 2×', 'ok');
    renderModal();
    renderReview();
    susunTab();
  }

  function navigasiHalaman(delta) {
    const doc = state.docs.find(d => d.uid === modal.docUid);
    const p = doc && doc.pages.find(x => x.no === modal.pageNo);
    if (p) { p.catatan = $('#rv-catatan').value.trim(); }
    const next = modal.pageNo + delta;
    if (doc && next >= 1 && next <= doc.pages.length) {
      modal.pageNo = next; modal.zoom = 1; renderModal(); renderReview();
    }
  }

  function tandaiSemuaReview() {
    const doc = aktifDoc();
    if (!doc) return;
    if (!confirm('Tandai SEMUA halaman pada file ini sebagai sudah dikoreksi 2×?')) return;
    doc.pages.forEach(p => { p.reviewCount = Math.max(p.reviewCount || 0, 2); });
    renderSemua();
    toast('Semua halaman ditandai sudah 2× dikoreksi', 'ok');
  }

  function resetKoreksi() {
    const doc = aktifDoc();
    if (!doc || !confirm('Kembalikan semua halaman ke hasil deteksi otomatis?')) return;
    doc.pages.forEach(p => {
      if (p.autoMode) { p.mode = p.autoMode; p.kategori = p.autoKategori; }
      p.edited = false; p.reviewCount = 0; p.catatan = '';
    });
    hitungDokumen(doc); renderSemua();
    toast('Koreksi dikembalikan ke deteksi otomatis', 'ok');
  }

  /* =========================================================================
     E. ORDER & PENGATURAN
     ======================================================================= */
  function renderOrder() {
    const o = hitungOrder();
    $('#order-subtotal').textContent = rupiah(o.subtotal);
    $('#order-diskon').textContent = '- ' + rupiah(o.diskon) + (o.diskonPersen ? ' (' + angka(o.diskonPersen) + '%)' : '');
    $('#order-biaya').textContent = rupiah(o.biaya);
    $('#order-total').textContent = rupiah(o.total);
    $('#order-halaman').textContent = o.halaman + ' halaman';
    $('#order-minimal').style.display = o.kurang > 0 ? 'flex' : 'none';
    $('#order-minimal').innerHTML = '<i class="fa-solid fa-circle-info"></i> Di bawah minimal order ' +
      rupiah(o.minimal) + ' — kurang ' + rupiah(o.kurang) + '.';
  }

  function renderPengaturan() {
    $('#set-nama-toko').value = state.umum.nama_toko || '';
    $('#set-kontak').value = state.umum.kontak || '';
    $('#set-catatan-nota').value = state.umum.catatan_nota || '';
    $('#set-kosong').value = state.umum.ambang_kosong;
    $('#set-hampir').value = state.umum.ambang_hampir;
    $('#set-penuh').value = state.umum.ambang_penuh;
    $('#set-warna').value = state.umum.ambang_warna;
    $('#set-harga-kosong').value = state.umum.harga_kosong;
    $('#set-minimal').value = state.umum.minimal_order;
    $('#set-biaya').value = state.umum.biaya_tambahan;
    $('#set-diskon').value = state.umum.diskon_persen;
    $('#set-kualitas').value = state.umum.kualitas || 'seimbang';

    const grid = $('#set-rules');
    grid.innerHTML = '';
    state.rules.forEach(r => {
      const card = document.createElement('div');
      card.className = 'rule-card' + (r.aktif ? '' : ' nonaktif');
      card.innerHTML =
        '<div class="rule-head"><span class="pill pill-' + r.mode + '">' + MODE_LABEL[r.mode] + '</span>' +
        '<span class="pill pill-kat">' + KATEGORI_LABEL[r.kategori] + '</span></div>' +
        '<label class="rule-nama">Nama aturan<input type="text" value="' + escapeAttr(r.nama) + '" data-f="nama"></label>' +
        '<label class="rule-harga">Harga per halaman (Rp)<input type="number" min="0" step="50" value="' + r.harga + '" data-f="harga"></label>' +
        '<label class="switch"><input type="checkbox" data-f="aktif" ' + (r.aktif ? 'checked' : '') + '> <span>Pakai aturan ini</span></label>';
      card.querySelectorAll('[data-f]').forEach(inp => {
        inp.addEventListener('input', () => {
          const f = inp.dataset.f;
          r[f] = f === 'aktif' ? inp.checked : (f === 'harga' ? (parseFloat(inp.value) || 0) : inp.value);
          card.classList.toggle('nonaktif', !r.aktif);
          hitungSemua(); renderOrder();
        });
      });
      grid.appendChild(card);
    });
  }

  function bacaPengaturanDariForm() {
    state.umum.nama_toko = $('#set-nama-toko').value.trim();
    state.umum.kontak = $('#set-kontak').value.trim();
    state.umum.catatan_nota = $('#set-catatan-nota').value.trim();
    state.umum.ambang_kosong = parseFloat($('#set-kosong').value) || 0;
    state.umum.ambang_hampir = parseFloat($('#set-hampir').value) || 0;
    state.umum.ambang_penuh = parseFloat($('#set-penuh').value) || 0;
    state.umum.ambang_warna = parseFloat($('#set-warna').value) || 0;
    state.umum.harga_kosong = parseFloat($('#set-harga-kosong').value) || 0;
    state.umum.minimal_order = parseFloat($('#set-minimal').value) || 0;
    state.umum.biaya_tambahan = parseFloat($('#set-biaya').value) || 0;
    state.umum.diskon_persen = parseFloat($('#set-diskon').value) || 0;
    state.umum.kualitas = $('#set-kualitas').value;
  }

  function hitungSemua() { state.docs.forEach(hitungDokumen); }

  async function simpanPengaturanKlik() {
    bacaPengaturanDariForm();
    const ok = await simpanPengaturan();
    hitungSemua(); renderPengaturan(); renderSemua();
    toast(ok ? 'Pengaturan tersimpan (tersinkron ke server)' : 'Pengaturan tersimpan di perangkat ini (server tidak tersedia)', ok ? 'ok' : 'warn');
  }

  function resetPengaturan() {
    if (!confirm('Kembalikan semua harga & parameter ke pengaturan awal?')) return;
    state.umum = Object.assign({}, DEFAULT_UMUM);
    state.rules = DEFAULT_RULES.map(r => Object.assign({}, r));
    simpanPengaturan(); hitungSemua(); renderPengaturan(); renderSemua();
    toast('Pengaturan dikembalikan ke awal', 'ok');
  }

  /* =========================================================================
     F. RIWAYAT ORDER
     ======================================================================= */
  function renderRiwayat() {
    const wrap = $('#riwayat-list');
    if (!state.history.length) { wrap.innerHTML = '<p class="kosong-info">Belum ada riwayat order yang disimpan.</p>'; return; }
    wrap.innerHTML = '';
    state.history.slice().reverse().forEach(o => {
      const el = document.createElement('article');
      el.className = 'riwayat-item';
      const tgl = new Date(o.tanggal);
      el.innerHTML =
        '<div class="riwayat-head">' +
          '<div><strong>' + escapeAttr(o.nama_pelanggan || '(tanpa nama)') + '</strong>' +
          '<span class="riwayat-tgl">' + tgl.toLocaleString('id-ID') + '</span></div>' +
          '<div class="riwayat-total">' + rupiah(o.total) + '</div>' +
        '</div>' +
        '<div class="riwayat-meta">' + o.jumlah_halaman + ' halaman • ' + o.jumlah_warna + ' warna • ' + o.jumlah_hp + ' hitam putih • rangkap ' + o.rangkap + '</div>' +
        '<div class="riwayat-file">' + escapeAttr(o.nama_file) + '</div>' +
        '<div class="riwayat-aksi">' +
          '<button class="btn btn-ghost btn-kecil" data-act="detail"><i class="fa-solid fa-circle-info"></i> Detail</button>' +
          '<button class="btn btn-ghost btn-kecil" data-act="hapus"><i class="fa-solid fa-trash"></i> Hapus</button>' +
        '</div>' +
        '<div class="riwayat-detail" style="display:none">' + (o.detail || '') + '</div>';
      el.querySelector('[data-act="detail"]').addEventListener('click', () => {
        const d = el.querySelector('.riwayat-detail');
        d.style.display = d.style.display === 'none' ? 'block' : 'none';
      });
      el.querySelector('[data-act="hapus"]').addEventListener('click', async () => {
        if (!confirm('Hapus riwayat order ini?')) return;
        state.history = state.history.filter(x => x.id !== o.id);
        tulisLS(LS_HIS, state.history);
        try { await fetch('tables/riwayat_order/' + encodeURIComponent(o.id), { method: 'DELETE' }); } catch (e) {}
        renderRiwayat();
      });
      wrap.appendChild(el);
    });
  }

  function detailOrderHtml() {
    if (!state.docs.length) return '';
    let html = '<div class="detail-order">';
    state.docs.forEach(d => {
      html += '<div class="detail-doc"><strong>' + escapeAttr(d.nama) + '</strong> (' + d.pages.length + ' hal × ' + d.rangkap + ')';
      html += '<ul>';
      const r = d.ringkas;
      html += '<li>Warna — gambar penuh: ' + r.warnaPenuh + ' hal</li>';
      html += '<li>Warna — hampir penuh: ' + r.warnaHampir + ' hal</li>';
      html += '<li>Warna — biasa: ' + r.warnaBiasa + ' hal</li>';
      html += '<li>Hitam putih — gambar penuh: ' + r.hpPenuh + ' hal</li>';
      html += '<li>Hitam putih — hampir penuh: ' + r.hpHampir + ' hal</li>';
      html += '<li>Hitam putih — biasa: ' + r.hpBiasa + ' hal</li>';
      if (r.kosong) html += '<li>Halaman kosong: ' + r.kosong + ' hal</li>';
      html += '</ul><div class="detail-sub">Subtotal: ' + rupiah(d.subtotal) + '</div></div>';
    });
    html += '</div>';
    return html;
  }

  async function simpanOrder() {
    if (!state.docs.length) { toast('Belum ada file untuk disimpan.', 'warn'); return; }
    const o = hitungOrder();
    const nama = $('#order-pelanggan').value.trim() || '(tanpa nama)';
    const totalWarna = state.docs.reduce((a, d) => a + d.ringkas.warna, 0) * 1;
    const totalHp = state.docs.reduce((a, d) => a + d.ringkas.hp, 0);
    const totalKosong = state.docs.reduce((a, d) => a + d.ringkas.kosong, 0);
    const rangkap = state.docs.reduce((a, d) => a + (Number(d.rangkap) || 1), 0);
    const rec = {
      id: 'order' + Date.now(),
      nama_pelanggan: nama,
      nama_file: state.docs.map(d => d.nama).join(', '),
      jenis_file: state.docs.map(d => d.jenis).join(', '),
      jumlah_halaman: o.halaman,
      jumlah_warna: totalWarna,
      jumlah_hp: totalHp,
      jumlah_kosong: totalKosong,
      rangkap: rangkap,
      subtotal: o.subtotal,
      biaya_tambahan: o.biaya,
      diskon_persen: o.diskonPersen,
      total: o.total,
      detail: detailOrderHtml(),
      catatan: $('#order-catatan').value.trim(),
      tanggal: new Date().toISOString()
    };
    state.history.push(rec);
    tulisLS(LS_HIS, state.history);
    try {
      await fetch('tables/riwayat_order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec)
      });
    } catch (e) {}
    renderRiwayat();
    toast('Order disimpan: ' + rupiah(o.total), 'ok');
  }

  function eksporCSV() {
    if (!state.history.length) { toast('Belum ada riwayat untuk diekspor.', 'warn'); return; }
    const head = ['Tanggal', 'Pelanggan', 'File', 'Halaman', 'Warna', 'HitamPutih', 'Kosong', 'Rangkap', 'Subtotal', 'BiayaTambahan', 'DiskonPersen', 'Total', 'Catatan'];
    const rows = state.history.map(o => [
      new Date(o.tanggal).toLocaleString('id-ID'), o.nama_pelanggan, o.nama_file, o.jumlah_halaman,
      o.jumlah_warna, o.jumlah_hp, o.jumlah_kosong, o.rangkap, o.subtotal, o.biaya_tambahan, o.diskon_persen, o.total, o.catatan || ''
    ]);
    const csv = [head].concat(rows).map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'riwayat-order-printing.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Riwayat diekspor ke CSV', 'ok');
  }

  /* =========================================================================
     H. MODE CONTOH (buka dengan menambahkan #demo pada alamat)
     Membuat dokumen contoh dari kanvas, lalu dianalisa oleh mesin yang sama
     seperti file asli — berguna untuk menguji tampilan review & koreksi.
     ======================================================================= */
  function kanvasContoh(w, h, gambar) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    gambar(ctx, w, h);
    return c;
  }

  function gambarTeks(ctx, w, h, warna) {
    ctx.fillStyle = warna; ctx.font = '600 17px Nunito, Arial';
    for (let i = 0; i < 22; i++) {
      ctx.fillText('Baris contoh dokumen nomor ' + (i + 1) + ' — digital printing.', 60, 90 + i * 38);
    }
  }

  function gambarPenuh(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#f59e0b'); g.addColorStop(0.5, '#dc2626'); g.addColorStop(1, '#6d28d9');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    for (let y = 40; y < h; y += 70) ctx.fillRect(40, y, w - 80, 26);
  }

  function gambarHampir(ctx, w, h) {
    ctx.fillStyle = '#2563eb';
    ctx.fillRect(w * 0.12, h * 0.12, w * 0.76, h * 0.66);
    ctx.fillStyle = '#fff'; ctx.font = '700 26px Outfit, Arial';
    ctx.fillText('FOTO UKURAN BESAR', w * 0.18, h * 0.45);
    ctx.fillStyle = '#111'; ctx.font = '15px Nunito, Arial';
    ctx.fillText('Keterangan singkat di bawah gambar.', w * 0.12, h * 0.86);
  }

  function buatDemo() {
    const w = 794, h = 1123;
    const src = [
      kanvasContoh(w, h, (c) => gambarTeks(c, w, h, '#111111')),           // hp / biasa
      kanvasContoh(w, h, (c) => gambarTeks(c, w, h, '#d31f1f')),           // warna / biasa
      kanvasContoh(w, h, (c) => gambarHampir(c, w, h)),                    // warna / hampir penuh
      kanvasContoh(w, h, (c) => gambarPenuh(c, w, h)),                     // warna / penuh
      kanvasContoh(w, h, () => {})                                         // kosong
    ];
    const pages = src.map((cv, i) => {
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const metrics = Analyzer.analyzeCanvas(ctx, w, h, state.umum, Analyzer.KUALITAS[state.umum.kualitas] || Analyzer.KUALITAS.seimbang);
      const k = Analyzer.klasifikasi(metrics, state.umum);
      return {
        no: i + 1, mode: k.mode, kategori: k.kategori, autoMode: k.mode, autoKategori: k.kategori,
        konfiden: k.konfiden, alasan: k.alasan, edited: false, catatan: '', metrics: metrics,
        thumb: Analyzer.canvasToDataUrl(cv, 170, 0.72),
        preview: Analyzer.canvasToDataUrl(cv, 820, 0.8),
        info: 'Halaman contoh'
      };
    });
    const doc = {
      uid: 'demo1', nama: 'CONTOH-dokumen-pelanggan.pdf', ukuran: 0, jenis: 'pdf',
      pages: pages, note: 'Ini dokumen CONTOH. Unggah file asli untuk memakai alat ini sebenarnya.',
      source: { type: 'html' }, rangkap: 1, buatTanggal: new Date().toISOString()
    };
    hitungDokumen(doc);
    state.docs.push(doc);
    state.activeDoc = doc.uid;
    renderSemua();
    pindahPanel('panel-hasil');
    toast('Menampilkan dokumen contoh (5 halaman)', 'ok');
  }

  /* Cetak nota / penawaran harga untuk pelanggan */
  function cetakNota() {
    if (!state.docs.length) { toast('Belum ada file untuk dibuatkan nota.', 'warn'); return; }
    const o = hitungOrder();
    const nama = $('#order-pelanggan').value.trim() || '(tanpa nama)';
    const u = state.umum;

    let baris = '';
    state.docs.forEach(d => {
      const r = d.ringkas;
      baris += '<tr><td colspan="4" class="doc-nama">' + esc(d.nama) + ' — ' + d.pages.length + ' halaman × ' + (d.rangkap || 1) + ' rangkap</td></tr>';
      const grup = [
        ['warna', 'penuh', r.warnaPenuh], ['warna', 'hampir', r.warnaHampir], ['warna', 'biasa', r.warnaBiasa],
        ['hp', 'penuh', r.hpPenuh], ['hp', 'hampir', r.hpHampir], ['hp', 'biasa', r.hpBiasa]
      ];
      grup.forEach(g => {
        if (!g[2]) return;
        const rl = ruleUntuk(g[0], g[1]);
        const h = rl ? Number(rl.harga) || 0 : 0;
        baris += '<tr><td>' + MODE_LABEL[g[0]] + ' — ' + KATEGORI_LABEL[g[1]] + '</td><td class="c">' + g[2] + '</td>' +
          '<td class="r">' + rupiah(h) + '</td><td class="r">' + rupiah(h * g[2]) + '</td></tr>';
      });
      if (r.kosong) baris += '<tr class="redup"><td>Halaman kosong</td><td class="c">' + r.kosong + '</td><td class="r">' +
        rupiah(u.harga_kosong) + '</td><td class="r">' + rupiah((u.harga_kosong || 0) * r.kosong) + '</td></tr>';
      baris += '<tr class="sub"><td colspan="3">Sub-total ' + esc(d.nama) + ' (× ' + (d.rangkap || 1) + ')</td><td class="r">' + rupiah(d.subtotal) + '</td></tr>';
    });

    // Daftar tiap halaman (untuk pemeriksaan pemilik usaha)
    let halaman = '';
    state.docs.forEach(d => {
      halaman += '<p class="hal-judul">' + esc(d.nama) + '</p><p class="hal-isi">';
      halaman += d.pages.map(p => 'Hal ' + p.no + ': ' + MODE_LABEL[p.mode] + '/' + KATEGORI_LABEL[p.kategori] + ' (' + rupiah(p.harga) + ')').join(' • ');
      halaman += '</p>';
    });

    const isi =
      '<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><title>Nota ' + esc(nama) + '</title>' +
      '<style>' +
      '@page{margin:14mm}body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:12.5px}' +
      'h1{font-size:19px;margin:0 0 2px}h2{font-size:13px;margin:0;font-weight:normal;color:#555}' +
      '.head{display:flex;justify-content:space-between;border-bottom:2px solid #333;padding-bottom:10px;margin-bottom:14px}' +
      'table{width:100%;border-collapse:collapse;margin-top:8px}' +
      'th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}' +
      'th{background:#f3f3f3;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px}' +
      '.r{text-align:right}.c{text-align:center}' +
      '.doc-nama{background:#f8f8f8;font-weight:bold;padding-top:10px}' +
      '.sub td{font-weight:bold;background:#fcfcfc}' +
      '.redup td{color:#777}' +
      '.tot{margin-top:14px;font-size:13px}.tot div{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #ccc}' +
      '.tot .grand{font-size:18px;font-weight:bold;border-bottom:none;border-top:2px solid #333;margin-top:6px;padding-top:10px}' +
      '.catatan{margin-top:16px;font-size:11.5px;color:#555;border-top:1px solid #eee;padding-top:10px}' +
      '.hal{page-break-before:always;margin-top:20px}.hal-isi{color:#333;line-height:1.7}.hal-judul{font-weight:bold;margin:10px 0 2px}' +
      '</style></head><body>' +
      '<div class="head"><div><h1>' + esc(u.nama_toko || 'Digital Printing') + '</h1>' +
      '<h2>' + esc(u.kontak || '') + '</h2></div><div style="text-align:right"><strong>Nota / Penawaran Cetak</strong><br>' +
      new Date().toLocaleString('id-ID') + '<br>Pelanggan: ' + esc(nama) + '</div></div>' +
      '<table><thead><tr><th>Jenis halaman</th><th class="c">Jumlah</th><th class="r">Harga</th><th class="r">Subtotal</th></tr></thead>' +
      '<tbody>' + baris + '</tbody></table>' +
      '<div class="tot">' +
        '<div><span>Subtotal cetak</span><span>' + rupiah(o.subtotal) + '</span></div>' +
        '<div><span>Diskon' + (o.diskonPersen ? ' (' + angka(o.diskonPersen) + '%)' : '') + '</span><span>- ' + rupiah(o.diskon) + '</span></div>' +
        '<div><span>Biaya tambahan</span><span>' + rupiah(o.biaya) + '</span></div>' +
        '<div class="grand"><span>TOTAL</span><span>' + rupiah(o.total) + '</span></div>' +
      '</div>' +
      '<div class="catatan">' + esc(u.catatan_nota || '') +
      ($('#order-catatan').value.trim() ? '<br><strong>Catatan pesanan:</strong> ' + esc($('#order-catatan').value.trim()) : '') + '</div>' +
      '<div class="hal"><h1 style="font-size:15px">Daftar per halaman</h1>' + halaman + '</div>' +
      '</body></html>';

    const w = window.open('', '_blank');
    if (!w) { toast('Jendela cetak diblokir browser. Izinkan popup lalu coba lagi.', 'warn'); return; }
    w.document.open(); w.document.write(isi); w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch (e) {} }, 400);
    toast('Nota siap dicetak', 'ok');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* =========================================================================
     G. NAVIGASI PANEL & INISIALISASI
     ======================================================================= */
  function pindahPanel(id) {
    $$('.panel').forEach(p => p.classList.toggle('aktif', p.id === id));
    $$('.nav-btn').forEach(b => b.classList.toggle('aktif', b.dataset.panel === id));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function pasangEvent() {
    // Navigasi
    $$('.nav-btn').forEach(b => b.addEventListener('click', () => pindahPanel(b.dataset.panel)));

    // Unggah file
    $('#file-input').addEventListener('change', e => { tambahFile(e.target.files); e.target.value = ''; });
    $('#dropzone').addEventListener('click', () => $('#file-input').click());
    ['dragenter', 'dragover'].forEach(ev => $('#dropzone').addEventListener(ev, e => {
      e.preventDefault(); $('#dropzone').classList.add('dragging');
    }));
    ['dragleave', 'drop'].forEach(ev => $('#dropzone').addEventListener(ev, e => {
      e.preventDefault(); $('#dropzone').classList.remove('dragging');
    }));
    $('#dropzone').addEventListener('drop', e => tambahFile(e.dataTransfer.files));

    // Aksi review massal
    $('#btn-tandai-review').addEventListener('click', tandaiSemuaReview);
    $('#btn-reset-koreksi').addEventListener('click', resetKoreksi);

    // Modal review
    $('#rv-tutup').addEventListener('click', tutupReview);
    $('#modal-review').addEventListener('click', e => { if (e.target.id === 'modal-review') tutupReview(); });
    $('#rv-zoom-in').addEventListener('click', () => ubahZoom(0.25));
    $('#rv-zoom-out').addEventListener('click', () => ubahZoom(-0.25));
    $('#rv-zoom-reset').addEventListener('click', () => { modal.zoom = 1; renderModal(); });
    $('#rv-prev').addEventListener('click', () => navigasiHalaman(-1));
    $('#rv-next').addEventListener('click', () => navigasiHalaman(1));
    $('#rv-konfirmasi').addEventListener('click', konfirmasiHalaman);
    $$('#rv-mode button').forEach(b => b.addEventListener('click', () => {
      const p = halamanAktif(); if (p) koreksi(b.dataset.mode, p.kategori === 'kosong' ? 'biasa' : p.kategori);
    }));
    $$('#rv-kat button').forEach(b => b.addEventListener('click', () => {
      const p = halamanAktif(); if (p) koreksi(b.dataset.kat === 'kosong' ? 'hp' : p.mode, b.dataset.kat);
    }));
    $('#rv-catatan').addEventListener('change', e => {
      const p = halamanAktif(); if (p) { p.catatan = e.target.value.trim(); renderReview(); }
    });
    document.addEventListener('keydown', e => {
      if (!$('#modal-review').classList.contains('aktif')) return;
      if (e.key === 'Escape') tutupReview();
      if (e.key === 'ArrowRight') navigasiHalaman(1);
      if (e.key === 'ArrowLeft') navigasiHalaman(-1);
      if (e.key === '+' || e.key === '=') ubahZoom(0.25);
      if (e.key === '-') ubahZoom(-0.25);
    });

    // Order
    $('#btn-simpan-order').addEventListener('click', simpanOrder);
    $('#btn-cetak-nota').addEventListener('click', cetakNota);
    $('#btn-ekspor').addEventListener('click', eksporCSV);

    // Pengaturan
    $('#btn-simpan-set').addEventListener('click', simpanPengaturanKlik);
    $('#btn-reset-set').addEventListener('click', resetPengaturan);
  }

  function halamanAktif() {
    const doc = state.docs.find(d => d.uid === modal.docUid);
    return doc ? doc.pages.find(x => x.no === modal.pageNo) : null;
  }

  async function init() {
    // Tampilkan UI lebih dulu (memakai pengaturan bawaan / tersimpan di perangkat)
    renderPengaturan();
    renderRiwayat();
    pasangEvent();
    const lokal = bacaLS(LS_SET, null);
    if (lokal) {
      if (lokal.umum) Object.keys(DEFAULT_UMUM).forEach(k => { if (lokal.umum[k] !== undefined) state.umum[k] = lokal.umum[k]; });
      if (Array.isArray(lokal.rules)) lokal.rules.forEach(lr => {
        const f = state.rules.find(r => r.id === lr.id); if (f) Object.assign(f, lr);
      });
      renderPengaturan();
    }
    state.history = bacaLS(LS_HIS, []) || [];
    renderRiwayat();
    renderSemua();

    // Hook bantu (untuk pengecekan teknis)
    window.PrintCost = {
      state: state, renderSemua: renderSemua, pindahPanel: pindahPanel,
      bukaReview: bukaReview, tambahFile: tambahFile, buatDemo: buatDemo
    };

    const tanda = (location.hash || '') + (location.search || '');
    if (tanda.indexOf('demo') >= 0) buatDemo();
    if (tanda.indexOf('review') >= 0) {
      buatDemo();
      setTimeout(() => bukaReview('demo1', 5), 400);
    }

    // Sinkron pengaturan dari server di belakang (tidak menghambat tampilan)
    await muatPengaturan();
    renderPengaturan();
    renderSemua();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

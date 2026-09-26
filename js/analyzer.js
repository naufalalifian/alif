/* ============================================================================
   analyzer.js — Mesin pembaca & analisa halaman dokumen
   ----------------------------------------------------------------------------
   Tugas:
     1. Membaca file PDF / Word (.docx) / Excel / PowerPoint / teks / gambar
        langsung di browser (tanpa upload ke server).
     2. Mengubah setiap halaman menjadi gambar (canvas).
     3. Menganalisa tiap halaman untuk menentukan:
          - apakah halaman memakai WARNA atau HITAM PUTIH
          - seberapa besar gambar pada halaman itu (penuh / hampir penuh / biasa)
          - apakah halaman kosong
     4. Menyiapkan thumbnail + pratinjau besar supaya bisa di-review & dikoreksi.

   Modul ini tidak menyimpan harga; hanya mengembalikan hasil deteksi.
   ========================================================================= */
(function (global) {
  'use strict';

  /* ----------------------------- Konstanta ------------------------------ */
  const A4_W = 794;          // lebar A4 dalam px @96dpi
  const A4_H = 1123;         // tinggi A4
  const PAD = 48;            // margin halaman render (px)
  const MAX_AUTO_PAGES = 60; // batas halaman yang dianalisa otomatis
  const THUMB_W = 170;       // lebar thumbnail
  const PREVIEW_W = 820;     // lebar pratinjau simpan (untuk dokumen HTML)

  // Tingkat ketelitian: makin teliti makin lambat tapi makin akurat
  const KUALITAS = {
    cepat:    { renderWidth: 520,  cellDiv: 78,  dense: 0.42, minArea: 0.26 },
    seimbang: { renderWidth: 720,  cellDiv: 110, dense: 0.36, minArea: 0.20 },
    teliti:   { renderWidth: 1000, cellDiv: 150, dense: 0.30, minArea: 0.15 }
  };

  /* ------------------------- Pemuatan pustaka CDN ------------------------ */
  const LIBS = {
    pdfjs:       { url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', check: () => global.pdfjsLib },
    jszip:       { url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', check: () => global.JSZip },
    mammoth:     { url: 'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js', check: () => global.mammoth },
    xlsx:        { url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', check: () => global.XLSX },
    html2canvas: { url: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js', check: () => global.html2canvas }
  };

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Gagal memuat ' + url));
      document.head.appendChild(s);
    });
  }

  async function ensureLib(name) {
    const lib = LIBS[name];
    if (lib.check()) return lib.check();
    await loadScript(lib.url);
    if (lib.check()) return lib.check();
    throw new Error('Pustaka ' + name + ' tidak tersedia (periksa koneksi internet).');
  }

  /* ---------------------------- Utilitas --------------------------------- */
  function canvasToDataUrl(src, targetW, quality) {
    const ratio = Math.min(1, targetW / src.width);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * ratio));
    c.height = Math.max(1, Math.round(src.height * ratio));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality || 0.72);
  }

  function waitImages(root) {
    const imgs = Array.prototype.slice.call(root.querySelectorAll('img'));
    return Promise.all(imgs.map(img => new Promise(res => {
      if (img.complete && img.naturalWidth) return res();
      img.onload = img.onerror = () => res();
      setTimeout(res, 4000);
    })));
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function tidur(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* =======================================================================
     ANALISA PIKSEL — inti penilaian halaman
     =======================================================================
     Untuk setiap halaman kita ukur:
       inkPct      : persentase piksel bertinta (teks/gambar) dari seluruh halaman
       coloredPct  : persentase piksel BERWARNA dari seluruh halaman
       clusterArea : luas area gambar padat terbesar (0..1) — menunjukkan
                     seberapa besar "gambar" pada halaman itu
       clusterBBox : sebaran area gambar padat (0..1) — kira-kira berapa
                     bagian halaman yang tertutup gambar
     Teks biasa hanya menghasilkan goresan tipis sehingga kepadatan selnya
     rendah; foto/gambar menghasilkan area padat yang besar.
     ======================================================================= */
  function analyzeCanvas(ctx, w, h, cfg, q) {
    const data = ctx.getImageData(0, 0, w, h).data;
    const total = w * h;
    let ink = 0, colored = 0;

    const cell = Math.max(4, Math.round(w / q.cellDiv));
    const cols = Math.max(1, Math.ceil(w / cell));
    const rows = Math.max(1, Math.ceil(h / cell));
    const dens = new Float32Array(cols * rows);
    const cellArea = cell * cell;

    let minX = w, minY = h, maxX = -1, maxY = -1;

    for (let y = 0; y < h; y++) {
      const cy = (y / cell) | 0;
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        const i = (rowOff + x) << 2;
        if (data[i + 3] < 24) continue;                 // transparan = kertas
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const sat = mx - mn;                            // tingkat kejenuhan warna
        const lum = (r * 299 + g * 587 + b * 114) / 1000; // kecerahan
        const isInk = lum < 232 || sat > 28;
        if (!isInk) continue;

        ink++;
        if (sat > 42 && lum > 25 && lum < 246) colored++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        dens[cy * cols + ((x / cell) | 0)] += 1;
      }
    }

    // Sel "padat" = sel yang mayoritas isinya tinta (ciri gambar/foto)
    const dense = new Uint8Array(cols * rows);
    for (let k = 0; k < dens.length; k++) {
      if (dens[k] / cellArea >= q.dense) dense[k] = 1;
    }

    const cluster = largestCluster(dense, cols, rows);
    const cellTotal = cols * rows;

    return {
      inkPct: ink / total * 100,
      coloredPct: colored / total * 100,
      coloredShare: ink ? colored / ink * 100 : 0,
      clusterArea: cluster.count / cellTotal,
      clusterBBox: cluster.count ? ((cluster.x2 - cluster.x1 + 1) * (cluster.y2 - cluster.y1 + 1)) / cellTotal : 0,
      sudut: {
        kiri: minX / w, atas: minY / h,
        kanan: maxX >= 0 ? (maxX + 1) / w : 0,
        bawah: maxY >= 0 ? (maxY + 1) / h : 0
      },
      kosong: ink === 0
    };
  }

  /* Komponen terhubung (8 arah) terbesar dari sel padat */
  function largestCluster(dense, cols, rows) {
    const seen = new Uint8Array(cols * rows);
    const stack = [];
    let best = { count: 0, x1: 0, y1: 0, x2: 0, y2: 0 };
    for (let i = 0; i < dense.length; i++) {
      if (!dense[i] || seen[i]) continue;
      let count = 0, x1 = cols, y1 = rows, x2 = -1, y2 = -1;
      stack.push(i); seen[i] = 1;
      while (stack.length) {
        const k = stack.pop();
        count++;
        const cx = k % cols, cy = (k / cols) | 0;
        if (cx < x1) x1 = cx;
        if (cx > x2) x2 = cx;
        if (cy < y1) y1 = cy;
        if (cy > y2) y2 = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const nk = ny * cols + nx;
            if (dense[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
          }
        }
      }
      if (count > best.count) best = { count: count, x1: x1, y1: y1, x2: x2, y2: y2 };
    }
    return best;
  }

  /* =======================================================================
     KLASIFIKASI — terapkan aturan yang bisa diatur pemilik usaha
     ======================================================================= */
  function klasifikasi(m, cfg) {
    if (m.inkPct < (cfg.ambang_kosong || 0)) {
      return { mode: 'hp', kategori: 'kosong', konfiden: 'tinggi', alasan: 'Halaman hampir kosong' };
    }

    const ambWarna = cfg.ambang_warna || 0.05;
    const mode = m.coloredPct >= ambWarna ? 'warna' : 'hp';
    // Jelas berwarna atau jelas hitam-putih = yakin; hanya area abu-abu di
    // sekitar ambang yang perlu dicek manual.
    const jelasWarna = m.coloredPct >= ambWarna * 3;
    const jelasHp = m.coloredPct <= ambWarna * 0.4;
    const konfidenWarna = jelasWarna ? 'tinggi' : (jelasHp ? 'tinggi' : 'rendah');

    let kategori = 'biasa', alasan = 'Tulisan/gambar berukuran biasa';
    const ambPenuh = (cfg.ambang_penuh || 70) / 100;
    const ambHampir = (cfg.ambang_hampir || 45) / 100;

    if (m.clusterBBox >= ambPenuh && m.clusterArea >= 0.28) {
      kategori = 'penuh';
      alasan = 'Ada gambar yang menutup hampir seluruh halaman';
    } else if (m.clusterBBox >= ambHampir && m.clusterArea >= 0.16) {
      kategori = 'hampir';
      alasan = 'Ada gambar besar (hampir penuh halaman)';
    }

    return {
      mode: mode, kategori: kategori,
      konfiden: konfidenWarna,
      alasan: alasan + (konfidenWarna === 'rendah' ? ' • warna tipis / mendekati ambang, mohon dicek' : '')
    };
  }

  function buatHalaman(no, metrics, cfg, thumb, preview, info) {
    const k = klasifikasi(metrics, cfg);
    return {
      no: no,
      mode: k.mode,
      kategori: k.kategori,
      autoMode: k.mode,
      autoKategori: k.kategori,
      konfiden: k.konfiden,
      alasan: k.alasan,
      edited: false,
      catatan: '',
      metrics: metrics,
      thumb: thumb || null,
      preview: preview || null,
      info: info || ''
    };
  }

  /* =======================================================================
     PIPELINE PDF
     ======================================================================= */
  async function analyzePdf(file, cfg, onProgress, onPhase) {
    const pdfjsLib = await ensureLib('pdfjs');
    if (onPhase) onPhase('Memuat PDF…');
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const q = KUALITAS[cfg.kualitas] || KUALITAS.seimbang;
    const pages = [];
    const total = pdf.numPages;

    for (let i = 1; i <= total; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(q.renderWidth / base.width, 2.6);
      const vp = page.getViewport({ scale: scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(vp.width));
      canvas.height = Math.max(1, Math.ceil(vp.height));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const metrics = analyzeCanvas(ctx, canvas.width, canvas.height, cfg, q);
      const thumb = canvasToDataUrl(canvas, THUMB_W, 0.7);
      pages.push(buatHalaman(i, metrics, cfg, thumb, null));
      page.cleanup();
      if (onProgress) onProgress(i, total);
      if (i % 4 === 0) await tidur(0); // beri napas ke UI
    }

    return {
      kind: 'pdf', pageCount: total, pages: pages,
      source: { type: 'pdf', file: file, pdf: pdf },
      note: 'PDF dianalisa otomatis per halaman. Pratinjau bisa diperbesar pada mode review.'
    };
  }

  /* Render ulang satu halaman PDF dengan resolusi tinggi (untuk diperbesar) */
  async function renderPdfPreview(source, pageNo, targetWidth) {
    const base = await source.pdf.getPage(pageNo);
    const vp1 = base.getViewport({ scale: 1 });
    const scale = Math.min(Math.max(targetWidth / vp1.width, 0.5), 4);
    const vp = base.getViewport({ scale: scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await base.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvasToDataUrl(canvas, canvas.width, 0.86);
  }

  /* =======================================================================
     PIPELINE GAMBAR (jpg/png/webp/bmp)
     ======================================================================= */
  async function analyzeImage(file, cfg, onProgress, onPhase) {
    if (onPhase) onPhase('Membaca gambar…');
    const q = KUALITAS[cfg.kualitas] || KUALITAS.seimbang;
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('Gambar tidak bisa dibaca.'));
      im.src = url;
    });

    const ratio = Math.min(1, q.renderWidth / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const metrics = analyzeCanvas(ctx, canvas.width, canvas.height, cfg, q);
    // Satu file gambar = satu halaman cetak; gambar pasti memenuhi halaman
    metrics.clusterArea = Math.max(metrics.clusterArea, 0.35);
    metrics.clusterBBox = Math.max(metrics.clusterBBox, 0.85);

    const thumb = canvasToDataUrl(canvas, THUMB_W, 0.7);
    const preview = canvasToDataUrl(canvas, PREVIEW_W, 0.8);
    URL.revokeObjectURL(url);
    if (onProgress) onProgress(1, 1);
    return {
      kind: 'image', pageCount: 1,
      pages: [buatHalaman(1, metrics, cfg, thumb, preview, '1 file gambar = 1 halaman cetak')],
      source: { type: 'image' },
      note: 'Satu file gambar dihitung satu halaman cetak.'
    };
  }

  /* =======================================================================
     PIPELINE HTML -> halaman A4 (dipakai Word/Excel/PowerPoint/teks)
     ======================================================================= */
  function ukuranHalaman() { return { w: A4_W, h: A4_H, usable: A4_H - PAD }; }

  async function htmlToPages(html, cfg, onProgress, onPhase, label) {
    const q = KUALITAS[cfg.kualitas] || KUALITAS.seimbang;
    const html2canvas = await ensureLib('html2canvas');

    const holder = document.createElement('div');
    holder.className = 'doc-render-holder';

    // Ukur dulu tinggi konten memakai struktur halaman yang SAMA
    // supaya lebar teks pada pengukuran = lebar teks pada hasil cetak.
    const measurePage = document.createElement('div');
    measurePage.className = 'doc-page';
    const measure = document.createElement('div');
    measure.className = 'doc-slice doc-measure';
    measure.innerHTML = html;
    measurePage.appendChild(measure);
    holder.appendChild(measurePage);
    document.body.appendChild(holder);
    await waitImages(measure);
    await tidur(30);

    const usable = A4_H - PAD;
    const contentH = Math.max(measure.scrollHeight, 1);
    const n = Math.max(1, Math.ceil(contentH / usable));

    if (onPhase) onPhase('Menyusun ' + n + ' halaman…');

    // Bangun wadah halaman (masing-masing memuat potongan dokumen)
    holder.innerHTML = '';
    const pageEls = [];
    for (let i = 0; i < n; i++) {
      const pg = document.createElement('div');
      pg.className = 'doc-page';
      const slice = document.createElement('div');
      slice.className = 'doc-slice';
      // geser konten ke atas sesuai nomor halaman (margin agar andal di html2canvas)
      slice.style.marginTop = (-(i * usable)) + 'px';
      slice.innerHTML = html;
      pg.appendChild(slice);
      holder.appendChild(pg);
      pageEls.push(pg);
    }
    await tidur(50);

    const pages = [];
    const limit = Math.min(n, MAX_AUTO_PAGES);
    const scale = Math.max(0.4, q.renderWidth / A4_W);

    for (let i = 0; i < n; i++) {
      if (i >= limit) {
        pages.push({
          no: i + 1, mode: 'hp', kategori: 'biasa', autoMode: null, autoKategori: null,
          konfiden: 'rendah', alasan: 'Melebihi ' + MAX_AUTO_PAGES + ' halaman: atur manual',
          edited: false, catatan: '', metrics: null, thumb: null, preview: null,
          info: 'Tidak dianalisa otomatis'
        });
        continue;
      }
      let canvas;
      try {
        canvas = await html2canvas(pageEls[i], {
          scale: scale, backgroundColor: '#ffffff', logging: false,
          width: A4_W, height: A4_H
        });
      } catch (e) {
        pages.push({
          no: i + 1, mode: 'hp', kategori: 'biasa', autoMode: null, autoKategori: null,
          konfiden: 'rendah', alasan: 'Pratinjau gagal dibuat: ' + e.message,
          edited: false, catatan: '', metrics: null, thumb: null, preview: null, info: ''
        });
        continue;
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const metrics = analyzeCanvas(ctx, canvas.width, canvas.height, cfg, q);
      const thumb = canvasToDataUrl(canvas, THUMB_W, 0.7);
      const preview = canvasToDataUrl(canvas, PREVIEW_W, 0.78);
      const info = label ? label : '';
      pages.push(buatHalaman(i + 1, metrics, cfg, thumb, preview, info));
      if (onProgress) onProgress(i + 1, n);
      if (i % 3 === 0) await tidur(0);
    }

    holder.remove();
    return {
      kind: 'html', pageCount: n, pages: pages,
      source: { type: 'html' },
      note: n > limit ? ('Hanya ' + limit + ' halaman pertama dianalisa otomatis. Sisanya diatur manual.') : ''
    };
  }

  /* Styling dokumen hasil konversi agar mirip kertas A4 */
  const DOC_STYLE = 'font-family:Nunito,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111;' +
    'word-wrap:break-word;overflow-wrap:break-word;';
  const TABLE_STYLE = 'border-collapse:collapse;width:100%;font-size:12px;';

  /* --------------------------- Word (.docx) ------------------------------ */
  async function analyzeDocx(file, cfg, onProgress, onPhase) {
    const mammoth = await ensureLib('mammoth');
    if (onPhase) onPhase('Membaca dokumen Word…');
    const buf = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: buf }, {
      convertImage: mammoth.images.imgElement(function (image) {
        return image.read('base64').then(function (b64) {
          return { src: 'data:' + image.contentType + ';base64,' + b64 };
        });
      })
    });
    let html = result.value || '';
    html = '<div style="' + DOC_STYLE + '">' + html + '</div>';
    const jumlahGambar = (html.match(/<img/g) || []).length;
    const res = await htmlToPages(html, cfg, onProgress, onPhase,
      jumlahGambar ? (jumlahGambar + ' gambar pada dokumen') : 'Dokumen teks');
    res.kind = 'docx';
    res.note = 'Halaman Word disusun ulang mengikuti ukuran A4. ' +
      'Jumlah halaman & tata letak bisa sedikit berbeda dari Word aslinya — silakan cek lewat review.';
    return res;
  }

  /* ------------------------------- Excel --------------------------------- */
  async function analyzeXlsx(file, cfg, onProgress, onPhase) {
    const XLSX = await ensureLib('xlsx');
    if (onPhase) onPhase('Membaca spreadsheet…');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    let html = '<div style="' + DOC_STYLE + '">';
    wb.SheetNames.forEach(function (name, idx) {
      const ws = wb.Sheets[name];
      const t = XLSX.utils.sheet_to_html(ws);
      html += '<h3 style="margin:' + (idx ? '18px' : '0') + ' 0 8px;font-size:16px;">' + escapeHtml(name) + '</h3>' +
        t.replace('<table', '<table border="1" style="' + TABLE_STYLE + '"');
    });
    html += '</div>';
    const res = await htmlToPages(html, cfg, onProgress, onPhase, wb.SheetNames.length + ' sheet');
    res.kind = 'xlsx';
    res.note = 'Setiap sheet disusun ke halaman A4. Jumlah halaman mengikuti panjang isi tiap sheet.';
    return res;
  }

  /* ----------------------------- PowerPoint ------------------------------ */
  async function analyzePptx(file, cfg, onProgress, onPhase, forceText) {
    const JSZip = await ensureLib('jszip');
    if (onPhase) onPhase('Membaca presentasi…');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const slideNames = Object.keys(zip.files).filter(function (f) {
      return /^ppt\/slides\/slide\d+\.xml$/.test(f);
    }).sort(function (a, b) {
      const na = parseInt(a.match(/(\d+)/)[1], 10), nb = parseInt(b.match(/(\d+)/)[1], 10);
      return na - nb;
    });

    let html = '<div style="' + DOC_STYLE + 'page-break-after:always;">';
    for (let i = 0; i < slideNames.length; i++) {
      const xml = await zip.file(slideNames[i]).async('string');
      const teks = (xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [])
        .map(function (t) { return t.replace(/<[^>]+>/g, ''); });
      const gambarCount = (xml.match(/<p:pic>/g) || []).length;
      html += '<div style="page-break-after:always;border:1px dashed #9aa;padding:14px;margin-bottom:14px;border-radius:8px;">' +
        '<h3 style="margin:0 0 8px;font-size:15px;">Slide ' + (i + 1) + '</h3>' +
        (gambarCount ? '<p style="margin:0 0 6px;color:#7b3ff2;font-size:13px;">' + gambarCount + ' gambar pada slide ini</p>' : '') +
        '<div style="white-space:pre-wrap;font-size:14px;">' +
        (teks.length ? escapeHtml(teks.join('\n')) : '<em>(tidak ada teks)</em>') + '</div></div>';
    }
    html += '</div>';
    const res = await htmlToPages(html, cfg, onProgress, onPhase, slideNames.length + ' slide');
    res.kind = 'pptx';
    res.note = 'Satu slide dihitung satu halaman. Pratinjau menampilkan teks slide; ' +
      'pemilik usaha bisa mengoreksi jenis halaman secara manual.';
    return res;
  }

  /* ------------------------------ Teks / RTF ----------------------------- */
  async function analyzeText(file, cfg, onProgress, onPhase) {
    if (onPhase) onPhase('Membaca teks…');
    let text = await file.text();
    if (/\.rtf$/i.test(file.name)) {
      text = text.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[\s\S]*?\}/g, '')
        .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
    }
    const html = '<div style="' + DOC_STYLE + '"><pre style="white-space:pre-wrap;font-family:Consolas,\'Courier New\',monospace;font-size:13px;margin:0;">' +
      escapeHtml(text) + '</pre></div>';
    const res = await htmlToPages(html, cfg, onProgress, onPhase, 'Dokumen teks');
    res.kind = 'text';
    res.note = 'Jumlah halaman diperkirakan dari panjang teks (font standar A4).';
    return res;
  }

  /* =======================================================================
     ROUTER: pilih pipeline sesuai jenis file
     ======================================================================= */
  async function analyzeFile(file, cfg, onProgress, onPhase) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return analyzePdf(file, cfg, onProgress, onPhase);
    if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].indexOf(ext) >= 0) return analyzeImage(file, cfg, onProgress, onPhase);
    if (ext === 'docx') return analyzeDocx(file, cfg, onProgress, onPhase);
    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return analyzeXlsx(file, cfg, onProgress, onPhase);
    if (ext === 'pptx') return analyzePptx(file, cfg, onProgress, onPhase);
    if (['txt', 'md', 'rtf', 'log'].indexOf(ext) >= 0) return analyzeText(file, cfg, onProgress, onPhase);
    if (ext === 'doc') {
      throw new Error('File .doc lama tidak didukung browser. Simpan ulang sebagai .docx atau PDF.');
    }
    throw new Error('Jenis file .' + ext + ' belum didukung. Gunakan PDF, DOCX, XLSX, PPTX, TXT, atau gambar.');
  }

  global.Analyzer = {
    analyzeFile: analyzeFile,
    analyzeCanvas: analyzeCanvas,
    klasifikasi: klasifikasi,
    renderPdfPreview: renderPdfPreview,
    htmlToPages: htmlToPages,
    analyzePdf: analyzePdf,
    analyzeImage: analyzeImage,
    canvasToDataUrl: canvasToDataUrl,
    KUALITAS: KUALITAS,
    A4_W: A4_W,
    A4_H: A4_H,
    MAX_AUTO_PAGES: MAX_AUTO_PAGES
  };
})(window);

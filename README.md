# PrintCost — Kalkulator Harga Cetak Otomatis (Digital Printing)

Alat bantu untuk usaha digital printing: pelanggan/pemilik usaha mengirim file (PDF, Word, Excel,
PowerPoint, teks, gambar), lalu aplikasi **membaca file itu langsung di browser**, menilai **setiap
halaman** (berwarna atau hitam putih, ada gambar penuh/hampir penuh atau tidak), dan **menghitung harga
secara otomatis**. Hasilnya bisa di-**review sambil diperbesar** dan **dikoreksi 2×** sebelum nota
dicetak. Semua harga bisa diubah sendiri kapan saja.

Tidak ada file yang diunggah ke server — seluruh pembacaan & analisa terjadi di perangkat pengguna.

---

## 1. Fitur yang sudah jadi

### A. Baca & analisa file (otomatis per halaman)
| Jenis file | Cara dibaca | Catatan |
|---|---|---|
| **PDF** (`.pdf`) | pdf.js (render per halaman) | Paling akurat, halaman asli dipertahankan |
| **Word** (`.docx`) | mammoth → disusun ulang ke kertas A4 | Jumlah halaman A4 bisa sedikit beda dari Word asli |
| **Excel** (`.xlsx`, `.xls`, `.csv`) | SheetJS → tiap sheet disusun ke A4 | Semua sheet dibaca |
| **PowerPoint** (`.pptx`) | JSZip → 1 slide = 1 halaman | Teks slide dibaca; jumlah gambar per slide dihitung |
| **Teks / RTF** (`.txt`, `.md`, `.rtf`) | dibaca langsung | Halaman diperkirakan panjang teks |
| **Gambar** (`.jpg`, `.png`, `.webp`, `.bmp`, `.gif`) | canvas | 1 gambar = 1 halaman |

> File `.doc` / `.ppt` **lama** tidak didukung browser → minta pelanggan simpan ulang ke `.docx` atau PDF.

### B. Penilaian tiap halaman (deteksi otomatis)
Untuk setiap halaman dihitung: **% tinta**, **% piksel berwarna**, dan **luas area gambar terbesar**.
Dari situ ditentukan:

- **Mode**: `Warna` bila ada piksel berwarna di atas ambang; jika tidak → `Hitam putih`.
- **Kategori**: `Gambar penuh` / `Gambar hampir penuh` / `Biasa` / `Kosong`.

Contoh aturan standar (persis seperti permintaan):
| Kondisi halaman | Harga awal |
|---|---|
| Warna — tulisan/gambar biasa | **Rp 1.000** |
| Hitam putih — tulisan/gambar kecil | **Rp 500** |
| Hitam putih — gambar penuh 1 halaman | **Rp 1.000** |
| Gambar menutup hampir seluruh halaman | **Rp 1.500** |
| Gambar menutup penuh 1 halaman (warna) | **Rp 2.000** |

### C. Review & koreksi (bisa di-perbesar, koreksi 2×)
- Grid kartu per halaman: thumbnail, nomor halaman, tag Warna/Hitam putih + kategori, harga, dan harga total per halaman.
- Klik halaman → **jendela perbesar** (zoom 50%–400%, tombol `+ −`, panah kiri/kanan untuk pindah halaman, `Esc` untuk tutup).
- Di jendela itu pemilik usaha bisa **mengubah jenis halaman** (Warna/Hitam putih) dan **ukuran gambar** (penuh / hampir penuh / biasa / kosong) → harga ikut berubah seketika.
- Tombol **Konfirmasi halaman ini** menaikkan penghitung koreksi. Bila sudah **2×** dan/atau jenis halaman diubah manual, kartu diberi tanda **✓ 2× / ✎**.
- Tombol **Tandai semua sudah 2×** dan **Kembalikan ke auto**.

### D. Hitung total, simpan riwayat, cetak nota
- Rangkap/salinan per file (×1, ×2, …), diskon %, biaya tambahan, minimal order, halaman kosong.
- **Simpan ke riwayat** (tersimpan di server) + **Ekspor CSV** (buka di Excel).
- **Cetak nota / penawaran** untuk pelanggan: header toko, rincian per kategori halaman, total, plus lampiran **daftar tiap halaman**.

### E. Pengaturan harga & deteksi (semua bisa diubah)
Harga tiap aturan, ambang warna, ambang "penuh/hampir penuh", ambang halaman kosong, harga halaman
kosong, mode ketelitian (cepat/seimbang/teliti), nama toko, kontak, catatan nota, minimal order,
biaya tambahan, dan diskon.

---

## 2. Alamat & cara pakai

| Halaman | Keterangan |
|---|---|
| `index.html` | Aplikasi utama (5 tab: Unggah File, Hasil & Review, Total Order, Pengaturan Harga, Riwayat) |
| `index.html?demo=1` | Tampilkan dokumen contoh 5 halaman (untuk mencoba tanpa file sendiri) |
| `index.html?review=1` | Dokumen contoh + langsung membuka jendela perbesar (untuk menguji review) |
| `css/style.css` | Tampilan (responsif: HP, tablet, desktop) |
| `js/analyzer.js` | Mesin baca file + deteksi warna/gambar per halaman |
| `js/app.js` | Hitung harga, review & koreksi, pengaturan, riwayat, nota |

**Alur pakai sehari-hari**: buka tab **Unggah File** → tarik file pelanggan → buka tab **Hasil & Review**
→ periksa tiap halaman (perbesar & koreksi, konfirmasi 2×) → tab **Total Order** → isi nama pelanggan →
**Simpan ke riwayat** dan/atau **Cetak nota**.

---

## 3. Model data & penyimpanan

Pengaturan disimpan di **REST Table API** (server) dan dicadangkan di `localStorage` perangkat, sehingga
tetap bekerja walau server lambat/tidak tersedia.

| Tabel | Isi |
|---|---|
| `pengaturan_harga` | 6 aturan harga (kolom: `mode`, `kategori`, `harga`, `aktif`) |
| `pengaturan_umum` | 1 baris setelan default (ambang deteksi, nama toko, biaya, diskon, dll) |
| `riwayat_order` | Arsip pesanan (pelanggan, file, jumlah halaman warna/hp/kosong, rangkap, total, detail) |

---

## 4. Belum diimplementasikan / batasan

- Deteksi **tata letak asli** untuk Word/Excel/PowerPoint tidak 100% sama seperti di Microsoft Office
  (browser menyusun ulang mengikuti A4) — **selalu cek lewat review**. Untuk akurasi tertinggi, minta
  pelanggan mengirim PDF.
- Analisa mendalam otomatis dibatasi 60 halaman pertama untuk dokumen non-PDF (sisanya diatur manual) agar
  browser tidak berat.
- Belum ada login/multi-pengguna: pengaturan bersifat satu usaha (satu akun).
- Belum ada impor harga massal dari Excel dan belum ada pencetakan langsung ke printer thermal.
- Biaya finishing (laminating, jilid, potong, mata ayam) belum dihitung per item — baru berupa
  "biaya tambahan" tunggal.

## 5. Saran pengembangan berikutnya

1. **Master finishing** (laminating/jilid/staples/potong) yang bisa dicentang di nota.
2. **Impor/ekspor daftar harga** via Excel agar tukar menukar harga antar outlet mudah.
3. **Struk thermal** (format 58/80 mm) untuk printer kasir.
4. **Beberapa profil harga** (mis. reguler vs kilat / pelanggan vs agen).
5. **Nomor nota berurutan** + tanda lunas/belum bayar.
6. Penyimpanan file pelanggan ke R2 agar bisa dibuka lagi dari riwayat.

---

## 6. URL publik
- Situs dipublikasikan lewat tab **Publish** / **Hosted Deploy** (belum ada alamat produksi khusus).
- API data (REST Table API) memakai jalur relatif `tables/...` pada domain yang sama.

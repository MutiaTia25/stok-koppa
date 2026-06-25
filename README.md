# Sistem Stok Minimarket

Aplikasi web sederhana untuk manajemen stok minimarket (Admin & Kasir), dibuat dengan Node.js + Express + SQLite (better-sqlite3) + HTML/CSS/JS murni.

## Fitur
- Login dengan 2 role: **Admin** dan **Kasir**
- Dashboard: total produk, total stok, peringatan stok menipis, rekap per kategori
- CRUD Produk (tambah, edit, hapus, lihat) + filter & pencarian per kategori
- CRUD Kategori (khusus Admin)
- Penambahan stok (stok masuk) dan pengurangan stok (stok keluar/terjual)
- Riwayat transaksi stok (siapa, kapan, jumlah, catatan)

## Cara Menjalankan (di VS Code)

1. Buka folder `stok-app` ini di VS Code.
2. Buka terminal (Ctrl + `), jalankan:
   ```
   npm install
   ```
3. Jalankan server:
   ```
   npm start
   ```
4. Buka browser ke: **http://localhost:3000**

## Akun Default

| Role  | Username | Password |
|-------|----------|----------|
| Admin | admin    | admin123 |
| Kasir | kasir    | kasir123 |

Anda bisa menambah/mengubah user langsung di database `data.db` (tabel `users`) atau membuat halaman manajemen user tambahan jika diperlukan.

## Struktur Folder
```
stok-app/
├── server.js          # Backend API (Express + SQLite)
├── package.json
├── data.db             # Database (otomatis terbuat saat pertama jalan)
└── public/
    ├── index.html      # Tampilan utama
    └── app.js          # Logic frontend
```

## Hak Akses
- **Admin**: semua fitur (produk, stok, kategori)
- **Kasir**: data produk, stok masuk/keluar (tidak bisa kelola kategori)

## Catatan Pengembangan Lanjutan (opsional)
- Tambah halaman kelola user (ganti password, tambah kasir baru)
- Tambah laporan penjualan harian/bulanan (export Excel/PDF)
- Tambah notifikasi otomatis saat stok menipis
- Tambah barcode scanner untuk input produk lebih cepat

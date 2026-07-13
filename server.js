const express = require('express');
const cors = require('cors');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const multer = require('multer');

const app = express();
const upload = multer({
    dest: 'uploads/'
});

// DB_PATH bisa diatur via environment variable (misal di Railway: /data/data.db
// supaya tersimpan di persistent volume dan tidak hilang saat redeploy).
// Jika tidak diatur, default tetap di folder project (untuk dijalankan di komputer lokal).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const JWT_SECRET = process.env.JWT_SECRET || 'ganti-secret-key-ini-di-production';

app.use(cors());
app.use(express.json());
// Matikan cache untuk file HTML & JS supaya browser selalu ambil versi terbaru
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ===== INIT TABLES =====
db.exec(`
CREATE TABLE IF NOT EXISTS stock_opname (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  location TEXT NOT NULL DEFAULT 'warehouse',
  stock_system INTEGER,
  stock_fisik INTEGER,
  selisih INTEGER,
  user TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin','kasir')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  sku TEXT,
  FOREIGN KEY(category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS stock_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('in','out')),
  qty INTEGER NOT NULL,
  note TEXT,
  user TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('to_display')),
  note TEXT,
  user TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS stock_disposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  reason TEXT,
  note TEXT,
  user TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(product_id) REFERENCES products(id)
);
`);

// ===== MIGRASI KOLOM (aman dijalankan berkali-kali) =====
function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}
function addColumnIfMissing(table, column, definition) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('products', 'display_stock', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('products', 'display_min', 'INTEGER NOT NULL DEFAULT 48');
addColumnIfMissing('products', 'display_max', 'INTEGER NOT NULL DEFAULT 1000');
addColumnIfMissing('products', 'warehouse_stock', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('products', 'warehouse_min', 'INTEGER NOT NULL DEFAULT 48');
addColumnIfMissing('products', 'warehouse_max', 'INTEGER NOT NULL DEFAULT 1000');
addColumnIfMissing('users', 'full_name', 'TEXT');
addColumnIfMissing('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('users', 'created_at', `TEXT DEFAULT (datetime('now','localtime'))`);
addColumnIfMissing('stock_opname', 'location', `TEXT NOT NULL DEFAULT 'warehouse'`);
addColumnIfMissing('stock_opname','status',"TEXT DEFAULT 'pending'");
addColumnIfMissing('stock_opname','approved_by','TEXT');
addColumnIfMissing('stock_opname','approved_at','TEXT');
addColumnIfMissing('stock_opname','note','TEXT');
addColumnIfMissing('products', 'barcode', 'TEXT');
addColumnIfMissing('products','default_location',"TEXT NOT NULL DEFAULT 'office'");
addColumnIfMissing('products', 'unit', "TEXT DEFAULT 'PCS'");

// ===== MIGRASI: gabung stok Gudang + Mart jadi SATU stok per lokasi =====
// Aplikasi sekarang cuma bedain 2 LOKASI (MIOF/Office & MIMS/Mess), bukan lagi
// gudang vs mart di dalam satu lokasi. SENGAJA dijalankan setiap kali server
// start (tidak cuma sekali) sebagai jaring pengaman — kalau suatu saat ada kode
// yang keliru nulis lagi ke display_stock, migrasi ini otomatis menggabungkannya
// kembali ke warehouse_stock di restart berikutnya. Aman berkali-kali karena
// begitu display_stock sudah 0, penjumlahan berikutnya tidak mengubah apa-apa.
db.exec(`UPDATE products SET warehouse_stock = warehouse_stock + display_stock, display_stock = 0 WHERE display_stock != 0`);

// ===== MIGRASI: standarisasi Min 48 / Max 1000 untuk SEMUA produk =====
// Kebijakan perusahaan: setiap produk, di lokasi manapun, pakai standar
// Min Stok = 48 dan Max Stok = 1000 — tidak ada yang kosong atau beda sendiri.
// Ini migrasi SEKALI JALAN (ditandai di tabel _migrations) supaya kalau admin
// nanti mengubah Min/Max satu produk secara manual, perubahan itu tidak
// otomatis ditimpa lagi tiap kali server restart.
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now','localtime')))`);
const MIGRATION_NAME = 'standardize_min48_max1000';
const alreadyApplied = db.prepare('SELECT 1 FROM _migrations WHERE name=?').get(MIGRATION_NAME);
if (!alreadyApplied) {
  db.exec(`UPDATE products SET warehouse_min = 48, warehouse_max = 1000`);
  db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(MIGRATION_NAME);
}

// ===== MIGRASI: Pisahkan [SKU] dari nama produk yang belum dipisah =====
// Jalankan sekali — produk dengan nama format "[xxx] Nama" dipecah jadi sku + nama bersih
(function migrateSkuFromName(){
  const rows = db.prepare(`SELECT id, name, sku FROM products WHERE name LIKE '[%] %'`).all();
  let fixed = 0;
  for (const row of rows) {
    const m = row.name.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (!m) continue;
    const newSku  = (row.sku && row.sku.trim()) ? row.sku : m[1].trim();
    const newName = m[2].trim();
    db.prepare('UPDATE products SET sku=?, name=? WHERE id=?').run(newSku, newName, row.id);
    fixed++;
  }
  if (fixed > 0) console.log(`[Migrasi] Pisahkan SKU dari nama: ${fixed} produk diperbarui`);
})();


if (columnExists('products', 'barcode')) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_barcode
    ON products(barcode);
  `);
}

// Migrasi data lama: jika ada kolom 'stock'/'min_stock' (skema versi sebelumnya)
// dan warehouse_stock masih 0, pindahkan nilai lama ke warehouse_stock supaya data tidak hilang.
if (columnExists('products', 'stock')) {
  const rows = db.prepare('SELECT id, stock, min_stock FROM products').all();
  rows.forEach(r => {
    const current = db.prepare('SELECT warehouse_stock, warehouse_min FROM products WHERE id=?').get(r.id);
    if (current && current.warehouse_stock === 0 && r.stock) {
      db.prepare('UPDATE products SET warehouse_stock=?, warehouse_min=? WHERE id=?')
        .run(r.stock || 0, r.min_stock || 48, r.id);
    }
  });
}

// migrate old plaintext passwords to bcrypt (run once)
const allUsers = db.prepare('SELECT id, password FROM users').all();
allUsers.forEach(u => {
  if (!u.password.startsWith('$2')) {
    const hashed = bcrypt.hashSync(u.password, 10);
    db.prepare('UPDATE users SET password=? WHERE id=?').run(hashed, u.id);
  }
});

// seed default users & category if empty
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  db.prepare('INSERT INTO users (username,password,full_name,role) VALUES (?,?,?,?)')
    .run('admin', bcrypt.hashSync('admin123', 10), 'Administrator', 'admin');
  db.prepare('INSERT INTO users (username,password,full_name,role) VALUES (?,?,?,?)')
    .run('kasir', bcrypt.hashSync('kasir123', 10), 'Kasir 1', 'kasir');
}
const catCount = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
if (catCount === 0) {
  ['Makanan','Minuman','Rokok','Lainnya'].forEach(c =>
    db.prepare('INSERT INTO categories (name) VALUES (?)').run(c));
}

// ===== MIGRASI: kategori dibatasi hanya Makanan/Minuman/Rokok/Lainnya =====
// Kategori lain yang mungkin sempat kebuat (mis. dari import lama: Sembako,
// Kebersihan, dll) digabung ke "Lainnya" supaya daftar kategori tetap rapi.
// Aman dijalankan berkali-kali (begitu sudah rapi, tidak ada lagi yang perlu digabung).
{
  const ALLOWED_CATEGORIES = ['MAKANAN', 'MINUMAN', 'ROKOK', 'LAINNYA'];
  let lainnya = db.prepare('SELECT id FROM categories WHERE UPPER(name)=?').get('LAINNYA');
  if (!lainnya) {
    db.prepare('INSERT INTO categories (name) VALUES (?)').run('Lainnya');
    lainnya = db.prepare('SELECT id FROM categories WHERE UPPER(name)=?').get('LAINNYA');
  }
  const stray = db.prepare('SELECT id, name FROM categories WHERE UPPER(name) NOT IN (?,?,?,?)')
    .all(...ALLOWED_CATEGORIES);
  for (const cat of stray) {
    db.prepare('UPDATE products SET category_id=? WHERE category_id=?').run(lainnya.id, cat.id);
    db.prepare('DELETE FROM categories WHERE id=?').run(cat.id);
  }
}

// ===== MIDDLEWARE: AUTH =====
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Token tidak ditemukan, silakan login kembali' });
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesi habis, silakan login kembali' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Hanya admin yang dapat mengakses fitur ini' });
  next();
}

// ===== AUTH ROUTES =====
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });

  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user) return res.status(401).json({ error: 'Username atau password salah' });
  if (!user.active) return res.status(403).json({ error: 'Akun ini telah dinonaktifkan, hubungi admin' });

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Username atau password salah' });

  const payload = { id: user.id, username: user.username, role: user.role, full_name: user.full_name };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: payload });
});

app.post('/api/change-password', authMiddleware, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password baru minimal 4 karakter' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(oldPassword, user.password)) return res.status(401).json({ error: 'Password lama salah' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res.json({ ok: true });
});

// ===== USER MANAGEMENT (ADMIN ONLY) =====
app.get('/api/users', authMiddleware, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id').all());
});

app.post('/api/users', authMiddleware, adminOnly, (req, res) => {
  const { username, password, full_name, role } = req.body;
  if (!username || !password || !role) return res.status(400).json({ error: 'Username, password, dan role wajib diisi' });
  if (!['admin','kasir'].includes(role)) return res.status(400).json({ error: 'Role tidak valid' });
  if (password.length < 4) return res.status(400).json({ error: 'Password minimal 4 karakter' });
  try {
    const r = db.prepare('INSERT INTO users (username,password,full_name,role) VALUES (?,?,?,?)')
      .run(username, bcrypt.hashSync(password, 10), full_name || username, role);
    res.json({ id: r.lastInsertRowid });
  } catch(e) {
    res.status(400).json({ error: 'Username sudah digunakan' });
  }
});

app.put('/api/users/:id', authMiddleware, adminOnly, (req, res) => {
  const { full_name, role, active } = req.body;
  db.prepare('UPDATE users SET full_name=?, role=?, active=? WHERE id=?')
    .run(full_name, role, active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-password', authMiddleware, adminOnly, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password minimal 4 karakter' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', authMiddleware, adminOnly, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== CATEGORIES (CRUD) =====
app.get('/api/categories', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY name').all());
});
app.post('/api/categories', authMiddleware, adminOnly, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama kategori wajib diisi' });
  try {
    const r = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    res.json({ id: r.lastInsertRowid, name });
  } catch (e) { res.status(400).json({ error: 'Kategori sudah ada' }); }
});
app.put('/api/categories/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare('UPDATE categories SET name=? WHERE id=?').run(req.body.name, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/categories/:id', authMiddleware, adminOnly, (req, res) => {
  const used = db.prepare('SELECT COUNT(*) c FROM products WHERE category_id=?').get(req.params.id).c;
  if (used > 0) return res.status(400).json({ error: 'Kategori masih dipakai produk' });
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== HELPER: tambahkan field turunan (total_stock, reorder_qty, dll) ke baris produk =====
function enrichProduct(p) {
  p.total_stock = p.warehouse_stock;
  p.warehouse_reorder_qty = p.warehouse_stock <= p.warehouse_min
    ? Math.max(0, p.warehouse_min - p.warehouse_stock)
    : 0;
  return p;
}

// ===== PRODUCTS (CRUD) =====
app.get('/api/products', authMiddleware, (req, res) => {
  const { category_id, q } = req.query;
  let sql = `SELECT p.id, p.name, p.category_id, p.price, p.sku, p.barcode, p.unit, p.default_location as location,
                    p.warehouse_stock, p.warehouse_min, p.warehouse_max,
                    c.name as category_name
             FROM products p
             JOIN categories c ON c.id = p.category_id WHERE 1=1`;
  const params = [];
  if (category_id) { sql += ' AND p.category_id=?'; params.push(category_id); }
  if (q) { sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)'; params.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  sql += ' ORDER BY p.name';
  const rows = db.prepare(sql).all(...params).map(enrichProduct);
  res.json(rows);
});

// Route duplikat dihapus — sudah di-handle oleh route GET /api/products di atas

app.get('/api/products/:id', authMiddleware, (req, res) => {
  const p = db.prepare(`SELECT p.*, c.name as category_name FROM products p
    JOIN categories c ON c.id=p.category_id WHERE p.id=?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  res.json(enrichProduct(p));
});

// ===== HAPUS PRODUK MASSAL (harus di atas /:id agar tidak tertangkap sebagai id) =====
app.post('/api/products/bulk-delete', authMiddleware, adminOnly, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Tidak ada produk yang dipilih' });
  try {
    for (const id of ids) {
      db.prepare('DELETE FROM stock_logs WHERE product_id=?').run(id);
      db.prepare('DELETE FROM stock_transfers WHERE product_id=?').run(id);
      db.prepare('DELETE FROM stock_opname WHERE product_id=?').run(id);
      db.prepare('DELETE FROM products WHERE id=?').run(id);
    }
    res.json({ ok: true, deleted: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', authMiddleware, (req, res) => {
  const {
    name,
    category_id,
    price,
    sku,
    barcode,
    unit,
    location,
    warehouse_stock,
    warehouse_min,
    warehouse_max
  } = req.body;

  if (!name || !category_id) return res.status(400).json({ error: 'Nama dan kategori wajib diisi' });

  const siteLoc = location || 'office';
  if (barcode) {
    // Barcode boleh sama di 2 site (MIOF & MIMS) karena itu 2 lokasi terpisah;
    // yang tidak boleh duplikat adalah barcode+site yang SAMA.
    const dup = db.prepare('SELECT id FROM products WHERE barcode=? AND default_location=?').get(barcode, siteLoc);
    if (dup) return res.status(400).json({ error: `Barcode ini sudah dipakai produk lain di site ${siteLoc === 'mess' ? 'MIMS/Mess' : 'MIOF/Office'}` });
  }

  const r = db.prepare(`
INSERT INTO products (
  name,
  category_id,
  price,
  sku,
  barcode,
  unit,
  default_location,
  warehouse_stock,
  warehouse_min,
  warehouse_max
)
VALUES (?,?,?,?,?,?,?,?,?,?)
`).run(
  name,
  category_id,
  price || 0,
  sku || '',
  barcode || '',
  unit || 'PCS',
  siteLoc,
  warehouse_stock || 0,
  warehouse_min || 48,
  warehouse_max || 1000
);

  res.json({ id: r.lastInsertRowid });
});

app.put('/api/products/:id', authMiddleware, (req, res) => {
  const {
  name,
  category_id,
  price,
  sku,
  location,
  barcode,
  unit,
  warehouse_min,
  warehouse_max
} = req.body;

  if (!name || !category_id) return res.status(400).json({ error: 'Nama dan kategori wajib diisi' });

  const siteLoc = location || 'office';
  if (barcode) {
    const dup = db.prepare('SELECT id FROM products WHERE barcode=? AND default_location=? AND id<>?').get(barcode, siteLoc, req.params.id);
    if (dup) return res.status(400).json({ error: `Barcode ini sudah dipakai produk lain di site ${siteLoc === 'mess' ? 'MIMS/Mess' : 'MIOF/Office'}` });
  }

  db.prepare(`
UPDATE products SET
name=?,
category_id=?,
price=?,
sku=?,
barcode=?,
unit=?,
default_location=?,
warehouse_min=?,
warehouse_max=?
WHERE id=? `)
.run(
  name,
  category_id,
  price || 0,
  sku || '',
  barcode || '',
  unit || 'PCS',
  siteLoc,
  warehouse_min || 48,
  warehouse_max || 1000,
  req.params.id
);

  res.json({ ok: true });
});

app.delete('/api/products/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    db.prepare('DELETE FROM stock_logs WHERE product_id=?').run(req.params.id);
    db.prepare('DELETE FROM stock_transfers WHERE product_id=?').run(req.params.id);
    db.prepare('DELETE FROM stock_opname WHERE product_id=?').run(req.params.id);
    const result = db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    res.json({ ok: true, message: 'Produk berhasil dihapus' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== STOCK IN / OUT (di GUDANG lokasi produk yang bersangkutan) =====
// Setiap produk sudah terikat ke satu lokasi (default_location: office/mess).
// "Masuk" = barang diterima dari supplier ke gudang lokasi produk itu.
// "Keluar" = barang keluar dari gudang (misalnya rusak/hilang/retur ke supplier).
// Untuk memindahkan barang dari gudang ke rak pajangan DALAM lokasi yang sama, gunakan /api/transfer.
app.post('/api/stock/in', authMiddleware, (req, res) => {
  const { product_id, qty, note, date } = req.body;
  if (!product_id || !qty || qty <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });

  db.prepare('UPDATE products SET warehouse_stock = warehouse_stock + ? WHERE id=?').run(qty, product_id);

  if (date) {
    db.prepare('INSERT INTO stock_logs (product_id,type,qty,note,user,created_at) VALUES (?,?,?,?,?,?)')
      .run(product_id, 'in', qty, note || '', req.user.username, date);
  } else {
    db.prepare('INSERT INTO stock_logs (product_id,type,qty,note,user) VALUES (?,?,?,?,?)')
      .run(product_id, 'in', qty, note || '', req.user.username);
  }

  res.json({ ok: true });
});

app.post('/api/stock/out', authMiddleware, (req, res) => {
  const { product_id, qty, note, date } = req.body;
  if (!product_id || !qty || qty <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });

  const prod = db.prepare('SELECT warehouse_stock FROM products WHERE id=?').get(product_id);
  if (!prod) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  if (prod.warehouse_stock < qty) {
    return res.status(400).json({ error: 'Stok Gudang tidak cukup. Sisa stok Gudang: ' + prod.warehouse_stock });
  }

  db.prepare('UPDATE products SET warehouse_stock = warehouse_stock - ? WHERE id=?').run(qty, product_id);

  if (date) {
    db.prepare('INSERT INTO stock_logs (product_id,type,qty,note,user,created_at) VALUES (?,?,?,?,?,?)')
      .run(product_id, 'out', qty, note || '', req.user.username, date);
  } else {
    db.prepare('INSERT INTO stock_logs (product_id,type,qty,note,user) VALUES (?,?,?,?,?)')
      .run(product_id, 'out', qty, note || '', req.user.username);
  }

  res.json({ ok: true });
});

// ===== PEMUSNAHAN STOK (barang rusak / expired / hilang) =====
app.post('/api/disposal', authMiddleware, (req, res) => {
  const { product_id, qty, reason, note } = req.body;
  if (!product_id || !qty || qty <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });

  const prod = db.prepare('SELECT warehouse_stock FROM products WHERE id=?').get(product_id);
  if (!prod) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  if (prod.warehouse_stock < qty) return res.status(400).json({ error: 'Stok tidak cukup. Sisa stok: ' + prod.warehouse_stock });

  db.prepare('UPDATE products SET warehouse_stock = warehouse_stock - ? WHERE id=?').run(qty, product_id);

  db.prepare('INSERT INTO stock_disposals (product_id, qty, reason, note, user) VALUES (?,?,?,?,?)')
    .run(product_id, qty, reason || 'lainnya', note || '', req.user.username);

  res.json({ ok: true });
});

app.get('/api/disposals', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT d.id, d.product_id, p.name as product_name, c.name as category_name,
                    d.qty, d.reason, d.note, d.user, d.created_at
             FROM stock_disposals d
             JOIN products p ON p.id = d.product_id
             JOIN categories c ON c.id = p.category_id
             WHERE 1=1`;
  const params = [];
  if (from) { sql += ` AND date(d.created_at) >= date(?)`; params.push(from); }
  if (to) { sql += ` AND date(d.created_at) <= date(?)`; params.push(to); }
  sql += ' ORDER BY d.id DESC LIMIT 200';
  res.json(db.prepare(sql).all(...params));
});

// ===== STOCK LOGS / HISTORY =====
app.get('/api/logs', authMiddleware, (req, res) => {
  const { from, to, type, product_id } = req.query;
  let sql = `SELECT l.*, p.name as product_name, c.name as category_name, p.default_location as site FROM stock_logs l
    JOIN products p ON p.id=l.product_id
    JOIN categories c ON c.id=p.category_id
    WHERE (l.note IS NULL OR (l.note NOT LIKE '[OPNAME]%' AND l.note NOT LIKE '[OPNAME APPROVE]%'))`;
  const params = [];
  // Kasir cuma boleh lihat riwayat input MEREKA SENDIRI — bukan punya kasir lain.
  // Admin tetap lihat semua (sama seperti Riwayat SO: kasir lihat punya sendiri, admin lihat semua).
  if (req.user.role !== 'admin') { sql += ` AND l.user = ?`; params.push(req.user.username); }
  if (from) { sql += ` AND date(l.created_at) >= date(?)`; params.push(from); }
  if (to) { sql += ` AND date(l.created_at) <= date(?)`; params.push(to); }
  if (type) { sql += ` AND l.type=?`; params.push(type); }
  if (product_id) { sql += ` AND l.product_id=?`; params.push(product_id); }
  sql += ' ORDER BY l.id DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
});

// ===== CURRENT STOCK =====
app.get('/api/current-stock', authMiddleware, (req, res) => {
  const data = db.prepare(`
    SELECT p.id, p.name, c.name AS category_name, p.price, p.default_location as location,
           p.warehouse_stock, p.warehouse_min, p.warehouse_max
    FROM products p
    JOIN categories c ON c.id = p.category_id
    ORDER BY p.name
  `).all().map(enrichProduct);
  res.json(data);
});

// ===== DASHBOARD SUMMARY =====
app.get('/api/summary', authMiddleware, (req, res) => {
  const totalProducts = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  const totalStock = db.prepare('SELECT COALESCE(SUM(warehouse_stock),0) s FROM products').get().s;
  const totalValue = db.prepare('SELECT COALESCE(SUM(warehouse_stock * price),0) v FROM products').get().v;

  const byCategory = db.prepare(`
    SELECT c.name, COUNT(p.id) jumlah_produk,
           COALESCE(SUM(p.warehouse_stock),0) total_stok,
           COALESCE(SUM(p.warehouse_stock * p.price),0) nilai_stok
    FROM categories c LEFT JOIN products p ON p.category_id=c.id
    GROUP BY c.id ORDER BY c.name
  `).all();

  const lowStockItems = db.prepare(`
  SELECT
    p.id,
    p.name,
    c.name as category_name,
    p.default_location as location,
    p.warehouse_stock,
    p.warehouse_min,
    p.warehouse_max
  FROM products p
  JOIN categories c ON c.id = p.category_id

  WHERE
    p.warehouse_stock <= p.warehouse_min

  ORDER BY p.name
`).all().map(enrichProduct);

  const todayIn = db.prepare(`SELECT COALESCE(SUM(qty),0) s FROM stock_logs WHERE type='in' AND date(created_at)=date('now','localtime')`).get().s;
  const todayOut = db.prepare(`SELECT COALESCE(SUM(qty),0) s FROM stock_logs WHERE type='out' AND date(created_at)=date('now','localtime')`).get().s;

  res.json({ totalProducts, totalStock, totalValue, byCategory, lowStockItems, todayIn, todayOut });
});

// ===== LAPORAN FILTER =====
app.get('/api/report', authMiddleware, (req, res) => {
  const { from, to, type } = req.query;
  let sql = `
    SELECT l.id, l.created_at, p.name as product_name, c.name as category_name, p.default_location as site,
           l.type, l.qty, l.note, l.user
    FROM stock_logs l
    JOIN products p ON p.id = l.product_id
    JOIN categories c ON c.id = p.category_id
    WHERE 1=1
  `;
  const params = [];
  if (from) { sql += ` AND date(l.created_at) >= date(?)`; params.push(from); }
  if (to) { sql += ` AND date(l.created_at) <= date(?)`; params.push(to); }
  // 'so' = transaksi yang berasal dari Stock Opname (ditandai note-nya diawali [OPNAME]).
  // 'in'/'out' = transaksi MANUAL saja (stock opname dikecualikan supaya gak dobel-hitung
  // dengan filter Stok Masuk/Keluar biasa).
  if (type === 'so') {
    sql += ` AND (l.note LIKE '[OPNAME]%' OR l.note LIKE '[OPNAME APPROVE]%')`;
  } else if (type && type !== 'all') {
    sql += ` AND l.type = ? AND (l.note IS NULL OR (l.note NOT LIKE '[OPNAME]%' AND l.note NOT LIKE '[OPNAME APPROVE]%'))`;
    params.push(type);
  }
  sql += ` ORDER BY l.created_at DESC`;

  const data = db.prepare(sql).all(...params);
  res.json(data);
});

// ===== LOW STOCK (stok <= minimum) =====
app.get('/api/low-stock', authMiddleware, (req, res) => {
  const data = db.prepare(`
    SELECT id, name, warehouse_stock as total_stock, warehouse_min as total_min
    FROM products
    WHERE warehouse_stock <= warehouse_min
    ORDER BY warehouse_stock ASC
  `).all();
  res.json(data);
});

// ===== STOCK OPNAME =====
app.get('/api/opname/products', authMiddleware, (req, res) => {
  const data = db.prepare(`
    SELECT p.id, p.name, p.sku, p.barcode, p.unit, p.default_location as location, c.name as category_name,
           p.warehouse_stock, p.warehouse_min, p.warehouse_max
    FROM products p JOIN categories c ON c.id=p.category_id
    ORDER BY p.name
  `).all();
  res.json(data);
});

// Cek apakah barcode sudah ada di sistem. Dipakai saat input opname:
// kasir scan barcode pakai scanner fisik (otomatis terketik ke field + Enter).
// Kalau belum ada di sistem, frontend menampilkan form tambah produk baru
// (khusus admin) tanpa harus pindah menu.
app.get('/api/products/check-barcode/:barcode', authMiddleware, (req, res) => {
  const { location } = req.query; // optional: 'office' | 'mess' — site yang sedang dikerjakan
  let sql = `
    SELECT p.id, p.name, p.sku, p.barcode, p.default_location as location, c.name as category_name,
           p.warehouse_stock
    FROM products p JOIN categories c ON c.id=p.category_id
    WHERE p.barcode = ?
  `;
  const params = [req.params.barcode];
  if (location) { sql += ` AND p.default_location = ?`; params.push(location); }
  const rows = db.prepare(sql).all(...params);
  // Kalau tidak filter site dan barcode-nya ada di 2 site (MIOF & MIMS), kembalikan semuanya
  // supaya caller bisa memilih site yang tepat, bukan asal ambil salah satu.
  res.json({ found: rows.length > 0, product: rows[0] || null, matches: rows });
});

app.get('/api/opname', authMiddleware, (req, res) => {
  const { from, to, status } = req.query;
  let sql = `
    SELECT o.id, o.product_id, p.name as product_name, c.name as category_name,
           p.default_location as site, o.location, o.stock_system, o.stock_fisik, o.selisih, o.user, o.created_at,
           o.status, o.approved_by, o.approved_at
    FROM stock_opname o
    JOIN products p ON p.id = o.product_id
    JOIN categories c ON c.id = p.category_id
    WHERE 1=1
  `;
  const params = [];
  if (from) { sql += ` AND date(o.created_at) >= date(?)`; params.push(from); }
  if (to) { sql += ` AND date(o.created_at) <= date(?)`; params.push(to); }
  if (status) { sql += ` AND o.status = ?`; params.push(status); }
  sql += ` ORDER BY o.id DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...params));
});

// ===== CEK APAKAH PRODUK INI SUDAH ADA SO PENDING (BELUM DI-APPROVE) =====
// Dipakai waktu scan/pilih produk di halaman Opname — supaya kalau produk yang
// sama sudah pernah di-SO tapi belum di-approve admin, kasir/admin bisa lihat
// dan TAMBAH/GANTI qty-nya, bukan bikin entri SO baru yang terpisah/duplikat.
app.get('/api/opname/check-pending/:productId', authMiddleware, (req, res) => {
  const row = db.prepare(`
    SELECT id, product_id, stock_system, stock_fisik, selisih, user, created_at
    FROM stock_opname
    WHERE product_id = ? AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(req.params.productId);
  res.json(row || null);
});

app.post('/api/opname', authMiddleware, (req, res) => {
  let {
    product_id, stock_fisik, update_opname_id,
    new_product_name, new_product_category_id, new_product_sku, new_product_barcode, new_product_price, new_product_location
  } = req.body;

  // ===== Mode tambah produk baru sambil opname (KHUSUS ADMIN) =====
  // Jika product_id tidak dikirim, berarti produk ini belum ada di sistem.
  // Hanya admin yang boleh membuat produk baru lewat jalur ini; kasir hanya bisa
  // input opname untuk produk yang sudah ada.
  if (!product_id) {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Hanya admin yang dapat menambahkan produk baru. Silakan minta admin untuk menambahkan produk ini terlebih dahulu.' });
    }
    if (!new_product_name || !new_product_category_id) {
      return res.status(400).json({ error: 'Nama produk dan kategori wajib diisi untuk produk baru' });
    }
    const newSiteLoc = new_product_location === 'mess' ? 'mess' : 'office';
    if (new_product_barcode) {
      const dup = db.prepare('SELECT id FROM products WHERE barcode=? AND default_location=?').get(new_product_barcode, newSiteLoc);
      if (dup) return res.status(400).json({ error: `Barcode ini sudah dipakai produk lain di site ${newSiteLoc === 'mess' ? 'MIMS/Mess' : 'MIOF/Office'}` });
    }
    const r = db.prepare(`
      INSERT INTO products (name, category_id, price, sku, barcode, default_location, warehouse_stock, warehouse_min, warehouse_max)
      VALUES ( ?, ?, ?, ?, ?, ?, 0, 48, 1000 )
    `).run(new_product_name, new_product_category_id, new_product_price || 0, new_product_sku || '', new_product_barcode || '', newSiteLoc);
    product_id = r.lastInsertRowid;
  }

  if (stock_fisik === undefined || stock_fisik === null) {
    return res.status(400).json({ error: 'Isi qty hasil hitung fisik' });
  }
  stock_fisik = Number(stock_fisik);
  if (isNaN(stock_fisik) || stock_fisik < 0) {
    return res.status(400).json({ error: 'Stok fisik tidak boleh negatif' });
  }

  const prod = db.prepare('SELECT warehouse_stock, warehouse_min, default_location FROM products WHERE id=?').get(product_id);
  if (!prod) return res.status(404).json({ error: 'Produk tidak ditemukan' });

  // Stok itu SATU angka per lokasi produk (tidak ada lagi split gudang/mart) —
  // jadi selalu pakai warehouse_stock, siapapun lokasinya (Office atau Mess).
  const isMess = (prod.default_location === 'mess');
  const locLabel  = isMess ? 'Mess (MIMS)'     : 'Office (MIOF)';
  const locKey    = 'warehouse';
  const stock_system = prod.warehouse_stock;
  const selisih = stock_fisik - stock_system;
  const isAdmin = req.user.role === 'admin';
  const status = isAdmin ? 'approved' : 'pending';

  // Kalau ini update dari SO pending yang sudah ada (produk sama, belum di-approve),
  // UPDATE baris itu saja — supaya gak ada entri SO ganda buat produk yang sama.
  let existingPending = null;
  if (update_opname_id) {
    existingPending = db.prepare(`SELECT id FROM stock_opname WHERE id=? AND product_id=? AND status='pending'`)
      .get(update_opname_id, product_id);
  }

  if (existingPending) {
    db.prepare(`
      UPDATE stock_opname
      SET stock_system=?, stock_fisik=?, selisih=?, user=?, created_at=datetime('now','localtime'),
          status=?, approved_by=?, approved_at=?
      WHERE id=?
    `).run(
      stock_system, stock_fisik, selisih, req.user.username,
      status, isAdmin ? req.user.username : null, isAdmin ? new Date().toISOString() : null,
      existingPending.id
    );
  } else {
    db.prepare(`
      INSERT INTO stock_opname (product_id, location, stock_system, stock_fisik, selisih, user, status, approved_by, approved_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      product_id, locKey, stock_system, stock_fisik, selisih,
      req.user.username, status,
      isAdmin ? req.user.username : null,
      isAdmin ? new Date().toISOString() : null
    );
  }

  if (isAdmin) {
    // Admin SO langsung → selalu set stok ke nilai fisik
    db.prepare(`UPDATE products SET warehouse_stock=? WHERE id=?`).run(stock_fisik, product_id);
    const adjType = selisih >= 0 ? 'in' : 'out';
    db.prepare(`INSERT INTO stock_logs (product_id,type,qty,note,user) VALUES (?,?,?,?,?)`)
      .run(product_id, adjType, Math.abs(selisih),
        `[OPNAME] Stok ${locLabel} diset ke ${stock_fisik} (selisih ${selisih > 0 ? '+' : ''}${selisih})`,
        req.user.username);
  }

  res.json({ ok: true, product_id, stock_system, stock_fisik, selisih, status, updated: !!existingPending });
});

// ===== APPROVE OPNAME (ADMIN) =====
app.post('/api/opname/:id/approve', authMiddleware, adminOnly, (req, res) => {
  const opname = db.prepare('SELECT * FROM stock_opname WHERE id=?').get(req.params.id);
  if (!opname) return res.status(404).json({ error: 'Data opname tidak ditemukan' });
  if (opname.status === 'approved') return res.status(400).json({ error: 'Opname ini sudah di-approve' });

  const prod = db.prepare('SELECT warehouse_stock, default_location FROM products WHERE id=?').get(opname.product_id);
  if (!prod) return res.status(404).json({ error: 'Produk tidak ditemukan' });

  // SELALU set ke nilai fisik — meski selisih 0 sekalipun
  db.prepare(`UPDATE products SET warehouse_stock=? WHERE id=?`).run(opname.stock_fisik, opname.product_id);

  // Hitung ulang selisih pakai stok SAAT approve (bukan saat SO dibuat) supaya akurat
  const currentStock = prod.warehouse_stock;
  const realSelisih = opname.stock_fisik - currentStock;
  const adjType = realSelisih >= 0 ? 'in' : 'out';
  db.prepare(`INSERT INTO stock_logs (product_id,type,qty,note,user) VALUES (?,?,?,?,?)`)
    .run(opname.product_id, adjType, Math.abs(realSelisih),
      `[OPNAME APPROVE] Disetujui ${req.user.username}. Stok diset ke ${opname.stock_fisik} (selisih ${realSelisih > 0 ? '+' : ''}${realSelisih})`,
      opname.user);

  db.prepare(`UPDATE stock_opname SET status='approved', approved_by=?, approved_at=datetime('now','localtime') WHERE id=?`)
    .run(req.user.username, req.params.id);

  res.json({ ok: true, message: 'Opname berhasil di-approve' });
});

// ===== REJECT OPNAME (ADMIN) =====
app.post('/api/opname/:id/reject', authMiddleware, adminOnly, (req, res) => {
  const opname = db.prepare('SELECT * FROM stock_opname WHERE id=?').get(req.params.id);
  if (!opname) return res.status(404).json({ error: 'Data opname tidak ditemukan' });
  if (opname.status !== 'pending') return res.status(400).json({ error: 'Opname ini sudah diproses' });
  db.prepare(`UPDATE stock_opname SET status='rejected', approved_by=?, approved_at=datetime('now','localtime') WHERE id=?`)
    .run(req.user.username, req.params.id);
  res.json({ ok: true, message: 'Opname ditolak' });
});

// ===== EDIT QTY OPNAME (hanya yang masih pending) =====
app.put('/api/opname/:id', authMiddleware, (req, res) => {
  const { stock_fisik } = req.body;
  const opname = db.prepare('SELECT * FROM stock_opname WHERE id=?').get(req.params.id);
  if (!opname) return res.status(404).json({ error: 'Data opname tidak ditemukan' });
  if (opname.status !== 'pending') return res.status(400).json({ error: 'Hanya opname pending yang dapat diedit' });
  // Kasir hanya bisa edit miliknya sendiri
  if (req.user.role !== 'admin' && opname.user !== req.user.username) {
    return res.status(403).json({ error: 'Tidak punya akses untuk mengedit opname ini' });
  }
  if (stock_fisik < 0) return res.status(400).json({ error: 'Stok fisik tidak boleh negatif' });
  const selisih = stock_fisik - opname.stock_system;
  db.prepare('UPDATE stock_opname SET stock_fisik=?, selisih=? WHERE id=?').run(stock_fisik, selisih, req.params.id);
  res.json({ ok: true, selisih });
});

// ===== EXPORT OPNAME KE EXCEL =====
app.get('/api/export/opname', authMiddleware, async (req, res) => {
  const { from, to, status } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (from) { where += ' AND DATE(o.created_at) >= ?'; params.push(from); }
  if (to) { where += ' AND DATE(o.created_at) <= ?'; params.push(to); }
  if (status) { where += ' AND o.status = ?'; params.push(status); }
  const rows = db.prepare(`
    SELECT p.barcode, p.name as product_name, c.name as category_name, p.default_location as site,
           o.stock_fisik, o.stock_system, o.selisih, o.user, o.created_at, o.status
    FROM stock_opname o
    JOIN products p ON p.id = o.product_id
    JOIN categories c ON c.id = p.category_id
    ${where}
    ORDER BY o.created_at DESC
  `).all(...params);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Stock Opname');
  sheet.columns = [
    { header: 'Barcode', key: 'barcode', width: 18 },
    { header: 'Nama Produk', key: 'product_name', width: 30 },
    { header: 'Kategori', key: 'category_name', width: 16 },
    { header: 'Site', key: 'site', width: 10 },
    { header: 'Qty SO (Fisik)', key: 'stock_fisik', width: 14 },
    { header: 'Stok Sistem', key: 'stock_system', width: 14 },
    { header: 'Selisih', key: 'selisih', width: 10 },
    { header: 'Petugas', key: 'user', width: 15 },
    { header: 'Waktu', key: 'created_at', width: 20 },
    { header: 'Status', key: 'status', width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };
  rows.forEach(r => sheet.addRow({
    ...r,
    site: r.site === 'mess' ? 'MIMS/Mess' : 'MIOF/Office',
  }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="stock-opname.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// ===== EXPORT TO EXCEL: DATA PRODUK =====
app.get('/api/export/products', authMiddleware, async (req, res) => {
  const products = db.prepare(`
    SELECT p.default_location as lokasi, p.barcode, p.name, p.sku, c.name as category, p.price,
           p.warehouse_stock, p.warehouse_min, p.warehouse_max, p.unit
    FROM products p JOIN categories c ON c.id=p.category_id ORDER BY c.name, p.name
  `).all();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KOPPA STOK';

  const sheet = workbook.addWorksheet('Data Produk');

  // ---- Title block ----
  sheet.mergeCells('A1:J1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'DATA PRODUK KOPPA STOK';
  titleCell.font = { size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0C2D6B' } };
  sheet.getRow(1).height = 36;

  sheet.mergeCells('A2:J2');
  const subCell = sheet.getCell('A2');
  subCell.value = `Tanggal Cetak : ${new Date().toLocaleString('id-ID')}   |   Total Produk : ${products.length}`;
  subCell.font = { size: 10, italic: true, color: { argb: 'FF1A56DB' } };
  subCell.alignment = { horizontal: 'center', vertical: 'middle' };
  subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
  sheet.getRow(2).height = 20;

  // ---- Column definitions (row 3) ----
  sheet.columns = [
    { key: 'lokasi',          width: 12 },
    { key: 'barcode',         width: 18 },
    { key: 'name',            width: 38 },
    { key: 'sku',             width: 14 },
    { key: 'category',        width: 18 },
    { key: 'unit',            width: 8  },
    { key: 'price',           width: 14 },
    { key: 'warehouse_stock', width: 13 },
    { key: 'warehouse_min',   width: 11 },
    { key: 'warehouse_max',   width: 11 },
  ];

  const headers = ['Lokasi','Barcode','Nama Produk','SKU','Kategori','Satuan','Harga','Stok','Min','Max'];
  const headerRow = sheet.getRow(3);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56DB' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { top:{style:'thin',color:{argb:'FFFFFFFF'}}, left:{style:'thin',color:{argb:'FFFFFFFF'}}, bottom:{style:'thin',color:{argb:'FFFFFFFF'}}, right:{style:'thin',color:{argb:'FFFFFFFF'}} };
  });
  headerRow.height = 28;

  // ---- Data rows ----
  products.forEach((p, idx) => {
    const row = sheet.addRow([
      p.lokasi === 'mess' ? 'MIMS' : 'MIOF',
      p.barcode || '-',
      p.name,
      p.sku || '-',
      p.category,
      p.unit || 'PCS',
      p.price,
      p.warehouse_stock,
      p.warehouse_min,
      p.warehouse_max,
    ]);
    const isEven = idx % 2 === 0;
    const bgColor = isEven ? 'FFF9FAFB' : 'FFFFFFFF';
    row.eachCell((cell, colNum) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
      cell.border = { top:{style:'thin',color:{argb:'FFE5E7EB'}}, left:{style:'thin',color:{argb:'FFE5E7EB'}}, bottom:{style:'thin',color:{argb:'FFE5E7EB'}}, right:{style:'thin',color:{argb:'FFE5E7EB'}} };
      cell.font = { size: 9.5 };
      if (colNum === 1) {
        cell.font = { size: 9.5, bold: true, color: { argb: p.lokasi === 'mess' ? 'FF0F9B52' : 'FF1A56DB' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
      if (colNum === 7) { cell.numFmt = '#,##0'; cell.alignment = { horizontal: 'right' }; }
      if ([8,9,10].includes(colNum)) { cell.alignment = { horizontal: 'center' }; }
    });
    row.height = 18;
  });

  // ---- Footer ----
  const lastR = sheet.lastRow.number + 2;
  sheet.mergeCells(`A${lastR}:D${lastR}`);
  sheet.getCell(`A${lastR}`).value = `Total : ${products.length} produk`;
  sheet.getCell(`A${lastR}`).font = { bold: true, size: 10, color: { argb: 'FF1A56DB' } };
  sheet.getCell(`J${lastR + 3}`).value = `Palembang, ${new Date().toLocaleDateString('id-ID')}`;
  sheet.getCell(`J${lastR + 5}`).value = 'Administrator';
  sheet.getCell(`J${lastR + 9}`).value = '(____________________)';

  sheet.views = [{ state: 'frozen', ySplit: 3 }];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Data-Produk-KOPPA.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});
app.get('/api/products/by-barcode/:barcode', authMiddleware, (req, res) => {

  const product = db.prepare(`
    SELECT p.*,
           c.name as category_name
    FROM products p
    LEFT JOIN categories c
      ON c.id = p.category_id
    WHERE p.barcode = ?
  `).get(req.params.barcode);

  if (!product) {
    return res.status(404).json({
      error: 'Produk tidak ditemukan'
    });
  }

  res.json(product);

});
// ===== EXPORT TO EXCEL: RIWAYAT STOK =====
app.get('/api/export/logs', authMiddleware, async (req, res) => {
  const { from, to, type } = req.query;

  // --- Query stok (semua site) ---
  let sqlLogs = `
    SELECT l.created_at, p.name as product_name, c.name as category_name, p.default_location as site, l.type, l.qty, l.note, l.user
    FROM stock_logs l
    JOIN products p ON p.id=l.product_id
    JOIN categories c ON c.id=p.category_id
    WHERE (l.note IS NULL OR (l.note NOT LIKE '[OPNAME]%' AND l.note NOT LIKE '[OPNAME APPROVE]%'))
  `;
  const params = [];
  // Kasir cuma export riwayat input MEREKA SENDIRI — admin tetap export semua.
  if (req.user.role !== 'admin') { sqlLogs += ` AND l.user = ?`; params.push(req.user.username); }
  if (from) { sqlLogs += ` AND date(l.created_at) >= date(?)`; params.push(from); }
  if (to)   { sqlLogs += ` AND date(l.created_at) <= date(?)`; params.push(to); }
  if (type && type !== 'all') { sqlLogs += ` AND l.type=?`; params.push(type); }
  sqlLogs += ` ORDER BY l.id DESC`;
  const logs = db.prepare(sqlLogs).all(...params);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KOPPA STOK';

  // ===================== helper style =====================
  function styleHeaderRow(row, cols, bgArgb) {
    cols.forEach((label, i) => {
      const cell = row.getCell(i + 1);
      cell.value = label;
      cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top:{style:'thin',color:{argb:'FFFFFFFF'}}, left:{style:'thin',color:{argb:'FFFFFFFF'}}, bottom:{style:'thin',color:{argb:'FFFFFFFF'}}, right:{style:'thin',color:{argb:'FFFFFFFF'}} };
    });
    row.height = 26;
  }
  function styleDataRow(row, idx) {
    const bg = idx % 2 === 0 ? 'FFF9FAFB' : 'FFFFFFFF';
    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.border = { top:{style:'thin',color:{argb:'FFE5E7EB'}}, left:{style:'thin',color:{argb:'FFE5E7EB'}}, bottom:{style:'thin',color:{argb:'FFE5E7EB'}}, right:{style:'thin',color:{argb:'FFE5E7EB'}} };
      cell.font = { size: 9.5 };
    });
    row.height = 17;
  }
  function addTitleBlock(sheet, title, sub, mergeEnd) {
    sheet.mergeCells(`A1:${mergeEnd}1`);
    const t = sheet.getCell('A1');
    t.value = title;
    t.font = { size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
    t.alignment = { horizontal: 'center', vertical: 'middle' };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0C2D6B' } };
    sheet.getRow(1).height = 34;

    sheet.mergeCells(`A2:${mergeEnd}2`);
    const s = sheet.getCell('A2');
    s.value = sub;
    s.font = { size: 9.5, italic: true, color: { argb: 'FF1A56DB' } };
    s.alignment = { horizontal: 'center', vertical: 'middle' };
    s.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
    sheet.getRow(2).height = 18;
  }

  const periodeStr = `${from || 'Semua'} s/d ${to || 'Semua'}`;
  const nowStr = new Date().toLocaleString('id-ID');

  // ===================== SHEET 1: Riwayat Stok (semua site) =====================
  const sh1 = workbook.addWorksheet('Riwayat Stok');
  addTitleBlock(sh1, 'RIWAYAT STOK MASUK / KELUAR (MIOF & MIMS)', `Periode : ${periodeStr}   |   Cetak : ${nowStr}   |   Total : ${logs.length} transaksi`, 'H');

  sh1.columns = [
    { key: 'waktu',    width: 22 },
    { key: 'produk',   width: 36 },
    { key: 'kategori', width: 16 },
    { key: 'site',     width: 10 },
    { key: 'tipe',     width: 16 },
    { key: 'jumlah',   width: 10 },
    { key: 'catatan',  width: 30 },
    { key: 'petugas',  width: 14 },
  ];
  styleHeaderRow(sh1.getRow(3), ['Waktu','Produk','Kategori','Site','Tipe','Jumlah','Catatan','Petugas'], 'FF1A56DB');

  logs.forEach((item, idx) => {
    const row = sh1.addRow([
      item.created_at, item.product_name, item.category_name,
      item.site === 'mess' ? 'MIMS' : 'MIOF',
      item.type === 'in' ? 'STOK MASUK' : 'STOK KELUAR',
      item.qty, item.note || '-', item.user || '-'
    ]);
    styleDataRow(row, idx);
    const tipeCell = row.getCell(5);
    tipeCell.font = { bold: true, size: 9.5, color: { argb: item.type === 'in' ? 'FF0F9B52' : 'FFE02424' } };
    row.getCell(6).alignment = { horizontal: 'center' };
  });

  sh1.views = [{ state: 'frozen', ySplit: 3 }];
  const lr1 = sh1.lastRow.number + 2;
  sh1.mergeCells(`A${lr1}:D${lr1}`);
  sh1.getCell(`A${lr1}`).value = `Total Transaksi : ${logs.length}`;
  sh1.getCell(`A${lr1}`).font = { bold: true, color: { argb: 'FF1A56DB' } };
  sh1.getCell(`H${lr1 + 3}`).value = `Palembang, ${new Date().toLocaleDateString('id-ID')}`;
  sh1.getCell(`H${lr1 + 5}`).value = 'Administrator';
  sh1.getCell(`H${lr1 + 9}`).value = '(____________________)';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Riwayat-Stok-KOPPA.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// ===== EXPORT LAPORAN LENGKAP (1 SHEET) =====
app.get('/api/export/laporan', authMiddleware, async (req, res) => {
  const { from, to, type } = req.query;
  const periodeStr = `${from || 'Semua'} s/d ${to || 'Semua'}`;
  const nowStr = new Date().toLocaleString('id-ID');

  let sqlLogs = `SELECT l.created_at, p.name as product_name, c.name as category_name, p.default_location as site, l.type, l.qty, l.note, l.user
    FROM stock_logs l JOIN products p ON p.id=l.product_id JOIN categories c ON c.id=p.category_id WHERE 1=1`;
  const p1 = [];
  if (from) { sqlLogs += ` AND date(l.created_at) >= date(?)`; p1.push(from); }
  if (to)   { sqlLogs += ` AND date(l.created_at) <= date(?)`; p1.push(to); }
  // Kecualikan entri dari Stock Opname di sini — sheet Stock Opname di bawah
  // sudah nampilin datanya sendiri, supaya gak dobel-hitung di 2 sheet.
  sqlLogs += ` AND (l.note IS NULL OR (l.note NOT LIKE '[OPNAME]%' AND l.note NOT LIKE '[OPNAME APPROVE]%'))`;
  if (type && type !== 'all' && type !== 'so') { sqlLogs += ` AND l.type=?`; p1.push(type); }
  const logs = (type === 'so') ? [] : db.prepare(sqlLogs + ` ORDER BY l.created_at DESC`).all(...p1);

  let sqlOp = `SELECT o.created_at, p.name as product_name, c.name as category_name, p.default_location as site,
    o.stock_fisik, o.stock_system, o.selisih, o.user, o.status
    FROM stock_opname o JOIN products p ON p.id=o.product_id JOIN categories c ON c.id=p.category_id WHERE 1=1`;
  const p3 = [];
  if (from) { sqlOp += ` AND date(o.created_at) >= date(?)`; p3.push(from); }
  if (to)   { sqlOp += ` AND date(o.created_at) <= date(?)`; p3.push(to); }
  const opnames = db.prepare(sqlOp + ` ORDER BY o.created_at DESC`).all(...p3);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KOPPA STOK';
  const sh = workbook.addWorksheet('Laporan Lengkap');

  function styleHdr(row, labels, bg) {
    labels.forEach((h, i) => {
      const cell = row.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top:{style:'thin',color:{argb:'FFFFFFFF'}}, left:{style:'thin',color:{argb:'FFFFFFFF'}}, bottom:{style:'thin',color:{argb:'FFFFFFFF'}}, right:{style:'thin',color:{argb:'FFFFFFFF'}} };
    });
    row.height = 26;
  }
  function styleDat(row, idx, cols) {
    const bg = idx % 2 === 0 ? 'FFF9FAFB' : 'FFFFFFFF';
    for (let c = 1; c <= cols; c++) {
      const cell = row.getCell(c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.border = { top:{style:'thin',color:{argb:'FFE5E7EB'}}, left:{style:'thin',color:{argb:'FFE5E7EB'}}, bottom:{style:'thin',color:{argb:'FFE5E7EB'}}, right:{style:'thin',color:{argb:'FFE5E7EB'}} };
      cell.font = { size: 9.5 };
    }
    row.height = 17;
  }
  function secTitle(text, bg) {
    sh.addRow([]);
    const r = sh.addRow([text]);
    sh.mergeCells(`A${r.number}:I${r.number}`);
    r.getCell(1).font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    r.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
    r.height = 24;
    sh.addRow([]);
  }

  sh.columns = [
    {key:'a',width:22},{key:'b',width:38},{key:'c',width:16},
    {key:'d',width:18},{key:'e',width:12},{key:'f',width:14},
    {key:'g',width:28},{key:'h',width:14},{key:'i',width:14},
  ];

  sh.mergeCells('A1:H1');
  const t1 = sh.getCell('A1');
  t1.value = 'LAPORAN LENGKAP KOPPA MART';
  t1.font = { size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  t1.alignment = { horizontal: 'center', vertical: 'middle' };
  t1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0C2D6B' } };
  sh.getRow(1).height = 36;
  sh.mergeCells('A2:H2');
  const s2 = sh.getCell('A2');
  s2.value = `Periode : ${periodeStr}   |   Dicetak : ${nowStr}`;
  s2.font = { size: 9.5, italic: true, color: { argb: 'FF1A56DB' } };
  s2.alignment = { horizontal: 'center', vertical: 'middle' };
  s2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
  sh.getRow(2).height = 18;

  secTitle(`STOK MASUK / KELUAR   |   Total: ${logs.length} transaksi`, 'FF1A56DB');
  styleHdr(sh.addRow(['Waktu','Produk','Kategori','Site','Tipe','Jumlah','Catatan','Petugas']),
    ['Waktu','Produk','Kategori','Site','Tipe','Jumlah','Catatan','Petugas'], 'FF1A56DB');
  if (logs.length === 0) {
    const r = sh.addRow(['Tidak ada data']); sh.mergeCells(`A${r.number}:I${r.number}`);
    r.getCell(1).alignment={horizontal:'center'}; r.getCell(1).font={italic:true,color:{argb:'FF94A3B8'}};
  } else {
    logs.forEach((item, idx) => {
      const row = sh.addRow([item.created_at, item.product_name, item.category_name,
        item.site==='mess'?'MIMS':'MIOF', item.type==='in'?'STOK MASUK':'STOK KELUAR', item.qty, item.note||'-', item.user||'-']);
      styleDat(row, idx, 8);
      row.getCell(5).font={bold:true,size:9.5,color:{argb:item.type==='in'?'FF0F9B52':'FFE02424'}};
      row.getCell(6).alignment={horizontal:'center'};
    });
  }

  secTitle(`STOCK OPNAME   |   Total: ${opnames.length} data`, 'FF7C3AED');
  styleHdr(sh.addRow(['Waktu','Produk','Kategori','Site','Qty Fisik','Stok Sistem','Selisih','Status']),
    ['Waktu','Produk','Kategori','Site','Qty Fisik','Stok Sistem','Selisih','Status'], 'FF7C3AED');
  if (opnames.length === 0) {
    const r = sh.addRow(['Tidak ada data']); sh.mergeCells(`A${r.number}:H${r.number}`);
    r.getCell(1).alignment={horizontal:'center'}; r.getCell(1).font={italic:true,color:{argb:'FF94A3B8'}};
  } else {
    opnames.forEach((item, idx) => {
      const selisih = item.selisih || (item.stock_fisik - item.stock_system);
      const stLabel = item.status==='approved'?'APPROVED':item.status==='rejected'?'DITOLAK':'PENDING';
      const row = sh.addRow([item.created_at, item.product_name, item.category_name,
        item.site==='mess'?'MIMS':'MIOF',
        item.stock_fisik, item.stock_system, selisih, stLabel]);
      styleDat(row, idx, 8);
      [5,6,7].forEach(c => row.getCell(c).alignment={horizontal:'center'});
      if (selisih!==0) row.getCell(7).font={bold:true,size:9.5,color:{argb:selisih<0?'FFE02424':'FF0F9B52'}};
      row.getCell(8).font={bold:true,size:9.5,color:{argb:item.status==='approved'?'FF0F9B52':item.status==='rejected'?'FFE02424':'FFD97706'}};
    });
  }

  sh.addRow([]); sh.addRow([]);
  const fRow = sh.lastRow.number;
  sh.getCell(`F${fRow}`).value = `Palembang, ${new Date().toLocaleDateString('id-ID')}`;
  sh.getCell(`F${fRow+2}`).value = 'Administrator';
  sh.getCell(`F${fRow+6}`).value = '(____________________)';
  sh.pageSetup = { paperSize:9, orientation:'landscape', fitToPage:true, fitToWidth:1, fitToHeight:0,
    margins:{left:0.5,right:0.5,top:0.75,bottom:0.75,header:0.3,footer:0.3} };
  sh.headerFooter = {
    oddHeader:'&C&B&14KOPPA STOK — Laporan Lengkap',
    oddFooter:`&LDicetak: ${nowStr}&C&P / &N&RPeriode: ${periodeStr}`,
  };
  sh.views = [{state:'frozen',ySplit:2}];

  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="Laporan-Stok-Keseluruhan.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// ===== EXPORT PDF =====
app.get('/api/export/logs-pdf', authMiddleware, (req, res) => {
  const { from, to, type } = req.query;

  let sql = `
    SELECT l.created_at, p.name as product_name, c.name as category_name, p.default_location as site, l.type, l.qty, l.note, l.user
    FROM stock_logs l
    JOIN products p ON p.id=l.product_id
    JOIN categories c ON c.id=p.category_id
    WHERE 1=1
  `;
  const params = [];
  if (from) { sql += ` AND date(l.created_at) >= date(?)`; params.push(from); }
  if (to)   { sql += ` AND date(l.created_at) <= date(?)`; params.push(to); }
  if (type === 'so') {
    sql += ` AND (l.note LIKE '[OPNAME]%' OR l.note LIKE '[OPNAME APPROVE]%')`;
  } else if (type && type !== 'all') {
    sql += ` AND l.type=? AND (l.note IS NULL OR (l.note NOT LIKE '[OPNAME]%' AND l.note NOT LIKE '[OPNAME APPROVE]%'))`;
    params.push(type);
  }
  sql += ` ORDER BY l.id DESC`;
  const logs = db.prepare(sql).all(...params);

  // Current stock
  const stocks = db.prepare(`
    SELECT p.name, c.name as cat, p.default_location as site, p.warehouse_stock,
           p.warehouse_min, p.price
    FROM products p JOIN categories c ON c.id=p.category_id ORDER BY p.name
  `).all();

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const ML = 36, MR = 36, MT = 36;
  const CW = PAGE_W - ML - MR;   // content width

  const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="Laporan-KOPPA-STOK.pdf"');
  doc.pipe(res);

  // ── HELPERS ──────────────────────────────────────────────
  const DARK_BLUE = '#0C2D6B';
  const MID_BLUE  = '#1A56DB';
  const LIGHT_BG  = '#EBF2FF';
  const GREEN     = '#0F9B52';
  const RED       = '#E02424';
  const GRAY_TEXT = '#6B7280';
  const BORDER    = '#E5E7EB';
  const ROW_ALT   = '#F9FAFB';

  function truncate(str, maxLen) {
    if (!str) return '-';
    str = String(str);
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
  }

  function drawRect(x, y, w, h, color) {
    doc.rect(x, y, w, h).fill(color);
  }

  let curY = 0;

  function checkPageBreak(needed = 20) {
    if (curY + needed > PAGE_H - 60) {
      doc.addPage();
      curY = MT;
    }
  }

  // ── PAGE HEADER ───────────────────────────────────────────
  function drawPageHeader() {
    // Dark banner
    drawRect(0, 0, PAGE_W, 70, DARK_BLUE);
    // Accent strip
    drawRect(0, 70, PAGE_W, 4, MID_BLUE);

    // Logo boxes (mini)
    doc.save();
    doc.roundedRect(ML, 14, 18, 18, 3).fill('#FFFFFF').fillOpacity(0.9);
    doc.roundedRect(ML + 20, 14, 12, 18, 3).fill('#FFFFFF').fillOpacity(0.4);
    doc.roundedRect(ML, 34, 12, 18, 3).fill('#FFFFFF').fillOpacity(0.4);
    doc.roundedRect(ML + 20, 34, 18, 18, 3).fill('#FFFFFF').fillOpacity(0.9);
    doc.restore();

    doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold')
       .text('KOPPA STOK', ML + 38, 16);
    doc.fillColor('#93C5FD').fontSize(9).font('Helvetica')
       .text('Sistem Manajemen Inventori', ML + 39, 36);

    doc.fillColor('#FFFFFF').fontSize(14).font('Helvetica-Bold')
       .text('LAPORAN TRANSAKSI STOK', 0, 22, { align: 'center', width: PAGE_W });

    curY = 84;

    // Info band
    drawRect(ML, curY, CW, 32, LIGHT_BG);
    doc.rect(ML, curY, CW, 32).stroke(BORDER);
    const periodeStr = `${from || 'Semua'}  s/d  ${to || 'Semua'}`;
    doc.fillColor(MID_BLUE).fontSize(8.5).font('Helvetica-Bold')
       .text('PERIODE :', ML + 10, curY + 6);
    doc.fillColor('#111827').font('Helvetica')
       .text(periodeStr, ML + 60, curY + 6);
    doc.fillColor(MID_BLUE).font('Helvetica-Bold')
       .text('CETAK :', ML + 10, curY + 18);
    doc.fillColor('#111827').font('Helvetica')
       .text(new Date().toLocaleString('id-ID'), ML + 60, curY + 18);
    // Right stats
    doc.fillColor(MID_BLUE).font('Helvetica-Bold').fontSize(8.5)
       .text(`Total Transaksi : ${logs.length}`, PAGE_W - MR - 140, curY + 6, { width: 136, align: 'right' });
    doc.fillColor(GRAY_TEXT).font('Helvetica').fontSize(8)
       .text('Riwayat Stok (MIOF & MIMS)', PAGE_W - MR - 140, curY + 18, { width: 136, align: 'right' });

    curY += 42;
  }

  drawPageHeader();

  // ── SECTION TITLE ─────────────────────────────────────────
  function sectionTitle(label, color = MID_BLUE) {
    checkPageBreak(30);
    drawRect(ML, curY, CW, 22, color);
    doc.fillColor('#FFFFFF').fontSize(9.5).font('Helvetica-Bold')
       .text(label, ML + 10, curY + 6, { width: CW - 10 });
    curY += 22;
  }

  // ── TABLE HEADER ──────────────────────────────────────────
  // cols: [{label, x, w, align?}]
  function tableHeader(cols) {
    checkPageBreak(22);
    drawRect(ML, curY, CW, 20, '#E8F0FE');
    doc.rect(ML, curY, CW, 20).stroke(BORDER);
    cols.forEach(c => {
      doc.fillColor(DARK_BLUE).fontSize(8).font('Helvetica-Bold')
         .text(c.label, ML + c.x, curY + 6, { width: c.w, align: c.align || 'left' });
    });
    curY += 20;
  }

  // ── TABLE ROW ─────────────────────────────────────────────
  function tableRow(cols, values, rowIdx, rowH = 16) {
    checkPageBreak(rowH + 2);
    const bg = rowIdx % 2 === 0 ? '#FFFFFF' : ROW_ALT;
    drawRect(ML, curY, CW, rowH, bg);
    doc.rect(ML, curY, CW, rowH).stroke(BORDER);
    cols.forEach((c, i) => {
      const val = values[i];
      if (val && val._color) {
        doc.fillColor(val._color).fontSize(7.5).font('Helvetica-Bold')
           .text(val.text, ML + c.x, curY + 4, { width: c.w, align: c.align || 'left' });
      } else {
        doc.fillColor('#111827').fontSize(7.5).font('Helvetica')
           .text(String(val ?? '-'), ML + c.x, curY + 4, { width: c.w, align: c.align || 'left' });
      }
    });
    curY += rowH;
  }

  // ── SECTION 1: Riwayat Stok (semua site) ────────────
  sectionTitle('RIWAYAT STOK MASUK / KELUAR — MIOF & MIMS');

  const logsColDef = [
    { label: 'WAKTU',    x:  0,   w: 98,  align: 'left' },
    { label: 'PRODUK',   x: 100,  w: 155, align: 'left' },
    { label: 'KATEGORI', x: 257,  w: 62,  align: 'left' },
    { label: 'SITE',     x: 321,  w: 34,  align: 'center' },
    { label: 'TIPE',     x: 357,  w: 52,  align: 'center' },
    { label: 'QTY',      x: 411,  w: 28,  align: 'center' },
    { label: 'CATATAN',  x: 441,  w: 58,  align: 'left' },
    { label: 'PETUGAS',  x: 501,  w: 46,  align: 'left' },
  ];

  tableHeader(logsColDef);

  if (logs.length === 0) {
    checkPageBreak(20);
    doc.fillColor(GRAY_TEXT).fontSize(9).font('Helvetica')
       .text('— Tidak ada data transaksi —', ML, curY + 4, { width: CW, align: 'center' });
    curY += 20;
  } else {
    logs.forEach((item, idx) => {
      const isOpname = item.note && (item.note.startsWith('[OPNAME]') || item.note.startsWith('[OPNAME APPROVE]'));
      const tipeVal = isOpname
        ? { text: 'SO', _color: '#7C3AED' }
        : (item.type === 'in'
          ? { text: 'MASUK',  _color: GREEN }
          : { text: 'KELUAR', _color: RED });
      tableRow(logsColDef, [
        truncate(item.created_at, 18),
        truncate(item.product_name, 28),
        truncate(item.category_name, 12),
        item.site === 'mess' ? 'MIMS' : 'MIOF',
        tipeVal,
        item.qty,
        truncate(item.note, 10),
        truncate(item.user, 10),
      ], idx, 16);
    });
  }

  // ── TOTAL ROW ─────────────────────────────────────────────
  checkPageBreak(20);
  drawRect(ML, curY, CW, 18, LIGHT_BG);
  doc.rect(ML, curY, CW, 18).stroke(BORDER);
  doc.fillColor(MID_BLUE).fontSize(8.5).font('Helvetica-Bold')
     .text(`Total Transaksi : ${logs.length}`, ML + 8, curY + 5);
  curY += 24;

  // ── SECTION 2: Stok Saat Ini ──────────────────────────────
  checkPageBreak(40);
  sectionTitle('KONDISI STOK SAAT INI', DARK_BLUE);

  const stColDef = [
    { label: 'PRODUK',    x:   0, w: 175, align: 'left' },
    { label: 'KATEGORI',  x: 177, w: 72,  align: 'left' },
    { label: 'SITE',      x: 251, w: 36,  align: 'center' },
    { label: 'STOK',      x: 289, w: 36,  align: 'center' },
    { label: 'MIN',       x: 327, w: 36,  align: 'center' },
    { label: 'HARGA',     x: 365, w: 62,  align: 'right' },
    { label: 'STATUS',    x: 429, w: 90,  align: 'center' },
  ];

  tableHeader(stColDef);

  stocks.forEach((p, idx) => {
    const isLow = p.warehouse_stock <= p.warehouse_min;
    const statusVal = isLow
      ? { text: 'PERLU ORDER', _color: RED }
      : { text: 'OK', _color: GREEN };
    const hargaStr = 'Rp' + p.price.toLocaleString('id-ID');
    tableRow(stColDef, [
      truncate(p.name, 32),
      truncate(p.cat, 14),
      p.site === 'mess' ? 'MIMS' : 'MIOF',
      p.warehouse_stock,
      p.warehouse_min,
      hargaStr,
      statusVal,
    ], idx, 15);
  });

  // ── FOOTER ────────────────────────────────────────────────
  checkPageBreak(100);
  curY += 16;
  drawRect(ML, curY, CW, 1, BORDER);
  curY += 12;

  doc.fillColor(GRAY_TEXT).fontSize(8).font('Helvetica')
     .text(`Total : ${logs.length} transaksi stok  |  ${stocks.length} produk`, ML, curY);

  const signX = PAGE_W - MR - 160;
  doc.fillColor('#111827').fontSize(9).font('Helvetica')
     .text(`Palembang, ${new Date().toLocaleDateString('id-ID')}`, signX, curY, { width: 160, align: 'center' });
  curY += 16;
  doc.font('Helvetica-Bold').text('Administrator', signX, curY, { width: 160, align: 'center' });
  curY += 52;
  doc.font('Helvetica').text('(____________________)', signX, curY, { width: 160, align: 'center' });

  // ── PAGE NUMBERS ──────────────────────────────────────────
  const pages = doc.bufferedPageRange ? doc.bufferedPageRange() : null;

  doc.end();
});

app.post(
  '/api/products/import',
  authMiddleware,
  adminOnly,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'File Excel belum dipilih' });

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(req.file.path);
      const sheet = workbook.getWorksheet(1);

      let dilewati = 0;
      const gagal = [];

      function safeNum(val, def = 0) {
        if (val === null || val === undefined) return def;
        // ExcelJS bisa return object {text, result} untuk formula cell,
        // atau {error: '#N/A'} / {error: '#REF!'} dst untuk sel yang error —
        // keduanya HARUS jatuh ke default, jangan sampai kebaca sebagai 0.
        if (typeof val === 'object' && val !== null) {
          if (val.error !== undefined) return def;
          val = val.result !== undefined ? val.result : (val.text !== undefined ? val.text : def);
        }
        const s = String(val).trim();
        if (s === '' || s.startsWith('#')) return def;
        const n = parseFloat(s.replace(/,/g, ''));
        return isNaN(n) ? def : Math.round(n);
      }

      function safeStr(val) {
        if (val === null || val === undefined) return '';
        if (typeof val === 'object' && val !== null) {
          if (val.error !== undefined) return '';
          val = val.result !== undefined ? val.result : (val.text || val.richText?.[0]?.text || '');
        }
        return String(val).trim();
      }

      // TAHAP 0: baca baris header (baris 1) untuk deteksi posisi kolom
      // berdasarkan NAMA kolom, bukan posisi tetap — karena template
      // MIOF/Office dan MIMS/Mess punya urutan kolom yang beda (template
      // Mess tidak punya kolom "Unit of Measure").
      // Kolom yang dikenali: Lokasi, Barcode, Nama Produk, Kategori Produk,
      // Jumlah/Quantity, Satuan/Unit, Harga/Price, Min, Max.
      const headerRow = sheet.getRow(1);
      const colMap = {}; // { location, barcode, name, category, qty, unit, price, min, max } -> nomor kolom
      headerRow.eachCell((cell, colNum) => {
        const h = safeStr(cell.value).toLowerCase();
        if (!h) return;
        if (h.includes('location') || h.includes('lokasi')) colMap.location = colNum;
        else if (h.includes('barcode')) colMap.barcode = colNum;
        else if (h.includes('categ') || h.includes('kategori')) colMap.category = colNum;
        else if (h.includes('quantity') || h === 'qty' || h.includes('jumlah')) colMap.qty = colNum;
        else if (h.includes('unit') || h.includes('satuan')) colMap.unit = colNum;
        else if (h.includes('price') || h.includes('harga')) colMap.price = colNum;
        else if (h === 'min' || h.includes('minimal') || h.includes('min stok') || h.includes('min. stok')) colMap.min = colNum;
        else if (h === 'max' || h.includes('maksimal') || h.includes('max stok') || h.includes('max. stok')) colMap.max = colNum;
        else if (h === 'product' || h.includes('nama produk') || h.includes('product name')) colMap.name = colNum;
      });

      // Fallback ke posisi kolom standar (urutan template lama) kalau ada
      // header yang tidak berhasil dikenali dari namanya. Kolom "unit"
      // SENGAJA tidak difallback ke posisi tetap — kalau memang tidak ada
      // kolom Satuan/Unit di template (mis. template Mess), biarkan kosong
      // supaya tidak nabrak kolom lain (mis. Harga), lalu default ke "PCS".
      const fallback = { location: 1, barcode: 2, name: 3, category: 4, qty: 5, price: 7, min: 8, max: 9 };
      for (const key in fallback) if (!colMap[key]) colMap[key] = fallback[key];

      // TAHAP 1: baca semua baris
      // Key = barcode + '|' + lokasi → beda lokasi = produk terpisah, sama lokasi+barcode = duplikat
      const productMap = new Map();
      let duplikat = 0;

      sheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;

        const locationRaw  = safeStr(row.getCell(colMap.location).value);
        const barcode      = safeStr(row.getCell(colMap.barcode).value);
        const productText  = safeStr(row.getCell(colMap.name).value);
        const categoryName = (safeStr(row.getCell(colMap.category).value) || 'LAINNYA').toUpperCase();
        const qty          = safeNum(row.getCell(colMap.qty).value, 0);
        // Kolom Satuan/Unit boleh tidak ada di template (mis. template Mess) → default PCS
        const unit         = colMap.unit ? (safeStr(row.getCell(colMap.unit).value) || 'PCS') : 'PCS';
        const price        = safeNum(row.getCell(colMap.price).value, 0);
        // Standar Min/Max perusahaan = 48 / 1000. Kalau selnya kosong atau
        // error (mis. "#N/A"), jangan sampai kebaca 0 — pakai standar ini.
        const minQty       = safeNum(row.getCell(colMap.min).value, 48);
        const maxQty       = safeNum(row.getCell(colMap.max).value, 1000);

        if (!barcode && !productText) { dilewati++; return; }
        if (!barcode) { gagal.push({ rowNum, info: productText, error: 'Barcode kosong' }); return; }
        if (!productText) { gagal.push({ rowNum, barcode, error: 'Nama produk kosong' }); return; }

        let sku = '', name = productText;
        const m = productText.match(/^\[([^\]]+)\]\s*(.+)$/);
        if (m) { sku = m[1].trim(); name = m[2].trim(); }

        const locUp = locationRaw.toUpperCase();
        const isMess = locUp.includes('MIMS') || locUp.includes('MIPL') || locUp.includes('MESS') || locUp.includes('DISPLAY');
        const locKey = isMess ? 'mess' : 'office';

        // Kolom Satuan/Unit boleh tidak ada di template (mis. template Mess).
        // Kalau kosong, coba warisi satuan dari produk yang sama (barcode sama)
        // di site MIOF/Office yang sudah ada di database, sebelum default ke PCS.
        let finalUnit = unit;
        if (!colMap.unit || !unit) {
          const officeMatch = barcode
            ? db.prepare('SELECT unit FROM products WHERE barcode=? AND default_location=?').get(barcode, 'office')
            : null;
          finalUnit = (officeMatch && officeMatch.unit) ? officeMatch.unit : 'PCS';
        }

        // Key unik = barcode + lokasi → beda lokasi = produk terpisah
        const mapKey = barcode + '|' + locKey;

        if (productMap.has(mapKey)) {
          // Barcode + lokasi sama → baris duplikat di Excel, gabung qty saja
          const e = productMap.get(mapKey);
          e.qty += qty;
          duplikat++;
          return;
        }

        productMap.set(mapKey, {
          barcode, name, sku, categoryName, unit: finalUnit, price, minQty, maxQty,
          locKey, qty,
        });
      });

      // Kategori yang boleh otomatis dibuat dari import. Kategori lain di luar
      // daftar ini (mis. "SEMBAKO" di template lama) akan dipetakan ke "LAINNYA"
      // supaya daftar kategori tidak membengkak sendiri — kalau memang mau
      // menambah kategori baru, tambahkan manual lewat menu Kategori.
      const ALLOWED_CATEGORIES = ['MAKANAN', 'MINUMAN', 'ROKOK', 'LAINNYA'];

      // TAHAP 2: upsert ke DB
      // Barcode + lokasi sama → update; barcode sama tapi lokasi beda → insert baru
      let berhasil = 0;
      db.exec('BEGIN');
      try {
        for (const [mapKey, p] of productMap) {
          try {
            let cat = db.prepare('SELECT id FROM categories WHERE UPPER(name)=?').get(p.categoryName);
            if (!cat) {
              if (ALLOWED_CATEGORIES.includes(p.categoryName)) {
                const display = p.categoryName.charAt(0) + p.categoryName.slice(1).toLowerCase();
                db.prepare('INSERT INTO categories (name) VALUES (?)').run(display);
                cat = db.prepare('SELECT id FROM categories WHERE UPPER(name)=?').get(p.categoryName);
              } else {
                // Kategori tidak dikenal → masukkan ke "Lainnya", jangan bikin kategori baru
                cat = db.prepare('SELECT id FROM categories WHERE UPPER(name)=?').get('LAINNYA');
              }
            }

            // Cari di DB: harus cocok BARCODE + LOKASI keduanya
            const existing = db.prepare(
              'SELECT id FROM products WHERE barcode=? AND default_location=?'
            ).get(p.barcode, p.locKey);

            if (existing) {
              // Update — barcode + lokasi sama
              db.prepare(`
                UPDATE products
                SET name=?, sku=?, category_id=?, price=?, unit=?,
                    warehouse_stock=?,
                    warehouse_min=?, warehouse_max=?,
                    default_location=?
                WHERE id=?
              `).run(
                p.name, p.sku, cat.id, p.price, p.unit,
                p.qty,
                p.minQty, p.maxQty,
                p.locKey,
                existing.id
              );
            } else {
              // Insert baru — barcode sama tapi lokasi beda itu boleh
              db.prepare(`
                INSERT INTO products
                  (name, category_id, sku, barcode, price, unit,
                   warehouse_stock, default_location,
                   warehouse_min, warehouse_max)
                VALUES (?,?,?,?,?,?,?,?,?,?)
              `).run(
                p.name, cat.id, p.sku, p.barcode, p.price, p.unit,
                p.qty,
                p.locKey,
                p.minQty, p.maxQty
              );
            }
            berhasil++;
          } catch (rowErr) {
            gagal.push({ barcode: p.barcode, name: p.name, error: rowErr.message });
          }
        }
        db.exec('COMMIT');
      } catch (txErr) {
        db.exec('ROLLBACK');
        throw txErr;
      }

      res.json({
        ok: true,
        total: berhasil,
        berhasil,
        dilewati,
        duplikat,
        gagal: gagal.length,
        errorDetail: gagal.slice(0, 20),
        info: `Import selesai: ${berhasil} entri diproses (beda lokasi = produk terpisah, barcode+lokasi sama = dilewati)`
      });


    } catch (err) {
      console.error('Import error:', err);
      res.status(500).json({ error: err.message });
    } finally {
      try { require('fs').unlinkSync(req.file.path); } catch(e) {}
    }
  }
);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));

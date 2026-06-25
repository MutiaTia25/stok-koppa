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
app.use(express.static(path.join(__dirname, 'public')));

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
addColumnIfMissing('products', 'display_min', 'INTEGER NOT NULL DEFAULT 5');
addColumnIfMissing('products', 'display_max', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('products', 'warehouse_stock', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('products', 'warehouse_min', 'INTEGER NOT NULL DEFAULT 5');
addColumnIfMissing('products', 'warehouse_max', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'full_name', 'TEXT');
addColumnIfMissing('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('users', 'created_at', `TEXT DEFAULT (datetime('now','localtime'))`);
addColumnIfMissing('stock_opname', 'location', `TEXT NOT NULL DEFAULT 'warehouse'`);
addColumnIfMissing('stock_opname','status',"TEXT DEFAULT 'pending'");
addColumnIfMissing('stock_opname','approved_by','TEXT');
addColumnIfMissing('stock_opname','approved_at','TEXT');
addColumnIfMissing('products', 'barcode', 'TEXT');
addColumnIfMissing('products','default_location',"TEXT NOT NULL DEFAULT 'office'");
addColumnIfMissing('products', 'unit', "TEXT DEFAULT 'PCS'");

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
        .run(r.stock || 0, r.min_stock || 5, r.id);
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
  ['Makanan','Minuman','Sembako','Kebersihan','Lainnya'].forEach(c =>
    db.prepare('INSERT INTO categories (name) VALUES (?)').run(c));
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
  p.total_stock = p.warehouse_stock + p.display_stock;
  p.warehouse_reorder_qty = p.warehouse_stock <= p.warehouse_min
    ? Math.max(0, p.warehouse_max - p.warehouse_stock)
    : 0;
  p.display_refill_qty = p.display_stock <= p.display_min
    ? Math.max(0, p.display_max - p.display_stock)
    : 0;
  return p;
}

// ===== PRODUCTS (CRUD) =====
app.get('/api/products', authMiddleware, (req, res) => {
  const { category_id, q } = req.query;
  let sql = `SELECT p.id, p.name, p.category_id, p.price, p.sku, p.barcode, p.default_location as location,
                    p.display_stock, p.display_min, p.display_max,
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
    display_stock,
    display_min,
    display_max,
    warehouse_stock,
    warehouse_min,
    warehouse_max
  } = req.body;

  if (!name || !category_id) return res.status(400).json({ error: 'Nama dan kategori wajib diisi' });

  if (barcode) {
    const dup = db.prepare('SELECT id FROM products WHERE barcode=?').get(barcode);
    if (dup) return res.status(400).json({ error: 'Barcode ini sudah dipakai produk lain' });
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
  display_stock,
  display_min,
  display_max,
  warehouse_stock,
  warehouse_min,
  warehouse_max
)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  name,
  category_id,
  price || 0,
  sku || '',
  barcode || '',
  unit || 'PCS',
  location || 'office',
  display_stock || 0,
  display_min || 5,
  display_max || 0,
  warehouse_stock || 0,
  warehouse_min || 5,
  warehouse_max || 0
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
  display_min,
  display_max,
  warehouse_min,
  warehouse_max
} = req.body;

  if (!name || !category_id) return res.status(400).json({ error: 'Nama dan kategori wajib diisi' });

  if (barcode) {
    const dup = db.prepare('SELECT id FROM products WHERE barcode=? AND id<>?').get(barcode, req.params.id);
    if (dup) return res.status(400).json({ error: 'Barcode ini sudah dipakai produk lain' });
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
display_min=?,
display_max=?,
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
  location || 'office',
  display_min || 5,
  display_max || 0,
  warehouse_min || 5,
  warehouse_max || 0,
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

// ===== STOCK IN / OUT (selalu di OFFICE) =====
// "Masuk" = barang diterima dari supplier ke gudang.
// "Keluar" = barang keluar dari gudang (misalnya rusak/hilang/retur ke supplier).
// Untuk memindahkan barang dari gudang ke rak pajangan (display), gunakan endpoint /api/transfer.
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
    return res.status(400).json({ error: 'Stok Office tidak cukup. Sisa stok Office: ' + prod.warehouse_stock });
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

// ===== TRANSFER STOK: OFFICE -> MESS (satu arah saja) =====
// Barang yang sudah dipindah ke Mess tidak dikembalikan ke Office.
// Jika barang di Mess rusak/expired, gunakan endpoint /api/disposal untuk memusnahkannya.
app.post('/api/transfer', authMiddleware, (req, res) => {
  const { product_id, qty, note } = req.body;
  if (!product_id || !qty || qty <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });

  const prod = db.prepare('SELECT warehouse_stock, display_stock FROM products WHERE id=?').get(product_id);
  if (!prod) return res.status(404).json({ error: 'Produk tidak ditemukan' });

  if (prod.warehouse_stock < qty) return res.status(400).json({ error: 'Stok Office tidak cukup. Sisa stok Office: ' + prod.warehouse_stock });
  db.prepare('UPDATE products SET warehouse_stock = warehouse_stock - ?, display_stock = display_stock + ? WHERE id=?').run(qty, qty, product_id);

  db.prepare('INSERT INTO stock_transfers (product_id, qty, direction, note, user) VALUES (?,?,?,?,?)')
    .run(product_id, qty, 'to_display', note || '', req.user.username);

  res.json({ ok: true });
});

// ===== PEMUSNAHAN STOK MESS (barang rusak / expired) =====
app.post('/api/disposal', authMiddleware, (req, res) => {
  const { product_id, qty, reason, note } = req.body;
  if (!product_id || !qty || qty <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });

  const prod = db.prepare('SELECT display_stock FROM products WHERE id=?').get(product_id);
  if (!prod) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  if (prod.display_stock < qty) return res.status(400).json({ error: 'Stok Mess tidak cukup. Sisa stok Mess: ' + prod.display_stock });

  db.prepare('UPDATE products SET display_stock = display_stock - ? WHERE id=?').run(qty, product_id);

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

app.get('/api/transfers', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT t.id, t.product_id, p.name as product_name, c.name as category_name,
                    t.qty, t.direction, t.note, t.user, t.created_at
             FROM stock_transfers t
             JOIN products p ON p.id = t.product_id
             JOIN categories c ON c.id = p.category_id
             WHERE 1=1`;
  const params = [];
  if (from) { sql += ` AND date(t.created_at) >= date(?)`; params.push(from); }
  if (to) { sql += ` AND date(t.created_at) <= date(?)`; params.push(to); }
  sql += ' ORDER BY t.id DESC LIMIT 200';
  res.json(db.prepare(sql).all(...params));
});

// ===== STOCK LOGS / HISTORY =====
app.get('/api/logs', authMiddleware, (req, res) => {
  const { from, to, type, product_id } = req.query;
  let sql = `SELECT l.*, p.name as product_name, c.name as category_name FROM stock_logs l
    JOIN products p ON p.id=l.product_id
    JOIN categories c ON c.id=p.category_id WHERE 1=1`;
  const params = [];
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
    SELECT p.id, p.name, c.name AS category_name, p.price,
           p.display_stock, p.display_min, p.display_max,
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
  const totalStock = db.prepare('SELECT COALESCE(SUM(display_stock + warehouse_stock),0) s FROM products').get().s;
  const totalValue = db.prepare('SELECT COALESCE(SUM((display_stock + warehouse_stock) * price),0) v FROM products').get().v;

  const byCategory = db.prepare(`
    SELECT c.name, COUNT(p.id) jumlah_produk,
           COALESCE(SUM(p.display_stock + p.warehouse_stock),0) total_stok,
           COALESCE(SUM((p.display_stock + p.warehouse_stock) * p.price),0) nilai_stok
    FROM categories c LEFT JOIN products p ON p.category_id=c.id
    GROUP BY c.id ORDER BY c.name
  `).all();

  const lowStockItems = db.prepare(`
  SELECT
    p.id,
    p.name,
    c.name as category_name,
    p.display_stock,
    p.display_min,
    p.display_max,
    p.warehouse_stock,
    p.warehouse_min,
    p.warehouse_max
  FROM products p
  JOIN categories c ON c.id = p.category_id

  WHERE
    p.warehouse_stock <= p.warehouse_min
    OR
    p.display_stock <= p.display_min

  ORDER BY p.name
  LIMIT 10
`).all().map(enrichProduct);

  const todayIn = db.prepare(`SELECT COALESCE(SUM(qty),0) s FROM stock_logs WHERE type='in' AND date(created_at)=date('now','localtime')`).get().s;
  const todayOut = db.prepare(`SELECT COALESCE(SUM(qty),0) s FROM stock_logs WHERE type='out' AND date(created_at)=date('now','localtime')`).get().s;
  console.log('LOW STOCK:', lowStockItems);

  res.json({ totalProducts, totalStock, totalValue, byCategory, lowStockItems, todayIn, todayOut });
});

// ===== LAPORAN FILTER =====
app.get('/api/report', authMiddleware, (req, res) => {
  const { from, to, type } = req.query;
  let sql = `
    SELECT l.id, l.created_at, p.name as product_name, c.name as category_name,
           l.type, l.qty, l.note, l.user
    FROM stock_logs l
    JOIN products p ON p.id = l.product_id
    JOIN categories c ON c.id = p.category_id
    WHERE 1=1
  `;
  const params = [];
  if (from) { sql += ` AND date(l.created_at) >= date(?)`; params.push(from); }
  if (to) { sql += ` AND date(l.created_at) <= date(?)`; params.push(to); }
  if (type && type !== 'all') { sql += ` AND l.type = ?`; params.push(type); }
  sql += ` ORDER BY l.created_at DESC`;

  const data = db.prepare(sql).all(...params);
  res.json(data);
});

// ===== LOW STOCK (total gudang+display <= total minimum) =====
app.get('/api/low-stock', authMiddleware, (req, res) => {
  const data = db.prepare(`
    SELECT id, name, display_stock, warehouse_stock,
           (display_stock + warehouse_stock) as total_stock,
           (display_min + warehouse_min) as total_min
    FROM products
    WHERE (display_stock + warehouse_stock) <= (display_min + warehouse_min)
    ORDER BY total_stock ASC
  `).all();
  res.json(data);
});

// ===== STOCK OPNAME =====
app.get('/api/opname/products', authMiddleware, (req, res) => {
  const data = db.prepare(`
    SELECT p.id, p.name, p.sku, p.barcode, p.unit, c.name as category_name,
           p.warehouse_stock, p.warehouse_min, p.warehouse_max,
           p.display_stock, p.display_min, p.display_max
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
  const product = db.prepare(`
    SELECT p.id, p.name, p.sku, p.barcode, c.name as category_name,
           p.warehouse_stock, p.display_stock
    FROM products p JOIN categories c ON c.id=p.category_id
    WHERE p.barcode = ?
  `).get(req.params.barcode);
  res.json({ found: !!product, product: product || null });
});

app.get('/api/opname', authMiddleware, (req, res) => {
  const { from, to, status } = req.query;
  let sql = `
    SELECT o.id, o.product_id, p.name as product_name, c.name as category_name,
           o.location, o.stock_system, o.stock_fisik, o.selisih, o.user, o.created_at,
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

app.post('/api/opname', authMiddleware, (req, res) => {
  let {
    product_id, stock_fisik_warehouse, stock_fisik_display, note,
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
    if (new_product_barcode) {
      const dup = db.prepare('SELECT id FROM products WHERE barcode=?').get(new_product_barcode);
      if (dup) return res.status(400).json({ error: 'Barcode ini sudah dipakai produk lain' });
    }
    const r = db.prepare(`
      INSERT INTO products (name, category_id, price, sku, barcode,default_location, display_stock, display_min, display_max, warehouse_stock, warehouse_min, warehouse_max)
      VALUES ( ?, ?, ?, ?, ?,'office', 0, 5, 0, 0, 5, 0 )
    `).run(new_product_name, new_product_category_id,new_product_price || 0, new_product_sku || '', new_product_barcode || '');
    product_id = r.lastInsertRowid;
  }

  if (
    stock_fisik_warehouse === undefined &&
    stock_fisik_display === undefined
){
    return res.status(400).json({
        error:'Isi minimal salah satu stok fisik'
    });
}

  const prod = db.prepare('SELECT warehouse_stock, display_stock FROM products WHERE id=?').get(product_id);
  if (!prod) return res.status(404).json({ error: 'Produk tidak ditemukan' });

  const results = [];

  function processLocation(loc, stock_fisik) {
    if (stock_fisik === undefined || stock_fisik === null) {
      throw new Error('Stok fisik wajib diisi');
    }
    if (stock_fisik < 0) throw new Error('Stok fisik tidak boleh negatif');

    const stock_system = loc === 'warehouse' ? prod.warehouse_stock : prod.display_stock;
    const selisih = stock_fisik - stock_system;
    const isAdmin = req.user.role === 'admin';
    // Kasir → pending (stok belum berubah, tunggu approve admin)
    // Admin → approved langsung, stok langsung berubah
    const status = isAdmin ? 'approved' : 'pending';

    db.prepare(`
      INSERT INTO stock_opname (product_id, location, stock_system, stock_fisik, selisih, user, status, approved_by, approved_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      product_id, loc, stock_system, stock_fisik, selisih,
      req.user.username, status,
      isAdmin ? req.user.username : null,
      isAdmin ? new Date().toISOString() : null
    );

    // Hanya update stok kalau admin (langsung) atau sudah di-approve
    if (isAdmin && selisih !== 0) {
      const column = loc === 'warehouse' ? 'warehouse_stock' : 'display_stock';
      db.prepare(`UPDATE products SET ${column}=? WHERE id=?`).run(stock_fisik, product_id);
      const adjType = selisih > 0 ? 'in' : 'out';
      const locLabel = loc === 'warehouse' ? 'Office' : 'Mess';
      db.prepare(`INSERT INTO stock_logs (product_id,type,qty,note,user) VALUES (?,?,?,?,?)`)
        .run(product_id, adjType, Math.abs(selisih), `[OPNAME] ${note || ''} Penyesuaian stok ${locLabel} (selisih ${selisih > 0 ? '+' : ''}${selisih})`, req.user.username);
    }

    results.push({ location: loc, stock_system, stock_fisik, selisih, status });
  }

  try {

    if(stock_fisik_warehouse !== undefined){
        processLocation(
            'warehouse',
            Number(stock_fisik_warehouse)
        );
    }

    if(stock_fisik_display !== undefined){
        processLocation(
            'display',
            Number(stock_fisik_display)
        );
    }

} catch(e){

    return res.status(400).json({
        error:e.message
    });

}

  res.json({ ok: true, product_id, results });
});

// ===== APPROVE OPNAME (ADMIN) =====
app.post('/api/opname/:id/approve', authMiddleware, adminOnly, (req, res) => {
  const opname = db.prepare('SELECT * FROM stock_opname WHERE id=?').get(req.params.id);
  if (!opname) return res.status(404).json({ error: 'Data opname tidak ditemukan' });
  if (opname.status === 'approved') return res.status(400).json({ error: 'Opname ini sudah di-approve' });

  const prod = db.prepare('SELECT warehouse_stock, display_stock FROM products WHERE id=?').get(opname.product_id);
  if (!prod) return res.status(404).json({ error: 'Produk tidak ditemukan' });

  // Update stok produk
  if (opname.selisih !== 0) {
    const column = opname.location === 'warehouse' ? 'warehouse_stock' : 'display_stock';
    db.prepare(`UPDATE products SET ${column}=? WHERE id=?`).run(opname.stock_fisik, opname.product_id);
    const adjType = opname.selisih > 0 ? 'in' : 'out';
    const locLabel = opname.location === 'warehouse' ? 'Office' : 'Mess';
    db.prepare(`INSERT INTO stock_logs (product_id,type,qty,note,user) VALUES (?,?,?,?,?)`)
      .run(opname.product_id, adjType, Math.abs(opname.selisih),
        `[OPNAME APPROVE] Disetujui oleh ${req.user.username}. Penyesuaian stok ${locLabel} (selisih ${opname.selisih > 0 ? '+' : ''}${opname.selisih})`,
        req.user.username);
  }

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
    SELECT p.barcode, p.name as product_name, o.location, o.stock_fisik, o.stock_system, o.selisih, o.user, o.created_at, o.status
    FROM stock_opname o
    JOIN products p ON p.id = o.product_id
    ${where}
    ORDER BY o.created_at DESC
  `).all(...params);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Stock Opname');
  sheet.columns = [
    { header: 'Barcode', key: 'barcode', width: 18 },
    { header: 'Nama Produk', key: 'product_name', width: 30 },
    { header: 'Lokasi', key: 'location', width: 10 },
    { header: 'Qty SO (Fisik)', key: 'stock_fisik', width: 14 },
    { header: 'Stok Sistem', key: 'stock_system', width: 14 },
    { header: 'Selisih', key: 'selisih', width: 10 },
    { header: 'Petugas', key: 'user', width: 15 },
    { header: 'Waktu', key: 'created_at', width: 20 },
    { header: 'Status', key: 'status', width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };
  rows.forEach(r => sheet.addRow({ ...r, location: r.location === 'warehouse' ? 'Office' : 'Mess' }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="stock-opname.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// ===== EXPORT TO EXCEL: DATA PRODUK =====
app.get('/api/export/products', authMiddleware, async (req, res) => {
  const products = db.prepare(`
    SELECT p.name, p.sku, c.name as category, p.price,
           p.warehouse_stock, p.display_stock,
           (p.warehouse_stock + p.display_stock) as total_stock,
           p.warehouse_min, p.display_min
    FROM products p JOIN categories c ON c.id=p.category_id ORDER BY c.name, p.name
  `).all();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data Produk');
  sheet.columns = [
    { header: 'Nama Produk', key: 'name', width: 30 },
    { header: 'SKU', key: 'sku', width: 15 },
    { header: 'Kategori', key: 'category', width: 18 },
    { header: 'Harga', key: 'price', width: 15 },
    { header: 'Stok Office', key: 'warehouse_stock', width: 14 },
    { header: 'Stok Mess', key: 'display_stock', width: 14 },
    { header: 'Total Stok', key: 'total_stock', width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };
  products.forEach(p => sheet.addRow(p));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="data-produk.xlsx"');
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

  let sql = `
    SELECT l.created_at, p.name as product_name, c.name as category_name, l.type, l.qty, l.note, l.user
    FROM stock_logs l
    JOIN products p ON p.id=l.product_id
    JOIN categories c ON c.id=p.category_id
    WHERE 1=1
  `;
  const params = [];
  if (from) { sql += ` AND date(l.created_at) >= date(?)`; params.push(from); }
  if (to) { sql += ` AND date(l.created_at) <= date(?)`; params.push(to); }
  if (type && type !== 'all') { sql += ` AND l.type=?`; params.push(type); }
  sql += ` ORDER BY l.id DESC`;

  const logs = db.prepare(sql).all(...params);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Laporan Stok');

  // ================= HEADER =================
  sheet.mergeCells('A1:F1');
  sheet.getCell('A1').value = 'LAPORAN STOK KOPPA MART';
  sheet.getCell('A1').font = { size: 20, bold: true, color: { argb: 'FFFFFF' } };
  sheet.getCell('A1').alignment = { horizontal: 'center' };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E78' } };

  sheet.getCell('A3').value = 'Periode';
  sheet.getCell('B3').value = `${from || '-'} s/d ${to || '-'}`;
  sheet.getCell('A4').value = 'Tanggal Cetak';
  sheet.getCell('B4').value = new Date().toLocaleString('id-ID');

  // ================= TABEL =================
  sheet.columns = [
    { header: 'Tanggal', key: 'created_at', width: 22 },
    { header: 'Produk', key: 'product_name', width: 30 },
    { header: 'Kategori', key: 'category_name', width: 20 },
    { header: 'Tipe', key: 'type', width: 18 },
    { header: 'Jumlah', key: 'qty', width: 12 },
    { header: 'Catatan', key: 'note', width: 30 },
  ];

  const headerRow = sheet.getRow(5);
  headerRow.height = 25;
  headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '4472C4' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

  // ================= DATA =================
  logs.forEach(item => {
    sheet.addRow({
      created_at: item.created_at,
      product_name: item.product_name,
      category_name: item.category_name,
      type: item.type === 'in' ? 'STOK MASUK' : 'STOK KELUAR',
      qty: item.qty,
      note: item.note || '-'
    });
  });

  // ================= STYLE =================
  sheet.eachRow((row, rowNumber) => {
    row.eachCell(cell => {
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' }
      };
    });
    if (rowNumber > 5) {
      const typeCell = row.getCell(4);
      if (typeCell.value === 'STOK MASUK') typeCell.font = { bold: true, color: { argb: '008000' } };
      if (typeCell.value === 'STOK KELUAR') typeCell.font = { bold: true, color: { argb: 'FF0000' } };
    }
  });

  sheet.views = [{ state: 'frozen', ySplit: 5 }];

  // ================= FOOTER =================
  const lastRow = sheet.lastRow.number + 2;
  sheet.getCell(`A${lastRow}`).value = `Total Transaksi : ${logs.length}`;
  sheet.getCell(`A${lastRow}`).font = { bold: true };
  sheet.getCell(`F${lastRow + 3}`).value = `Palembang, ${new Date().toLocaleDateString('id-ID')}`;
  sheet.getCell(`F${lastRow + 5}`).value = 'Administrator';
  sheet.getCell(`F${lastRow + 9}`).value = '(____________________)';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=laporan-stok.xlsx');
  await workbook.xlsx.write(res);
  res.end();
});

// ===== EXPORT PDF =====
app.get('/api/export/logs-pdf', authMiddleware, (req, res) => {
  const { from, to, type } = req.query;

  let sql = `
    SELECT l.created_at, p.name as product_name, c.name as category_name, l.type, l.qty, l.note, l.user
    FROM stock_logs l
    JOIN products p ON p.id=l.product_id
    JOIN categories c ON c.id=p.category_id
    WHERE 1=1
  `;
  const params = [];
  if (from) { sql += ` AND date(l.created_at) >= date(?)`; params.push(from); }
  if (to) { sql += ` AND date(l.created_at) <= date(?)`; params.push(to); }
  if (type && type !== 'all') { sql += ` AND l.type=?`; params.push(type); }
  sql += ` ORDER BY l.id DESC`;

  const logs = db.prepare(sql).all(...params);

  const doc = new PDFDocument({ margin: 30, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=laporan-stok.pdf');

  doc.pipe(res);

  doc.rect(0, 0, 700, 80).fill('#1F4E78');
  doc.fillColor('white').fontSize(22).text('LAPORAN TRANSAKSI STOK', 0, 30, { align: 'center' });
  doc.fillColor('black');
  doc.moveDown(4);

  doc.fontSize(11);
  doc.text(`Tanggal Cetak : ${new Date().toLocaleString('id-ID')}`);
  doc.text(`Periode : ${from || '-'} s/d ${to || '-'}`);
  doc.moveDown();

  let y = doc.y;
  doc.rect(30, y, 530, 20).fill('#4472C4');
  doc.fillColor('white').fontSize(10)
    .text('Tanggal', 35, y + 5)
    .text('Produk', 130, y + 5)
    .text('Tipe', 280, y + 5)
    .text('Qty', 350, y + 5)
    .text('User', 420, y + 5);

  y += 25;

  logs.forEach((item, index) => {
    if (index % 2 === 0) doc.rect(30, y - 2, 530, 18).fill('#F5F5F5');
    doc.fillColor('black');
    doc.fontSize(9).text(item.created_at, 35, y);
    doc.text(item.product_name, 130, y);
    doc.fillColor(item.type === 'in' ? 'green' : 'red');
    doc.text(item.type === 'in' ? 'MASUK' : 'KELUAR', 280, y);
    doc.fillColor('black');
    doc.text(item.qty.toString(), 350, y);
    doc.text(item.user || '-', 420, y);
    y += 20;
    if (y > 730) { doc.addPage(); y = 50; }
  });

  doc.moveDown(2);
  doc.fontSize(10).fillColor('gray').text(`Total Transaksi : ${logs.length}`, 30, y + 20);
  doc.fillColor('black');
  doc.text(`Palembang, ${new Date().toLocaleDateString('id-ID')}`, 380, y + 70);
  doc.text('Administrator', 420, y + 90);
  doc.text('(____________________)', 390, y + 150);

  doc.end();
});

app.post(
  '/api/import-opname',
  authMiddleware,
  upload.single('file'),
  async (req, res) => {

    if (!req.file) {
      return res.status(400).json({
        error: 'File Excel belum dipilih'
      });
    }

    const workbook = new ExcelJS.Workbook();

    await workbook.xlsx.readFile(req.file.path);

    const sheet = workbook.getWorksheet(1);

    let berhasil = 0;
    let gagal = [];

    sheet.eachRow((row, rowNumber) => {

      if (rowNumber === 1) return;

      const barcode = String(row.getCell(1).value || '').trim();
      const stokOffice = Number(row.getCell(3).value || 0);
      const stokMess = Number(row.getCell(4).value || 0);

      if (!barcode) return;

      const product = db.prepare(
        'SELECT * FROM products WHERE barcode=?'
      ).get(barcode);

      if (!product) {
        gagal.push(barcode);
        return;
      }

      db.prepare(`
        UPDATE products
        SET warehouse_stock=?,
            display_stock=?
        WHERE id=?
      `).run(
        stokOffice,
        stokMess,
        product.id
      );

      berhasil++;
    });

    res.json({
      ok: true,
      berhasil,
      gagal
    });
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
        // ExcelJS bisa return object {text, result} untuk formula cell
        if (typeof val === 'object' && val !== null) {
          val = val.result !== undefined ? val.result : (val.text || val.value || 0);
        }
        const s = String(val).trim();
        if (s === '' || s.startsWith('#')) return def;
        const n = parseFloat(s.replace(/,/g, ''));
        return isNaN(n) ? def : Math.round(n);
      }

      function safeStr(val) {
        if (val === null || val === undefined) return '';
        if (typeof val === 'object' && val !== null) {
          val = val.result !== undefined ? val.result : (val.text || val.richText?.[0]?.text || '');
        }
        return String(val).trim();
      }

      // TAHAP 1: baca semua baris
      // Key = barcode + '|' + lokasi → beda lokasi = produk terpisah, sama lokasi+barcode = duplikat
      const productMap = new Map();
      let duplikat = 0;

      sheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;

        const locationRaw  = safeStr(row.getCell(1).value);
        const barcode      = safeStr(row.getCell(2).value);
        const productText  = safeStr(row.getCell(3).value);
        const categoryName = (safeStr(row.getCell(4).value) || 'LAINNYA').toUpperCase();
        const qty          = safeNum(row.getCell(5).value, 0);
        const unit         = safeStr(row.getCell(6).value) || 'PCS';
        const price        = safeNum(row.getCell(7).value, 0);
        const minQty       = safeNum(row.getCell(8).value, 0);
        const maxQty       = safeNum(row.getCell(9).value, 0);

        if (!barcode && !productText) { dilewati++; return; }
        if (!barcode) { gagal.push({ rowNum, info: productText, error: 'Barcode kosong' }); return; }
        if (!productText) { gagal.push({ rowNum, barcode, error: 'Nama produk kosong' }); return; }

        let sku = '', name = productText;
        const m = productText.match(/^\[([^\]]+)\]\s*(.+)$/);
        if (m) { sku = m[1].trim(); name = m[2].trim(); }

        const isMess = locationRaw.toUpperCase().includes('MIPS');
        const locKey = isMess ? 'mess' : 'office';

        // Key unik = barcode + lokasi → beda lokasi = produk terpisah
        const mapKey = barcode + '|' + locKey;

        if (productMap.has(mapKey)) {
          // Barcode + lokasi sama → baris duplikat di Excel, gabung qty saja
          const e = productMap.get(mapKey);
          if (isMess) e.display_stock += qty;
          else        e.warehouse_stock += qty;
          duplikat++;
          return;
        }

        productMap.set(mapKey, {
          barcode, name, sku, categoryName, unit, price, minQty, maxQty,
          locKey,
          warehouse_stock: isMess ? 0 : qty,
          display_stock:   isMess ? qty : 0,
        });
      });

      // TAHAP 2: upsert ke DB
      // Barcode + lokasi sama → update; barcode sama tapi lokasi beda → insert baru
      let berhasil = 0;
      db.exec('BEGIN');
      try {
        for (const [mapKey, p] of productMap) {
          try {
            let cat = db.prepare('SELECT id FROM categories WHERE UPPER(name)=?').get(p.categoryName);
            if (!cat) {
              const display = p.categoryName.charAt(0) + p.categoryName.slice(1).toLowerCase();
              db.prepare('INSERT INTO categories (name) VALUES (?)').run(display);
              cat = db.prepare('SELECT id FROM categories WHERE UPPER(name)=?').get(p.categoryName);
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
                    warehouse_stock=?, display_stock=?,
                    warehouse_min=?, warehouse_max=?,
                    display_min=?, display_max=?
                WHERE id=?
              `).run(
                p.name, p.sku, cat.id, p.price, p.unit,
                p.warehouse_stock, p.display_stock,
                p.minQty, p.maxQty, p.minQty, p.maxQty,
                existing.id
              );
            } else {
              // Insert baru — barcode sama tapi lokasi beda itu boleh
              db.prepare(`
                INSERT INTO products
                  (name, category_id, sku, barcode, price, unit,
                   warehouse_stock, display_stock, default_location,
                   warehouse_min, warehouse_max, display_min, display_max)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
              `).run(
                p.name, cat.id, p.sku, p.barcode, p.price, p.unit,
                p.warehouse_stock, p.display_stock,
                p.locKey,
                p.minQty, p.maxQty, p.minQty, p.maxQty
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

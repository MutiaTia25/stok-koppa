const API = '/api';
let currentUser = null;
let authToken = null;
let categories = [];
let categoryChart = null;


// stockFlow() dihapus — logika scan sudah dihandle di setupStockScanListener()

// ===== UTIL =====
function toast(msg, type='success'){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  setTimeout(()=> el.className = 'toast', 2500);
}
function applyRoleUI(role){
  document.querySelectorAll('.admin-only')
    .forEach(el => {
      el.style.display = role === 'admin' ? '' : 'none';
    });
}
function formatRupiah(n){
  return 'Rp ' + Number(n||0).toLocaleString('id-ID');
}
async function api(path, method='GET', body=null){
  const opt = { method, headers: {'Content-Type':'application/json'} };
  if (authToken) opt.headers['Authorization'] = 'Bearer ' + authToken;
  if (body) opt.body = JSON.stringify(body);
  const res = await fetch(API + path, opt);
  if (res.status === 401) {
    logout();
    throw new Error('Sesi habis, silakan login kembali');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan');
  return data;
}
function closeModal(id){ document.getElementById(id).classList.remove('active'); }

async function downloadWithAuth(path, filename){
  const res = await fetch(API + path, { headers: { 'Authorization': 'Bearer ' + authToken } });
  if (!res.ok) { toast('Gagal mengunduh file', 'error'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

// ===== LOGIN =====
async function login(){
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    const data = await api('/login', 'POST', { username, password });
    authToken = data.token;
    currentUser = data.user;
    applyRoleUI(currentUser.role);
    localStorage.setItem('stok_token', authToken);
    localStorage.setItem('stok_user', JSON.stringify(currentUser));
    enterApp();
  } catch(e){
    errEl.textContent = e.message;
  }
}
function logout(){
  localStorage.removeItem('stok_token');
  localStorage.removeItem('stok_user');
  authToken = null;
  currentUser = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  applyRoleUI('admin');
}

function enterApp(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('userName').textContent = currentUser.full_name || currentUser.username;
  document.getElementById('userRole').textContent = currentUser.role === 'admin' ? 'Administrator' : 'Kasir';
  document.getElementById('userAvatar').textContent = (currentUser.full_name || currentUser.username).charAt(0).toUpperCase();
  applyRoleUI(currentUser.role);
  buildSidebar();
  showPage('dashboard');
}

// ===== SIDEBAR =====
function buildSidebar(){
  const menu = [
    { id:'dashboard', label:'Dashboard', icon:'📊', roles:['admin','kasir'] },
    { id:'products', label:'Data Produk', icon:'📦', roles:['admin','kasir'] },
    { id:'stock', label:'Stok Masuk/Keluar', icon:'🔁', roles:['admin','kasir'] },
    { id:'opname', label:'Stock Opname', icon:'📋', roles:['admin','kasir'] },
    { id:'reports', label:'Laporan', icon:'📑', roles:['admin'] },
    { id:'categories', label:'Kelola Kategori', icon:'🏷️', roles:['admin'] },
    { id:'users', label:'Manajemen Pengguna', icon:'👤', roles:['admin'] },
  ];
  const sidebar = document.getElementById('sidebarMenu');
  sidebar.innerHTML = '';

  // Group menu by section for visual clarity
  const sections = [
    { label: 'Utama', ids: ['dashboard'] },
    { label: 'Inventori', ids: ['products', 'stock', 'opname'] },
    { label: 'Laporan & Pengaturan', ids: ['reports', 'categories', 'users'] },
  ];

  sections.forEach(sec => {
    const sectionItems = menu.filter(m => sec.ids.includes(m.id) && m.roles.includes(currentUser.role));
    if (!sectionItems.length) return;

    const labelEl = document.createElement('div');
    labelEl.className = 'sidebar-label';
    labelEl.textContent = sec.label;
    sidebar.appendChild(labelEl);

    const sectionWrap = document.createElement('div');
    sectionWrap.className = 'sidebar-section';

    sectionItems.forEach(m => {
      const btn = document.createElement('button');
      btn.innerHTML = `<span class="sb-icon-wrap">${m.icon}</span> ${m.label}`;
      btn.id = 'menu-' + m.id;
      btn.onclick = () => showPage(m.id);
      sectionWrap.appendChild(btn);
    });

    sidebar.appendChild(sectionWrap);
  });
}

function showPage(id){
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sidebar button').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  const menuBtn = document.getElementById('menu-' + id);
  if (menuBtn) menuBtn.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' });
  const contentEl = document.querySelector('.content');
  if (contentEl) contentEl.scrollTop = 0;

  if (id === 'dashboard') loadDashboard();
  if (id === 'products') { loadCategories().then(()=>loadProducts()); }
  if (id === 'stock') { loadStockPage(); }
  if (id === 'categories') loadCategoriesPage();
  if (id === 'users') loadUsersPage();
  if (id === 'reports') loadReportPage();
  if (id === 'opname') loadOpnamePage();
}

// ===== DASHBOARD =====
async function loadDashboard(){
  const isAdmin = currentUser.role === 'admin';

  // ===== KASIR: welcome + 3 cards + chart kategori + produk perlu perhatian =====
  if (!isAdmin) {
    const sum = await api('/summary');
    document.getElementById('dashCards').innerHTML = `
      <div class="card" style="grid-column:1/-1; background:linear-gradient(135deg,#0c2d6b 0%,#1a56db 60%,#3b7ef8 100%); color:#fff; border:none; box-shadow:0 6px 20px rgba(26,86,219,.3);">
        <div style="font-size:28px; margin-bottom:6px;">👋</div>
        <div style="font-size:18px; font-weight:800; letter-spacing:-.2px;">Selamat datang, ${currentUser.full_name || currentUser.username}!</div>
        <div style="font-size:13px; opacity:.8; margin-top:3px; font-weight:500;">Kasir · KOPPA STOK</div>
      </div>
      <div class="card">
        <div class="icon-box icon-blue">📦</div>
        <div class="num">${sum.totalProducts}</div>
        <div class="label">Total Produk</div>
      </div>
      <div class="card">
        <div class="icon-box icon-green">📈</div>
        <div class="num">${sum.totalStock}</div>
        <div class="label">Total Unit Stok</div>
      </div>
    `;
    // Sembunyikan panel produk perlu perhatian untuk kasir
    const adminPanel = document.getElementById('dashAdminPanel');
    adminPanel.style.display = 'none';
    try {
      const ctx = document.getElementById('categoryChart');
      const labels = sum.byCategory.map(c => c.name);
      const data   = sum.byCategory.map(c => c.total_stok);
      if (categoryChart) categoryChart.destroy();
      categoryChart = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Total Stok', data, backgroundColor: '#3b82f6', borderRadius: 6 }] },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
      });
    } catch(e) {}
    return;
  }

  // ===== ADMIN: tampilan lengkap =====
  document.getElementById('dashAdminPanel').style.display = '';
  const sum = await api('/summary');
  const cardsEl = document.getElementById('dashCards');
  cardsEl.innerHTML = `
    <div class="card">
      <div class="icon-box icon-blue">📦</div>
      <div class="num">${sum.totalProducts}</div>
      <div class="label">Total Produk</div>
    </div>
    <div class="card">
      <div class="icon-box icon-green">📈</div>
      <div class="num">${sum.totalStock}</div>
      <div class="label">Total Unit Stok (Office+Mess)</div>
    </div>
    <div class="card">
      <div class="icon-box icon-orange">💰</div>
      <div class="num">${formatRupiah(sum.totalValue)}</div>
      <div class="label">Nilai Total Stok</div>
    </div>
    <div class="card">
      <div class="icon-box icon-red">⚠️</div>
      <div class="num" style="color:${sum.lowStockItems.length>0?'#dc2626':'#1e293b'}">${sum.lowStockItems.length}</div>
      <div class="label">Produk Perlu Perhatian</div>
    </div>
    <div class="card">
      <div class="icon-box icon-green">⬆️</div>
      <div class="num">${sum.todayIn}</div>
      <div class="label">Stok Masuk Hari Ini</div>
    </div>
    <div class="card">
      <div class="icon-box icon-red">⬇️</div>
      <div class="num">${sum.todayOut}</div>
      <div class="label">Stok Keluar Hari Ini</div>
    </div>
  `;

  const ctx = document.getElementById('categoryChart');
  const labels = sum.byCategory.map(c => c.name);
  const data = sum.byCategory.map(c => c.total_stok);
  if (categoryChart) categoryChart.destroy();
  categoryChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Total Stok', data, backgroundColor: '#3b82f6', borderRadius: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });

  const tbody = document.getElementById('lowStockTable');
  tbody.innerHTML = sum.lowStockItems.map(p => {
    let saran = [];
    if (p.warehouse_reorder_qty > 0) saran.push(`Order gudang +${p.warehouse_reorder_qty}`);
    if (p.display_refill_qty > 0) saran.push(`Isi display +${p.display_refill_qty}`);
    return `
    <tr>
      <td>${p.name}</td>
      <td class="${p.warehouse_stock <= p.warehouse_min ? 'stock-low' : ''}">${p.warehouse_stock}</td>
      <td class="${p.display_stock <= p.display_min ? 'stock-low' : ''}">${p.display_stock}</td>
      <td>${saran.length ? `<span style="color:#dc2626; font-weight:600; font-size:12px;">${saran.join('<br>')}</span>` : '-'}</td>
    </tr>
  `;
  }).join('') || '<tr><td colspan="4" class="empty">✅ Semua stok aman</td></tr>';
}

// ===== CATEGORIES =====
async function loadCategories(){
  categories = await api('/categories');
  // Filter dropdown di halaman Data Produk
  const filterSel = document.getElementById('filterCategory');
  if (filterSel) {
    filterSel.innerHTML = '<option value="">Semua Kategori</option>' +
      categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }
  // Dropdown kategori di modal tambah/edit produk (hanya nama kategori, bukan harga)
  const prodSel = document.getElementById('productCategory');
  if (prodSel) {
    prodSel.innerHTML = categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }
}

async function loadCategoriesPage(){
  categories = await api('/categories');
  const tbody = document.getElementById('categoriesTable');
  tbody.innerHTML = categories.map(c => `
    <tr>
      <td>${c.name}</td>
      <td>
        <button class="btn btn-sm btn-gray" onclick="editCategory(${c.id}, '${c.name.replace(/'/g,"\\'")}')">Edit</button>
        <button class="btn btn-sm btn-red" onclick="deleteCategory(${c.id})">Hapus</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="2" class="empty">Belum ada kategori</td></tr>';
}

async function addCategory(){
  const name = document.getElementById('newCategoryName').value.trim();
  if (!name) return toast('Nama kategori wajib diisi', 'error');
  try {
    await api('/categories', 'POST', { name });
    document.getElementById('newCategoryName').value = '';
    toast('Kategori ditambahkan');
    loadCategoriesPage();
  } catch(e){ toast(e.message, 'error'); }
}

async function editCategory(id, oldName){
  const name = prompt('Ubah nama kategori:', oldName);
  if (!name || name === oldName) return;
  try {
    await api('/categories/' + id, 'PUT', { name });
    toast('Kategori diperbarui');
    loadCategoriesPage();
  } catch(e){ toast(e.message, 'error'); }
}

async function deleteCategory(id){
  if (!confirm('Hapus kategori ini?')) return;
  try {
    await api('/categories/' + id, 'DELETE');
    toast('Kategori dihapus');
    loadCategoriesPage();
  } catch(e){ toast(e.message, 'error'); }
}

// ===== PRODUCTS =====
async function loadProducts(){
  const isAdmin = currentUser.role === 'admin';

  // Sembunyikan/tampilkan elemen admin
  const adminActions = document.getElementById('productAdminActions');
  const bulkBar      = document.getElementById('bulkDeleteBar');
  const thCheckbox   = document.getElementById('thCheckbox');
  const thAksi       = document.getElementById('thAksi');
  if (adminActions) adminActions.style.display = isAdmin ? '' : 'none';
  if (bulkBar && !isAdmin) bulkBar.style.display = 'none';
  if (thCheckbox) thCheckbox.style.display = isAdmin ? '' : 'none';
  if (thAksi) thAksi.textContent = isAdmin ? 'Aksi' : '';
  // Kasir: sembunyikan kolom stok & lokasi
  const kasirHideCols = ['thLokasi','thOffice','thMess','thSatuan','thMin','thMax'];
  kasirHideCols.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isAdmin ? '' : 'none';
  });

  const q = document.getElementById('searchProduct').value.trim();
  const cat = document.getElementById('filterCategory').value;
  let url = '/products?';
  if (q) url += 'q=' + encodeURIComponent(q) + '&';
  if (cat) url += 'category_id=' + cat;
  const products = await api(url);
  const tbody = document.getElementById('productsTable');
  tbody.innerHTML = products.map(p => {
    const locationLabel = p.location === 'mess' ? 'MIPL / Mess' : 'MIOF / Gudang';
    const productLabel  = p.sku ? `[${p.sku}] ${p.name}` : p.name;
    const totalQty      = p.warehouse_stock + p.display_stock;

    if (!isAdmin) {
      // Kasir: hanya tampil Barcode, Nama Produk, Kategori, Harga
      return `
      <tr>
        <td>${p.barcode || '-'}</td>
        <td>${productLabel}</td>
        <td>${p.category_name}</td>
        <td>${formatRupiah(p.price)}</td>
      </tr>`;
    }

    // Admin: dengan checkbox dan tombol aksi
    return `
    <tr>
      <td><input type="checkbox" class="product-checkbox" value="${p.id}" onchange="onProductCheckboxChange()"></td>
      <td>${locationLabel}</td>
      <td>${p.barcode || '-'}</td>
      <td>${productLabel}</td>
      <td>${p.category_name}</td>
      <td>${p.warehouse_stock}</td>
      <td>${p.display_stock}</td>
      <td>${p.unit || 'PCS'}</td>
      <td>${formatRupiah(p.price)}</td>
      <td>${p.warehouse_min}</td>
      <td>${p.warehouse_max}</td>
      <td>
        <button class="btn btn-sm btn-gray" onclick='openProductModal(${JSON.stringify(p)})'>Edit</button>
        <button class="btn btn-sm btn-red" onclick="deleteProduct(${p.id})">Hapus</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="${isAdmin ? 12 : 4}" class="empty">Belum ada produk</td></tr>`;

  // Reset select all
  const selectAll = document.getElementById('selectAllProducts');
  if (selectAll) selectAll.checked = false;
  updateBulkDeleteBar();
}

function toggleSelectAllProducts(cb){
  document.querySelectorAll('.product-checkbox').forEach(c => c.checked = cb.checked);
  updateBulkDeleteBar();
}

function onProductCheckboxChange(){
  const all = document.querySelectorAll('.product-checkbox');
  const checked = document.querySelectorAll('.product-checkbox:checked');
  const selectAll = document.getElementById('selectAllProducts');
  if (selectAll) selectAll.checked = all.length > 0 && checked.length === all.length;
  updateBulkDeleteBar();
}

function updateBulkDeleteBar(){
  const checked = document.querySelectorAll('.product-checkbox:checked');
  const bar = document.getElementById('bulkDeleteBar');
  const label = document.getElementById('bulkCountLabel');
  if (checked.length > 0){
    bar.style.display = 'flex';
    label.textContent = `${checked.length} produk dipilih`;
  } else {
    bar.style.display = 'none';
  }
}

function clearProductSelection(){
  document.querySelectorAll('.product-checkbox').forEach(c => c.checked = false);
  const selectAll = document.getElementById('selectAllProducts');
  if (selectAll) selectAll.checked = false;
  updateBulkDeleteBar();
}

async function bulkDeleteProducts(){
  const checked = document.querySelectorAll('.product-checkbox:checked');
  const ids = Array.from(checked).map(c => Number(c.value));
  if (ids.length === 0) return;
  if (!confirm(`Hapus ${ids.length} produk yang dipilih? Seluruh riwayat terkait juga akan terhapus.`)) return;
  try {
    await api('/products/bulk-delete', 'POST', { ids });
    toast(`${ids.length} produk berhasil dihapus`);
    loadProducts();
  } catch(e){ toast(e.message, 'error'); }
}

function openProductModal(product=null){
  document.getElementById('productModalTitle').textContent = product ? 'Edit Produk' : 'Tambah Produk';
  document.getElementById('productId').value = product ? product.id : '';
  document.getElementById('productName').value = product ? product.name : '';
  document.getElementById('productCategory').value = product ? product.category_id : (categories[0]?.id || '');
  document.getElementById('barcode').value = product ? (product.barcode || '') : '';
  document.getElementById('productSku').value = product ? (product.sku || '') : '';
  document.getElementById('productPrice').value = product ? product.price : 0;
  document.getElementById('productUnit').value = product ? (product.unit || 'PCS') : 'PCS';

  // Min & Max: Office dan Mess selalu sama (sesuai Excel)
  const minVal = product ? product.warehouse_min : 5;
  const maxVal = product ? (product.warehouse_max || 0) : 0;
  document.getElementById('productWarehouseMin').value = minVal;
  document.getElementById('productWarehouseMax').value = maxVal;
  document.getElementById('productMessMin').value = minVal;
  document.getElementById('productMessMax').value = maxVal;

  const wStockInput = document.getElementById('productWarehouseStock');
  const dStockInput = document.getElementById('productMessStock');
  const wLabel = document.getElementById('warehouseStockLabel');
  const dLabel = document.getElementById('displayStockLabel');

  if (product){
    wStockInput.value = product.warehouse_stock;
    wStockInput.disabled = true;
    wLabel.textContent = 'Stok Office Saat Ini (ubah di menu Stok Masuk/Keluar)';
    dStockInput.value = product.display_stock;
    dStockInput.disabled = true;
    dLabel.textContent = 'Stok Mess Saat Ini (ubah via Transfer Stok)';
  } else {
    wStockInput.value = 0;
    wStockInput.disabled = false;
    wLabel.textContent = 'Stok Office Awal';
    dStockInput.value = 0;
    dStockInput.disabled = false;
    dLabel.textContent = 'Stok Mess Awal';
  }
  // Set lokasi default sesuai data produk
  // Normalize: DB bisa kirim 'office'/'warehouse'→office atau 'mess'/'display'→mess
  let locVal = 'office';
  if (product && product.location) {
    const l = product.location.toLowerCase();
    locVal = (l === 'mess' || l === 'display' || l.includes('mipl') || l.includes('mips')) ? 'mess' : 'office';
  }
  document.getElementById('location').value = locVal;

  document.getElementById('productModalOverlay').classList.add('active');
}

async function saveProduct(){
  const id = document.getElementById('productId').value;
  const name = document.getElementById('productName').value.trim();
  const category_id = document.getElementById('productCategory').value;
  const sku = document.getElementById('productSku').value.trim();
  const barcode = document.getElementById('barcode').value.trim();
  const location = document.getElementById('location').value;
  const price = parseInt(document.getElementById('productPrice').value) || 0;
  const unit = document.getElementById('productUnit').value.trim() || 'PCS';

  const warehouse_stock = parseInt(document.getElementById('productWarehouseStock').value) || 0;
  const warehouse_min = parseInt(document.getElementById('productWarehouseMin').value) || 0;
  const warehouse_max = parseInt(document.getElementById('productWarehouseMax').value) || 0;
  const display_stock = parseInt(document.getElementById('productMessStock').value) || 0;
  // Office dan Mess min/max selalu sama
  const display_min = warehouse_min;
  const display_max = warehouse_max;

  if (!name || !category_id) return toast('Nama dan kategori wajib diisi', 'error');
  if (warehouse_max > 0 && warehouse_max < warehouse_min) return toast('Stok maksimum harus lebih besar dari minimum', 'error');

  try {
    if (id) {
      await api('/products/' + id, 'PUT', {
        name, category_id, price, sku, barcode, location, unit,
        warehouse_min, warehouse_max, display_min, display_max
      });
      toast('Produk diperbarui');
    } else {
      await api('/products', 'POST', {
        name, category_id, price, sku, barcode, location, unit,
        warehouse_stock, warehouse_min, warehouse_max,
        display_stock, display_min, display_max
      });
      toast('Produk ditambahkan');
    }
    closeModal('productModalOverlay');
    loadProducts();
  } catch(e){ toast(e.message, 'error'); }
}

async function deleteProduct(id){
  if (!confirm('Hapus produk ini? Seluruh riwayat terkait (stok, transfer, opname) juga akan terhapus.')) return;
  try {
    await api('/products/' + id, 'DELETE');
    toast('Produk dihapus');
    loadProducts();
  } catch(e){ toast(e.message, 'error'); }
}

function exportProducts(){
  downloadWithAuth('/export/products', 'data-produk.xlsx');
}
async function importExcel(file){
  if(!file) return;
  const formData = new FormData();
  formData.append('file', file);
  // Reset input supaya file yang sama bisa diimport ulang
  document.getElementById('excelImport').value = '';
  try {
    const res = await fetch(API + '/products/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + authToken },
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    let msg = `✅ ${data.berhasil} produk unik berhasil diimport`;
    if (data.dilewati > 0) msg += ` · ${data.dilewati} baris kosong dilewati`;
    if (data.gagal > 0)    msg += ` · ⚠️ ${data.gagal} gagal`;
    // Tampilkan info duplikat supaya user tidak bingung hitungan berbeda dengan Excel
    if (data.info) console.info('[Import]', data.info);
    toast(msg, data.gagal > 0 ? 'warn' : 'success');

    // Tampilkan alert jika ada error detail
    if (data.errorDetail && data.errorDetail.length > 0) {
      console.warn('Baris gagal:', data.errorDetail);
    }
    // Catatan: jumlah produk bisa lebih sedikit dari baris Excel karena barcode duplikat digabung
    if (data.berhasil > 0) {
      setTimeout(() => toast(`ℹ️ Barcode duplikat di Excel digabung otomatis (normal)`, 'success'), 3000);
    }
    loadProducts();
    loadCategories();
  } catch(err) {
    toast(err.message, 'error');
  }
}
// ===== STOCK IN/OUT (GUDANG) =====
// Cache produk untuk stok masuk/keluar
let stockProducts = [];
let stockSelectedProduct = null;

async function loadStockPage(){
  await loadCategories();
  stockProducts = await api('/products');

  // Isi hidden select (untuk kompatibilitas submitStock lama)
  const sel = document.getElementById('stockProductSelect');
  if (sel) sel.innerHTML = stockProducts.map(p =>
    `<option value="${p.id}" data-barcode="${p.barcode || ''}">${p.name}</option>`
  ).join('');

  // Reset form ke kondisi awal (tanpa clear listener — listener tetap aktif)
  stockSelectedProduct = null;
  const scanInputReset = document.getElementById('scanBarcode');
  if (scanInputReset) { scanInputReset.value = ''; }
  hideStockSearch();
  const formElReset = document.getElementById('stockInlineForm');
  if (formElReset) { formElReset.style.display = 'none'; formElReset.innerHTML = ''; }

  // Setup scan listener (flag mencegah duplikat attachment)
  setupStockScanListener();

  // Transfer — isi hidden select (kompatibilitas) + setup listener baru
  transferProducts = stockProducts;
  const transferSel = document.getElementById('transferProductSelect');
  if (transferSel) {
    transferSel.innerHTML = stockProducts.map(p =>
      `<option value="${p.id}">${p.name} - ${p.category_name}</option>`
    ).join('');
  }

  // Reset form transfer ke kondisi awal
  resetTransferForm();

  loadLogs();
  loadTransferHistory();
  setupTransferScanListener();
}

function setupStockScanListener(){
  const scanInput = document.getElementById('scanBarcode');
  if (!scanInput) return;

  // Gunakan flag dataset — jangan clone node (cloneNode memutus referensi DOM aktif)
  if (scanInput.dataset.stockListenerAdded === 'true') return;
  scanInput.dataset.stockListenerAdded = 'true';

  let debounce = null;
  let lastStockInputTime = 0;

  scanInput.addEventListener('input', () => {
    const val = scanInput.value.trim();
    if (!val) { hideStockSearch(); return; }

    const now = Date.now();
    const diff = now - lastStockInputTime;
    lastStockInputTime = now;

    clearTimeout(debounce);

    if (diff < 50) {
      // Scanner fisik — karakter masuk sangat cepat, tunggu selesai lalu exact match
      debounce = setTimeout(() => {
        const finalVal = scanInput.value.trim();
        const exact = stockProducts.find(p => String(p.barcode || '').trim() === finalVal);
        if (exact) pilihProdukStock(exact);
        else showStockSearch(finalVal);
      }, 150);
    } else {
      // Ketik manual — live search
      debounce = setTimeout(() => showStockSearch(scanInput.value.trim()), 300);
    }
  });

  scanInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounce);
      const val = scanInput.value.trim();
      if (!val) return;
      const exact = stockProducts.find(p => String(p.barcode || '').trim() === val);
      if (exact) {
        pilihProdukStock(exact);
      } else {
        showStockSearch(val);
        setTimeout(() => {
          const items = document.querySelectorAll('#stockSearchResults .stock-search-item');
          if (items.length === 1) items[0].click();
        }, 300);
      }
    }
    if (e.key === 'Escape') resetStockForm();
  });

  document.addEventListener('click', (e) => {
    const drop = document.getElementById('stockSearchResults');
    if (drop && !drop.contains(e.target) && e.target !== scanInput) hideStockSearch();
  });
}

function showStockSearch(query){
  const q = query.toLowerCase().trim();
  const results = stockProducts.filter(p =>
    p.name.toLowerCase().includes(q) ||
    String(p.barcode || '').includes(q) ||
    String(p.sku || '').toLowerCase().includes(q)
  ).slice(0, 10);

  const drop = document.getElementById('stockSearchResults');
  if (!drop) return;

  if (results.length === 0) {
    drop.style.display = 'block';
    drop.innerHTML = `<div style="padding:14px; color:#94a3b8; font-size:13px;">❌ Produk tidak ditemukan untuk "<b>${query}</b>"</div>`;
    return;
  }

  drop.style.display = 'block';
  drop.innerHTML = results.map(p => `
    <div class="stock-search-item"
      onclick="pilihProdukStock(${JSON.stringify(p).replace(/"/g,'&quot;')})"
      style="padding:11px 14px; cursor:pointer; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center;"
      onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''">
      <div>
        <div style="font-weight:600; font-size:13px; color:#1e293b;">${p.name}</div>
        <div style="font-size:11px; color:#94a3b8; margin-top:2px;">
          Barcode: ${p.barcode || '-'} &nbsp;|&nbsp; SKU: ${p.sku || '-'} &nbsp;|&nbsp; ${p.category_name}
        </div>
      </div>
      <div style="font-size:12px; color:#64748b; text-align:right; white-space:nowrap; margin-left:12px;">
        Office: <b>${p.warehouse_stock}</b><br>Mess: <b>${p.display_stock}</b>
      </div>
    </div>
  `).join('');
}

function hideStockSearch(){
  const drop = document.getElementById('stockSearchResults');
  if (drop) { drop.style.display = 'none'; drop.innerHTML = ''; }
}

function pilihProdukStock(product){
  if (typeof product === 'string') product = JSON.parse(product);
  stockSelectedProduct = product;

  // Isi input scan dengan nama produk
  const scanInput = document.getElementById('scanBarcode');
  if (scanInput) scanInput.value = product.name;
  hideStockSearch();

  // Set hidden select supaya submitStock() tetap jalan
  const sel = document.getElementById('stockProductSelect');
  if (sel) sel.value = product.id;

  // Render form inline
  renderStockForm(product);

  // Delay lebih panjang — innerHTML perlu waktu render sebelum bisa di-focus
  setTimeout(() => {
    const qty = document.getElementById('stockQty');
    if (qty) qty.focus();
    else {
      // Fallback: coba lagi 200ms kemudian
      setTimeout(() => {
        const qty2 = document.getElementById('stockQty');
        if (qty2) qty2.focus();
      }, 200);
    }
  }, 150);
  if (typeof playBeep === 'function') playBeep();
}

function renderStockForm(product){
  const formEl = document.getElementById('stockInlineForm');
  if (!formEl) return;

  const today = new Date().toISOString().split('T')[0];
  formEl.style.display = 'block';
  const _isAdminStock = currentUser.role === 'admin';
  formEl.innerHTML = `
    <div style="margin-top:12px; padding:14px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">
      <div style="font-weight:700; font-size:15px; color:#1e293b; margin-bottom:4px;">📦 ${product.name}</div>
      <div style="font-size:12px; color:#64748b; margin-bottom:12px;">
        Barcode: ${product.barcode || '-'} &nbsp;|&nbsp; SKU: ${product.sku || '-'} &nbsp;|&nbsp; Satuan: ${product.unit || 'PCS'}
      </div>
      ${_isAdminStock ? `
      <div style="display:flex; gap:10px; margin-bottom:12px; flex-wrap:wrap;">
        <div style="flex:1; min-width:120px; background:#dbeafe; border-radius:8px; padding:10px 14px; text-align:center;">
          <div style="font-size:11px; color:#1d4ed8; font-weight:600;">STOK OFFICE (Sistem)</div>
          <div style="font-size:22px; font-weight:800; color:#1e3a8a;">${product.warehouse_stock}</div>
        </div>
        <div style="flex:1; min-width:120px; background:#dcfce7; border-radius:8px; padding:10px 14px; text-align:center;">
          <div style="font-size:11px; color:#16a34a; font-weight:600;">STOK MESS (Sistem)</div>
          <div style="font-size:22px; font-weight:800; color:#15803d;">${product.display_stock}</div>
        </div>
      </div>` : ``}
      <div style="display:flex; gap:10px; margin-bottom:10px; flex-wrap:wrap; align-items:flex-end;">
        <div>
          <label style="font-size:12px; font-weight:600; color:#475569; display:block; margin-bottom:4px;">Tanggal</label>
          <input type="date" id="stockDate" value="${today}" style="padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:14px;">
        </div>
        <div style="flex:1; min-width:100px;">
          <label style="font-size:12px; font-weight:600; color:#475569; display:block; margin-bottom:4px;">Jumlah</label>
          <input type="number" id="stockQty" min="1" placeholder="0"
            style="width:100%; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:18px; font-weight:700; text-align:center;">
        </div>
        <div style="flex:2; min-width:180px;">
          <label style="font-size:12px; font-weight:600; color:#475569; display:block; margin-bottom:4px;">Catatan (opsional)</label>
          <input type="text" id="stockNote" placeholder="Catatan..."
            style="width:100%; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:14px;">
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button id="btnSubmitStock" class="btn btn-green" onclick="submitStock('in')" style="flex:1; min-width:140px;">⬆️ Barang Masuk</button>
        ${_isAdminStock ? `<button class="btn btn-red" onclick="submitStock('out')" style="flex:1; min-width:140px;">⬇️ Barang Keluar</button>` : ``}
        <button class="btn btn-gray" onclick="resetStockForm()" style="min-width:80px;">✕ Ganti</button>
      </div>
    </div>
  `;
}

function resetStockForm(){
  stockSelectedProduct = null;
  const scanInput = document.getElementById('scanBarcode');
  if (scanInput) { scanInput.value = ''; scanInput.focus(); }
  hideStockSearch();
  const formEl = document.getElementById('stockInlineForm');
  if (formEl) { formEl.style.display = 'none'; formEl.innerHTML = ''; }
  // Jangan reset flag stockListenerAdded — listener tetap aktif, tidak perlu re-attach
}

document.addEventListener('DOMContentLoaded', () => {
  // Tutup dropdown opname search kalau klik di luar
  document.addEventListener('click', (e) => {
    const container = document.getElementById('opnameSearchResults');
    const input = document.getElementById('scanBarcodeOpname');
    if (container && input && !container.contains(e.target) && e.target !== input) {
      hideOpnameSearch();
    }
  });

  // scanBarcode listener sekarang dihandle di setupStockScanListener() saat loadStockPage()

});

async function submitStock(type){
  
  const product_id = document.getElementById('stockProductSelect').value;
  const qty = parseInt(document.getElementById('stockQty').value);
  const note = document.getElementById('stockNote').value.trim();
  const dateInput = document.getElementById('stockDate').value;
  if (!product_id) return toast('Pilih produk terlebih dahulu', 'error');
  if (!qty || qty <= 0) return toast('Jumlah harus lebih dari 0', 'error');

  let date = null;
  if (dateInput) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    date = `${dateInput} ${hh}:${mm}:${ss}`;
  }

  try {
    await api('/stock/' + type, 'POST', { product_id, qty, note, date });
    toast(type === 'in' ? 'Stok gudang berhasil ditambahkan' : 'Stok gudang berhasil dikurangi');
    document.getElementById('stockQty').value = '';
    document.getElementById('stockNote').value = '';
    document.getElementById('stockDate').value = '';
    await loadStockPage();
  } catch(e){ toast(e.message, 'error'); }
}

async function loadLogs(){
  const from = document.getElementById('logFrom').value;
  const to = document.getElementById('logTo').value;
  const type = document.getElementById('logType').value;
  let url = '/logs?';
  if (from) url += 'from=' + from + '&';
  if (to) url += 'to=' + to + '&';
  if (type) url += 'type=' + type;
  const logs = await api(url);
  const tbody = document.getElementById('logsTable');
  tbody.innerHTML = logs.map(l => `
    <tr>
      <td>${l.created_at}</td>
      <td>${l.product_name}</td>
      <td>${l.category_name}</td>
      <td class="type-${l.type}">${l.type === 'in' ? 'MASUK' : 'KELUAR'}</td>
      <td>${l.qty}</td>
      <td>${l.note || '-'}</td>
      <td>${l.user || '-'}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">Belum ada riwayat</td></tr>';
}

// ===== TRANSFER STOK GUDANG <-> DISPLAY =====
let transferProducts = [];

// ===== TRANSFER: variabel state =====
let transferSelectedProduct = null;

function setupTransferScanListener(){
  const scanInput = document.getElementById('transferScanInput');
  if (!scanInput || scanInput.dataset.transferListenerAdded) return;

  let debounce = null;
  let lastInputTime = 0;

  scanInput.addEventListener('input', () => {
    const val = scanInput.value.trim();
    if (!val) { hideTransferSearch(); return; }
    const now = Date.now();
    const diff = now - lastInputTime;
    lastInputTime = now;
    clearTimeout(debounce);

    if (diff < 50) {
      // Scanner fisik — tunggu selesai lalu cari exact barcode
      debounce = setTimeout(() => {
        const finalVal = scanInput.value.trim();
        const exact = transferProducts.find(p => String(p.barcode || '').trim() === finalVal);
        if (exact) pilihProdukTransfer(exact);
        else showTransferSearch(finalVal);
      }, 150);
    } else {
      // Ketik manual — live search
      debounce = setTimeout(() => showTransferSearch(val), 300);
    }
  });

  scanInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounce);
      const val = scanInput.value.trim();
      if (!val) return;
      const exact = transferProducts.find(p => String(p.barcode || '').trim() === val);
      if (exact) {
        pilihProdukTransfer(exact);
      } else {
        showTransferSearch(val);
        setTimeout(() => {
          const items = document.querySelectorAll('#transferSearchResults .transfer-search-item');
          if (items.length === 1) items[0].click();
        }, 300);
      }
    }
    if (e.key === 'Escape') resetTransferForm();
  });

  document.addEventListener('click', (e) => {
    const drop = document.getElementById('transferSearchResults');
    const input = document.getElementById('transferScanInput');
    if (drop && !drop.contains(e.target) && e.target !== input) hideTransferSearch();
  });

  scanInput.dataset.transferListenerAdded = 'true';
}

function showTransferSearch(query){
  const q = query.toLowerCase().trim();
  const results = transferProducts.filter(p =>
    p.name.toLowerCase().includes(q) ||
    String(p.barcode || '').includes(q) ||
    String(p.sku || '').toLowerCase().includes(q)
  ).slice(0, 10);

  const drop = document.getElementById('transferSearchResults');
  if (!drop) return;

  if (results.length === 0) {
    drop.style.display = 'block';
    drop.innerHTML = `<div style="padding:14px; color:#94a3b8; font-size:13px;">❌ Produk tidak ditemukan untuk "<b>${query}</b>"</div>`;
    return;
  }

  drop.style.display = 'block';
  drop.innerHTML = results.map(p => `
    <div class="transfer-search-item"
      onclick="pilihProdukTransfer(${JSON.stringify(p).replace(/"/g,'&quot;')})"
      style="padding:11px 14px; cursor:pointer; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center;"
      onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''">
      <div>
        <div style="font-weight:600; font-size:13px; color:#1e293b;">${p.name}</div>
        <div style="font-size:11px; color:#94a3b8; margin-top:2px;">
          Barcode: ${p.barcode || '-'} &nbsp;|&nbsp; SKU: ${p.sku || '-'} &nbsp;|&nbsp; ${p.category_name}
        </div>
      </div>
      <div style="font-size:12px; color:#64748b; text-align:right; white-space:nowrap; margin-left:12px;">
        Office: <b>${p.warehouse_stock}</b><br>Mess: <b>${p.display_stock}</b>
      </div>
    </div>
  `).join('');
}

function hideTransferSearch(){
  const drop = document.getElementById('transferSearchResults');
  if (drop) { drop.style.display = 'none'; drop.innerHTML = ''; }
}

function pilihProdukTransfer(product){
  if (typeof product === 'string') product = JSON.parse(product);
  transferSelectedProduct = product;

  // Isi input dengan nama produk
  const scanInput = document.getElementById('transferScanInput');
  if (scanInput) scanInput.value = product.name;
  hideTransferSearch();

  // Set hidden select supaya submitTransfer tetap bisa baca product_id
  const sel = document.getElementById('transferProductSelect');
  if (sel) sel.value = product.id;

  // Render form inline
  renderTransferForm(product);

  setTimeout(() => {
    const qty = document.getElementById('transferQty');
    if (qty) qty.focus();
  }, 100);
  if (typeof playBeep === 'function') playBeep();
}

function renderTransferForm(product){
  const formEl = document.getElementById('transferInlineForm');
  if (!formEl) return;

  formEl.style.display = 'block';
  formEl.innerHTML = `
    <div style="margin-top:12px; padding:14px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">
      <div style="font-weight:700; font-size:15px; color:#1e293b; margin-bottom:4px;">🛒 ${product.name}</div>
      <div style="font-size:12px; color:#64748b; margin-bottom:12px;">
        Barcode: ${product.barcode || '-'} &nbsp;|&nbsp; SKU: ${product.sku || '-'} &nbsp;|&nbsp; Satuan: ${product.unit || 'PCS'}
      </div>
      ${currentUser.role === 'admin' ? `
      <div style="display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap;">
        <div style="flex:1; min-width:120px; background:#dbeafe; border-radius:8px; padding:10px 14px; text-align:center;">
          <div style="font-size:11px; color:#1d4ed8; font-weight:600;">📦 STOK OFFICE</div>
          <div style="font-size:22px; font-weight:800; color:#1e3a8a;">${product.warehouse_stock}</div>
        </div>
        <div style="flex:1; min-width:120px; background:#dcfce7; border-radius:8px; padding:10px 14px; text-align:center;">
          <div style="font-size:11px; color:#16a34a; font-weight:600;">🛒 STOK MESS</div>
          <div style="font-size:22px; font-weight:800; color:#15803d;">${product.display_stock}</div>
        </div>
      </div>` : ''}
      <div style="display:flex; gap:10px; margin-bottom:10px; flex-wrap:wrap; align-items:flex-end;">
        <div style="flex:1; min-width:100px;">
          <label style="font-size:12px; font-weight:600; color:#475569; display:block; margin-bottom:4px;">Jumlah Transfer</label>
          <input type="number" id="transferQty" min="1" placeholder="0"
            style="width:100%; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:18px; font-weight:700; text-align:center;">
        </div>
        <div style="flex:2; min-width:180px;">
          <label style="font-size:12px; font-weight:600; color:#475569; display:block; margin-bottom:4px;">Catatan (opsional)</label>
          <input type="text" id="transferNote" placeholder="Catatan..."
            style="width:100%; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:14px;">
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="submitTransfer()" style="flex:1; min-width:180px;">🛒 Isi Mess</button>
        <button class="btn btn-gray" onclick="resetTransferForm()" style="min-width:80px;">✕ Ganti</button>
      </div>
    </div>
  `;
}

function resetTransferForm(){
  transferSelectedProduct = null;
  const scanInput = document.getElementById('transferScanInput');
  if (scanInput) { scanInput.value = ''; scanInput.focus(); }
  hideTransferSearch();
  const formEl = document.getElementById('transferInlineForm');
  if (formEl) { formEl.style.display = 'none'; formEl.innerHTML = ''; }
}

// Fungsi lama — tetap ada supaya tidak ada error
function onTransferProductChange(){}

async function submitTransfer(){
  const product_id = document.getElementById('transferProductSelect').value;
  const qty = parseInt(document.getElementById('transferQty').value);
  const note = document.getElementById('transferNote').value.trim();

  if (!product_id || !transferSelectedProduct)
    return toast('Pilih produk terlebih dahulu', 'error');

  if (!qty || qty <= 0)
    return toast('Jumlah harus lebih dari 0', 'error');

  if (qty > transferSelectedProduct.warehouse_stock)
    return toast(`Stok Office tidak cukup (tersedia: ${transferSelectedProduct.warehouse_stock})`, 'error');

  try {
    await api('/transfer', 'POST', {
      product_id,
      qty,
      direction: 'to_display',
      note
    });

    toast('Stok berhasil dikirim ke Mess');
    await loadStockPage();

  } catch(e){
    toast(e.message, 'error');
  }
}

// ===== SCANNER KAMERA: TRANSFER =====
async function startTransferBarcodeScanner(){
  const reader = document.getElementById('transferReader');
  if(!reader){ toast('Reader transfer tidak ditemukan', 'error'); return; }
  reader.style.display = 'block';
  const scanner = new Html5Qrcode('transferReader');
  scanner.start(
    { facingMode: 'environment' },
    { fps: 20, qrbox: { width: 300, height: 150 }, aspectRatio: 1.7778,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,  Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39
      ]
    },
    async (decodedText) => {
      await scanner.stop();
      reader.style.display = 'none';
      const scanInput = document.getElementById('transferScanInput');
      if (scanInput) {
        scanInput.value = decodedText;
        // PENTING: trigger event 'input' agar setupTransferScanListener() mendeteksi nilai baru
        scanInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const exact = transferProducts.find(p => String(p.barcode || '').trim() === decodedText.trim());
      if (exact) pilihProdukTransfer(exact);
      else {
        showTransferSearch(decodedText);
        toast('Barcode tidak ditemukan, coba cari manual', 'error');
      }
    },
    () => {}
  );
}

async function loadTransferHistory(){
  const data = await api('/transfers');
  const tbody = document.getElementById('transferTable');
  tbody.innerHTML = data.map(t => `
    <tr>
      <td>${t.created_at}</td>
      <td>${t.product_name}</td>
      <td>${t.category_name}</td>
      <td>
  <span class="pill pill-blue">
    Office → Mess
  </span>
</td>
      <td>${t.qty}</td>
      <td>${t.note || '-'}</td>
      <td>${t.user || '-'}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">Belum ada riwayat transfer</td></tr>';
}

// ===== HELPER: nama file laporan dinamis =====
function formatDateForFilename(dateStr){
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}
function buildReportFilename(type, from, to, ext){
  let typeLabel;
  if (type === 'in') typeLabel = 'Stok-Masuk';
  else if (type === 'out') typeLabel = 'Stok-Keluar';
  else typeLabel = 'Semua-Stok';

  let datePart = '';
  const f = formatDateForFilename(from);
  const t = formatDateForFilename(to);
  if (f && t) datePart = `_${f}_sd_${t}`;
  else if (f) datePart = `_dari_${f}`;
  else if (t) datePart = `_sampai_${t}`;

  return `Riwayat-${typeLabel}${datePart}.${ext}`;
}

function exportLogs(){
  const fromEl = document.getElementById('logFrom') || document.getElementById('repFrom');
  const toEl = document.getElementById('logTo') || document.getElementById('repTo');
  const typeEl = document.getElementById('repType') || document.getElementById('logType');
  const from = fromEl ? fromEl.value : '';
  const to = toEl ? toEl.value : '';
  let type = typeEl ? typeEl.value : '';
  if (!type) type = 'all';
  let path = '/export/logs?';
  if (from) path += 'from=' + from + '&';
  if (to) path += 'to=' + to + '&';
  if (type && type !== 'all') path += 'type=' + type;
  const filename = buildReportFilename(type, from, to, 'xlsx');
  downloadWithAuth(path, filename);
}

function exportLaporan(){
  const from = document.getElementById('repFrom') ? document.getElementById('repFrom').value : '';
  const to = document.getElementById('repTo') ? document.getElementById('repTo').value : '';
  const type = document.getElementById('repType') ? document.getElementById('repType').value : 'all';
  let path = '/export/laporan?';
  if (from) path += 'from=' + from + '&';
  if (to) path += 'to=' + to + '&';
  if (type && type !== 'all') path += 'type=' + type;
  const f = formatDateForFilename(from);
  const t = formatDateForFilename(to);
  let datePart = '';
  if (f && t) datePart = '_' + f + '_sd_' + t;
  else if (f) datePart = '_dari_' + f;
  else if (t) datePart = '_sampai_' + t;
  downloadWithAuth(path, 'Laporan-Stok-Keseluruhan' + datePart + '.xlsx');
}

function exportPdf(){
  const from = document.getElementById('repFrom').value;
  const to = document.getElementById('repTo').value;
  const type = document.getElementById('repType').value;
  let path = '/export/logs-pdf?';
  if (from) path += 'from=' + from + '&';
  if (to) path += 'to=' + to + '&';
  if (type && type !== 'all') path += 'type=' + type;
  const filename = buildReportFilename(type, from, to, 'pdf');
  downloadWithAuth(path, filename);
}

// ===== LAPORAN PAGE =====
async function loadReportPage(){
  await loadReport();
  await loadCurrentStock();
}

async function loadReport(){
  const from = document.getElementById('repFrom').value;
  const to = document.getElementById('repTo').value;
  const type = document.getElementById('repType').value;
  let url = '/report?';
  if (from) url += 'from=' + from + '&';
  if (to) url += 'to=' + to + '&';
  if (type) url += 'type=' + type;
  const logs = await api(url);
  const tbody = document.getElementById('reportTable');
  tbody.innerHTML = logs.map(l => `
    <tr>
      <td>${l.created_at}</td>
      <td>${l.product_name}</td>
      <td>${l.category_name}</td>
      <td class="type-${l.type}">${l.type === 'in' ? 'MASUK' : 'KELUAR'}</td>
      <td>${l.qty}</td>
      <td>${l.note || '-'}</td>
      <td>${l.user || '-'}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">Tidak ada data</td></tr>';
}

async function loadCurrentStock(){
  const data = await api('/current-stock');
  const tbody = document.getElementById('currentStockTable');
  tbody.innerHTML = data.map(p => {
    const isLow = p.warehouse_stock <= p.warehouse_min || p.display_stock <= p.display_min;
    let statusHtml = isLow ? '<span class="pill pill-red">Menipis</span>' : '<span class="pill pill-green">Aman</span>';
    if (isLow) {
      let saran = [];
      if (p.warehouse_reorder_qty > 0) saran.push(`Order gudang +${p.warehouse_reorder_qty}`);
      if (p.display_refill_qty > 0) saran.push(`Isi display +${p.display_refill_qty}`);
      if (saran.length) statusHtml += `<div class="reorder-note">${saran.join('<br>')}</div>`;
    }
    return `
    <tr>
      <td>${p.name}</td>
      <td>${p.category_name}</td>
      <td class="${p.warehouse_stock <= p.warehouse_min ? 'stock-low' : 'stock-ok'}">${p.warehouse_stock}</td>
      <td class="${p.display_stock <= p.display_min ? 'stock-low' : 'stock-ok'}">${p.display_stock}</td>
      <td>${p.total_stock}</td>
      <td>${formatRupiah(p.price)}</td>
      <td>${statusHtml}</td>
    </tr>
  `;
  }).join('') || '<tr><td colspan="7" class="empty">Belum ada produk</td></tr>';
}

// ===== STOCK OPNAME =====
let opnameProducts = [];

// ===== STATE OPNAME =====
let opnameSelectedProduct = null; // produk yang sedang aktif di form

async function loadOpnamePage(){
  const isAdmin = currentUser.role === 'admin';

  // Atur tampilan panel sesuai role
  const historyPanel = document.getElementById('opnameHistoryPanel');
  const kasirHistoryPanel = document.getElementById('opnameKasirHistoryPanel');
  const kasirInfo = document.getElementById('opnameKasirInfo');
  const adminActions = document.getElementById('opnameAdminActions');
  const subtitle = document.getElementById('opnameSubtitle');

  if (isAdmin) {
    historyPanel.style.display = 'block';
    kasirHistoryPanel.style.display = 'none';
    kasirInfo.style.display = 'none';
    adminActions.style.display = '';
    subtitle.textContent = 'Scan barcode atau ketik nama produk → isi qty → simpan. Approve opname kasir di riwayat bawah.';
  } else {
    historyPanel.style.display = 'none';
    kasirHistoryPanel.style.display = 'block';
    kasirInfo.style.display = 'block';
    adminActions.style.display = 'none';
    subtitle.textContent = 'Scan barcode atau ketik nama produk → isi qty → simpan. Admin akan menyetujui data kamu.';
  }

  // Load semua produk ke cache
  opnameProducts = await api('/opname/products');

  // Reset form ke kondisi awal (belum pilih produk)
  resetOpnameForm();

  // Pasang listener scan input (hanya sekali)
  const scanInput = document.getElementById('scanBarcodeOpname');
  if(scanInput && !scanInput.dataset.listenerAdded){
    let debounceTimer = null;
    let lastInputTime = 0;
    let inputBuffer = '';

    scanInput.addEventListener('input', () => {
      const val = scanInput.value.trim();
      if (!val) { hideOpnameDropdown(); return; }

      const now = Date.now();
      const timeDiff = now - lastInputTime;
      lastInputTime = now;

      // Scanner fisik ketik sangat cepat (< 50ms per karakter)
      // Kita deteksi: kalau timeDiff < 50ms, kemungkinan scanner
      // Kalau timeDiff >= 50ms, kemungkinan ketik manual
      clearTimeout(debounceTimer);

      if (timeDiff < 50) {
        // Kemungkinan scanner — tunggu selesai lalu cari exact
        debounceTimer = setTimeout(() => {
          const finalVal = scanInput.value.trim();
          const exact = opnameProducts.find(p => String(p.barcode || '').trim() === finalVal);
          if (exact) {
            pilihProdukOpname(exact);
          } else {
            showOpnameDropdown(finalVal);
          }
        }, 150);
      } else {
        // Ketik manual — live search dengan debounce
        debounceTimer = setTimeout(() => showOpnameDropdown(val), 300);
      }
    });

    scanInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(debounceTimer);
        const val = scanInput.value.trim();
        if (!val) return;
        const exact = opnameProducts.find(p => String(p.barcode || '').trim() === val);
        if (exact) {
          pilihProdukOpname(exact);
        } else {
          showOpnameDropdown(val);
          setTimeout(() => {
            const items = document.querySelectorAll('#opnameSearchResults .opname-search-item');
            if (items.length === 1) items[0].click();
          }, 300);
        }
      }
      if (e.key === 'Escape') { hideOpnameDropdown(); resetOpnameForm(); }
    });

    // Tutup dropdown kalau klik di luar
    document.addEventListener('click', (e) => {
      const drop = document.getElementById('opnameSearchResults');
      if (drop && !drop.contains(e.target) && e.target !== scanInput) {
        hideOpnameDropdown();
      }
    });

    scanInput.dataset.listenerAdded = 'true';
  }

  if(isAdmin) loadOpnameHistory();
  else loadOpnameKasirHistory();

  // Fokus ke input scan
  setTimeout(() => {
    if (scanInput) { scanInput.focus(); scanInput.value = ''; }
  }, 300);
}

// Tampilkan dropdown hasil pencarian
function showOpnameDropdown(query){
  const q = query.toLowerCase().trim();
  const results = opnameProducts.filter(p =>
    p.name.toLowerCase().includes(q) ||
    String(p.barcode || '').includes(q) ||
    String(p.sku || '').toLowerCase().includes(q)
  ).slice(0, 10);

  const drop = document.getElementById('opnameSearchResults');
  if (!drop) return;

  if (results.length === 0) {
    drop.style.display = 'block';
    drop.innerHTML = `<div style="padding:14px 16px; color:#94a3b8; font-size:13px;">❌ Produk tidak ditemukan untuk "<b>${query}</b>"</div>`;
    return;
  }

  drop.style.display = 'block';
  drop.innerHTML = results.map(p => `
    <div class="opname-search-item"
      onclick="pilihProdukOpname(${JSON.stringify(p).replace(/"/g,'&quot;')})"
      style="padding:11px 14px; cursor:pointer; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center;"
      onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''">
      <div>
        <div style="font-weight:600; font-size:13px; color:#1e293b;">${p.name}</div>
        <div style="font-size:11px; color:#94a3b8; margin-top:2px;">
          📦 Barcode: ${p.barcode || '-'} &nbsp;|&nbsp; SKU: ${p.sku || '-'}
        </div>
      </div>
      <div style="font-size:12px; color:#64748b; text-align:right; white-space:nowrap; margin-left:12px;">
        Office: <b>${p.warehouse_stock}</b><br>Mess: <b>${p.display_stock}</b>
      </div>
    </div>
  `).join('');
}

function hideOpnameDropdown(){
  const drop = document.getElementById('opnameSearchResults');
  if (drop) { drop.style.display = 'none'; drop.innerHTML = ''; }
}

// Dipanggil saat user klik hasil dropdown ATAU exact match barcode
function pilihProdukOpname(product){
  if (typeof product === 'string') product = JSON.parse(product);
  opnameSelectedProduct = product;

  // Isi input scan dengan nama produk
  const scanInput = document.getElementById('scanBarcodeOpname');
  if (scanInput) scanInput.value = product.name;
  hideOpnameDropdown();

  // Render form inline langsung di bawah input scan
  renderOpnameForm(product);

  // Fokus ke qty
  setTimeout(() => {
    const qty = document.getElementById('opnameStockFisik');
    if (qty) qty.focus();
  }, 100);
  if (typeof playBeep === 'function') playBeep();
}

// Render form input qty langsung di panel yang sama
function renderOpnameForm(product){
  const isAdmin = currentUser.role === 'admin';
  const formEl = document.getElementById('opnameInlineForm');
  if (!formEl) return;

  // Info stok sistem
  const officeStok = product.warehouse_stock;
  const messStok   = product.display_stock;

  formEl.style.display = 'block';
  formEl.innerHTML = `
    <div style="margin-top:14px; padding:14px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">
      <!-- Nama produk -->
      <div style="font-weight:700; font-size:15px; color:#1e293b; margin-bottom:4px;">📦 ${product.name}</div>
      <div style="font-size:12px; color:#64748b; margin-bottom:10px;">
        Barcode: ${product.barcode || '-'} &nbsp;|&nbsp; SKU: ${product.sku || '-'} &nbsp;|&nbsp; Kategori: ${product.category_name || '-'}
      </div>

      <!-- Info stok sistem — hanya admin yang melihat stok sistem -->
      ${isAdmin ? `
      <div style="display:flex; gap:10px; margin-bottom:12px; flex-wrap:wrap;">
        <div style="flex:1; min-width:120px; background:#dbeafe; border-radius:8px; padding:10px 14px; text-align:center;">
          <div style="font-size:11px; color:#1d4ed8; font-weight:600;">STOK OFFICE (Sistem)</div>
          <div style="font-size:22px; font-weight:800; color:#1e3a8a;">${officeStok}</div>
        </div>
        <div style="flex:1; min-width:120px; background:#dcfce7; border-radius:8px; padding:10px 14px; text-align:center;">
          <div style="font-size:11px; color:#16a34a; font-weight:600;">STOK MESS (Sistem)</div>
          <div style="font-size:22px; font-weight:800; color:#15803d;">${messStok}</div>
        </div>
      </div>` : ``}

      <!-- Pilih lokasi -->
      <div style="display:flex; gap:10px; margin-bottom:12px; flex-wrap:wrap; align-items:center;">
        <label style="font-size:13px; font-weight:600; color:#475569; white-space:nowrap;">Lokasi Hitung:</label>
        <select id="opnameLocation" onchange="onLokasiChange()" style="padding:8px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:14px; flex:1; min-width:160px;">
          <option value="warehouse">MIOF / Gudang</option>
          <option value="display">MIPL / Mess</option>
        </select>
      </div>

      <!-- Input qty -->
      <div style="display:flex; gap:10px; margin-bottom:10px; flex-wrap:wrap; align-items:flex-start;">
        <div style="flex:1; min-width:140px;">
          <label style="font-size:12px; font-weight:600; color:#475569; display:block; margin-bottom:4px;">Qty Hasil Hitung Fisik</label>
          <input type="number" id="opnameStockFisik" min="0" placeholder="0"
            oninput="onQtyChange()"
            style="width:100%; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:18px; font-weight:700; text-align:center;">
        </div>
        <div style="flex:2; min-width:180px;">
          <label style="font-size:12px; font-weight:600; color:#475569; display:block; margin-bottom:4px;">Catatan (opsional)</label>
          <input type="text" id="opnameNote" placeholder="Catatan..."
            style="width:100%; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:14px;">
        </div>
      </div>

      <!-- Preview selisih (admin) -->
      <div id="opnamePreview" style="font-size:13px; margin-bottom:10px; min-height:20px;"></div>

      <!-- Tombol -->
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button id="btnSubmitOpname" class="btn btn-primary" onclick="submitOpname()" style="flex:1; min-width:140px;">✅ Simpan Opname</button>
        <button class="btn btn-gray" onclick="resetOpnameForm()" style="min-width:100px;">✕ Ganti Produk</button>
      </div>

      ${!isAdmin ? `<div style="margin-top:10px; padding:8px 12px; background:#eff6ff; border-radius:8px; font-size:12px; color:#1d4ed8;">
        ℹ️ Data dikirim ke admin untuk disetujui sebelum stok diperbarui.
      </div>` : ''}
    </div>
  `;
}

// Update preview selisih saat qty diketik
function onQtyChange(){
  if (currentUser.role !== 'admin') return;
  const loc = document.getElementById('opnameLocation')?.value;
  if (!loc || !opnameSelectedProduct) return;
  const sysStok = loc === 'warehouse' ? opnameSelectedProduct.warehouse_stock : opnameSelectedProduct.display_stock;
  const fisik = parseInt(document.getElementById('opnameStockFisik')?.value);
  const preview = document.getElementById('opnamePreview');
  if (!preview) return;
  if (isNaN(fisik)) { preview.innerHTML = ''; return; }
  const selisih = fisik - sysStok;
  if (selisih === 0) preview.innerHTML = '✅ Stok sesuai, tidak ada selisih.';
  else if (selisih > 0) preview.innerHTML = `⚠️ Stok fisik lebih banyak <b style="color:#16a34a">+${selisih}</b> dari sistem.`;
  else preview.innerHTML = `⚠️ Stok fisik lebih sedikit <b style="color:#dc2626">${selisih}</b> dari sistem.`;
}

function onLokasiChange(){
  // Refresh preview selisih saat lokasi diganti
  onQtyChange();
}

// Reset form ke kondisi awal (belum pilih produk)
function resetOpnameForm(){
  opnameSelectedProduct = null;
  const scanInput = document.getElementById('scanBarcodeOpname');
  if (scanInput) { scanInput.value = ''; scanInput.focus(); }
  hideOpnameDropdown();
  const formEl = document.getElementById('opnameInlineForm');
  if (formEl) { formEl.style.display = 'none'; formEl.innerHTML = ''; }
}

// Alias lama supaya handleOpnameScan masih bisa jalan
function clearOpnameSearch(){ resetOpnameForm(); }
function hideOpnameSearch(){ hideOpnameDropdown(); }
function selectOpnameProduct(p){ pilihProdukOpname(p); }
function onOpnameProductChange(){} // tidak dipakai lagi

async function submitOpname() {
  if (!opnameSelectedProduct) return toast('Scan atau cari produk dulu', 'error');
  const product_id = opnameSelectedProduct.id;
  const loc = document.getElementById('opnameLocation')?.value || 'warehouse';
  const fisikEl = document.getElementById('opnameStockFisik');
  const stock_fisik = fisikEl ? Number(fisikEl.value) : NaN;
  const note = document.getElementById('opnameNote')?.value.trim() || '';

  if (isNaN(stock_fisik) || fisikEl?.value === '') return toast('Isi qty hasil hitung fisik dulu', 'error');
  if (stock_fisik < 0) return toast('Qty tidak boleh negatif', 'error');

  const btn = document.getElementById('btnSubmitOpname');
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }

  try {
    const payload = { product_id, note };
    if (loc === 'warehouse') payload.stock_fisik_warehouse = stock_fisik;
    else payload.stock_fisik_display = stock_fisik;

    const result = await api('/opname', 'POST', payload);
    if (currentUser.role === 'admin') {
      const selisih = result?.results?.[0]?.selisih ?? result?.selisih ?? 0;
      if (selisih === 0) toast('✅ Opname disimpan, stok sesuai!', 'success');
      else toast(`✅ Opname disimpan. Selisih: ${selisih > 0 ? '+' : ''}${selisih}`, 'success');
    } else {
      toast('✅ Opname disimpan!', 'success');
    }

    // Reset form siap scan produk berikutnya
    resetOpnameForm();
    if(currentUser.role === 'admin') loadOpnameHistory();
    else loadOpnameKasirHistory();
  } catch (err) {
    toast(err.message || 'Gagal menyimpan opname', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '✅ Simpan Opname'; }
  }
}

async function loadOpnameHistory(){
  const from = document.getElementById('opFrom')?.value || '';
  const to = document.getElementById('opTo')?.value || '';
  const status = document.getElementById('opnameStatusFilter')?.value || '';
  let url = '/opname?';
  if (from) url += 'from=' + from + '&';
  if (to) url += 'to=' + to + '&';
  if (status) url += 'status=' + status;
  const data = await api(url);
  const tbody = document.getElementById('opnameTable');

  // Update jumlah pending di bulk bar
  const pendingCount = data.filter(o => o.status === 'pending').length;
  const countLabel = document.getElementById('opnamePendingCount');
  if (countLabel) countLabel.textContent = pendingCount > 0 ? `· ${pendingCount} pending` : '';
  const btnApproveLabel = document.getElementById('btnBulkApprove');
  if (btnApproveLabel) btnApproveLabel.textContent = `✓ Approve Semua Pending (${pendingCount})`;

  tbody.innerHTML = data.map(o => {
    const statusBadge = o.status === 'approved'
      ? `<span class="pill pill-green">APPROVED</span>`
      : o.status === 'rejected'
        ? `<span class="pill pill-red">DITOLAK</span>`
        : `<span class="pill" style="background:#fef3c7;color:#d97706;">PENDING ⏳</span>`;

    // Kolom Aksi dihapus — approve/tolak pakai bulk action bar

    const chkInput = o.status === 'pending'
      ? `<input type="checkbox" class="opname-chk" value="${o.id}" onchange="onOpnameChkChange()" style="width:16px;height:16px;cursor:pointer;accent-color:#1a56db;">`
      : `<input type="checkbox" disabled style="width:16px;height:16px;opacity:.3;">`;

    const selisihClass = o.selisih === 0 ? '' : (o.selisih > 0 ? 'type-in' : 'type-out');
    const selisihLabel = o.selisih === 0 ? '0' : (o.selisih > 0 ? '+' + o.selisih : o.selisih);

    return `
    <tr>
      <td style="width:44px;min-width:44px;padding:8px 4px;text-align:center;vertical-align:middle;">${chkInput}</td>
      <td style="font-size:12px; white-space:nowrap;">${o.created_at}</td>
      <td>${o.user || '-'}</td>
      <td style="font-weight:600;">${o.product_name}</td>
      <td>${o.location === 'warehouse' ? 'MIOF' : 'MIPL'}</td>
      <td><b>${o.stock_fisik}</b></td>
      <td>${o.stock_system}</td>
      <td class="${selisihClass}" style="font-weight:700;">${selisihLabel}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">Belum ada riwayat opname</td></tr>';

  // Sync master checkbox
  const masterChk = document.getElementById('selectAllOpname');
  if (masterChk) masterChk.checked = false;
}

function onOpnameChkChange(){
  const all = document.querySelectorAll('.opname-chk:not(:disabled)');
  const checkedList = document.querySelectorAll('.opname-chk:checked');
  const n = checkedList.length;

  // Sync master checkbox (termasuk indeterminate state)
  const master = document.getElementById('selectAllOpname');
  if (master) {
    master.checked = all.length > 0 && n === all.length;
    master.indeterminate = n > 0 && n < all.length;
  }

  // Update label tombol bulk sesuai jumlah yang dicentang
  const btnApprove = document.getElementById('btnBulkApprove');
  const btnTolak   = document.getElementById('btnBulkTolak');
  if (btnApprove) btnApprove.textContent = n > 0 ? `✓ Approve Terpilih (${n})` : `✓ Approve Semua Pending`;
  if (btnTolak)   btnTolak.textContent   = n > 0 ? `✗ Tolak Terpilih (${n})`  : `✗ Tolak Yang Dicentang`;
}

async function loadOpnameKasirHistory(){
  const data = await api('/opname?');
  const tbody = document.getElementById('opnameKasirTable');
  const mine = data.filter(o => o.user === currentUser.username);

  // Kelompokkan per tanggal SO (YYYY-MM-DD)
  const grouped = {};
  mine.forEach(o => {
    const tgl = o.created_at ? o.created_at.split(' ')[0] : 'Tanpa Tanggal';
    if (!grouped[tgl]) grouped[tgl] = [];
    grouped[tgl].push(o);
  });

  if (Object.keys(grouped).length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Belum ada data opname</td></tr>';
    return;
  }

  let html = '';
  Object.keys(grouped).sort().reverse().forEach(tgl => {
    const items = grouped[tgl];
    const total = items.length;
    const approved = items.filter(o => o.status === 'approved').length;
    const rejected = items.filter(o => o.status === 'rejected').length;
    const pending  = items.filter(o => o.status === 'pending').length;

    // Baris header tanggal SO
    let notifBadge = '';
    if (pending > 0)
      notifBadge = `<span class="pill" style="background:#fef3c7;color:#d97706; margin-left:6px;">⏳ ${pending} Menunggu</span>`;
    if (approved > 0)
      notifBadge += `<span class="pill pill-green" style="margin-left:4px;">✓ ${approved} Disetujui</span>`;
    if (rejected > 0)
      notifBadge += `<span class="pill pill-red" style="margin-left:4px;">✗ ${rejected} Ditolak</span>`;

    html += `<tr style="background:#f0f4ff;">
      <td colspan="5" style="font-weight:700; font-size:12px; color:#1a56db; padding:8px 14px;">
        📅 SO Tanggal : ${tgl} &nbsp;·&nbsp; ${total} item ${notifBadge}
      </td>
    </tr>`;

    items.forEach(o => {
      const statusBadge = o.status === 'approved'
        ? `<span class="pill pill-green">✓ Disetujui</span>`
        : o.status === 'rejected'
          ? `<span class="pill pill-red">✗ Ditolak</span>`
          : `<span class="pill" style="background:#fef3c7;color:#d97706;">⏳ Menunggu Admin</span>`;
      html += `<tr>
        <td style="font-size:12px;">${o.created_at}</td>
        <td>${o.product_name}</td>
        <td>${o.location === 'warehouse' ? 'MIOF' : 'MIPL'}</td>
        <td><b>${o.stock_fisik}</b></td>
        <td>${statusBadge}</td>
      </tr>`;
    });
  });

  tbody.innerHTML = html;
}

async function approveOpname(id){
  if (!confirm('Approve opname ini? Stok produk akan diperbarui sesuai hasil hitung fisik.')) return;
  try {
    await api('/opname/' + id + '/approve', 'POST');
    toast('Opname berhasil di-approve ✅');
    loadOpnameHistory();
    loadDashboard();
  } catch(e){ toast(e.message, 'error'); }
}

async function rejectOpname(id){
  if (!confirm('Tolak opname ini? Data tidak akan mengubah stok.')) return;
  try {
    await api('/opname/' + id + '/reject', 'POST');
    toast('Opname ditolak');
    loadOpnameHistory();
  } catch(e){ toast(e.message, 'error'); }
}

// ===== APPROVE SEMUA / TERPILIH =====
async function approveAllPendingOpname(){
  const semuaPending = Array.from(document.querySelectorAll('.opname-chk:not(:disabled)'));
  const yangDicentang = Array.from(document.querySelectorAll('.opname-chk:checked'));

  // Kalau ada yg dicentang → approve yg dicentang saja. Kalau tidak ada yg dicentang → approve semua pending
  const targets = yangDicentang.length > 0 ? yangDicentang : semuaPending;

  if (targets.length === 0) {
    return toast('Tidak ada opname pending', 'error');
  }

  const label = yangDicentang.length > 0
    ? `${targets.length} opname yang dicentang`
    : `SEMUA ${targets.length} opname pending`;

  if (!confirm(`Approve ${label}?\nStok akan diperbarui sesuai hitung fisik kasir.`)) return;

  let sukses = 0, gagal = 0;
  for (const el of targets) {
    try {
      await api('/opname/' + el.value + '/approve', 'POST');
      sukses++;
    } catch(e) { gagal++; }
  }

  toast(`✅ ${sukses} opname di-approve` + (gagal > 0 ? ` · ${gagal} gagal` : ''), 'success');
  loadOpnameHistory();
  loadDashboard();
}

// ===== TOLAK TERPILIH =====
async function rejectCheckedOpname(){
  const yangDicentang = Array.from(document.querySelectorAll('.opname-chk:checked'));

  if (yangDicentang.length === 0) {
    return toast('Centang dulu baris opname yang ingin ditolak', 'error');
  }

  if (!confirm(`Tolak ${yangDicentang.length} opname yang dicentang?\nStok tidak akan berubah.`)) return;

  let sukses = 0, gagal = 0;
  for (const el of yangDicentang) {
    try {
      await api('/opname/' + el.value + '/reject', 'POST');
      sukses++;
    } catch(e) { gagal++; }
  }

  toast(`${sukses} opname ditolak` + (gagal > 0 ? ` · ${gagal} gagal` : ''));
  loadOpnameHistory();
}

// ===== CENTANG / UNCENTANG SEMUA PENDING =====
function toggleSelectAllOpname(masterChk){
  const boxes = document.querySelectorAll('.opname-chk:not(:disabled)');
  boxes.forEach(c => { c.checked = masterChk.checked; });
  masterChk.indeterminate = false;
  // Reuse onOpnameChkChange untuk update label tombol
  onOpnameChkChange();
}

async function editOpnameQty(id, currentQty){
  const newQty = prompt('Edit jumlah fisik (qty):', currentQty);
  if (newQty === null || newQty === '') return;
  const qty = parseInt(newQty);
  if (isNaN(qty) || qty < 0) return toast('Qty tidak valid', 'error');
  try {
    await api('/opname/' + id, 'PUT', { stock_fisik: qty });
    toast('Qty opname diperbarui');
    loadOpnameHistory();
  } catch(e){ toast(e.message, 'error'); }
}

function exportOpnameExcel(){
  const from = document.getElementById('opFrom')?.value || '';
  const to = document.getElementById('opTo')?.value || '';
  const status = document.getElementById('opnameStatusFilter')?.value || '';
  let path = '/export/opname?';
  if (from) path += 'from=' + from + '&';
  if (to) path += 'to=' + to + '&';
  if (status) path += 'status=' + status;
  downloadWithAuth(path, 'stock-opname.xlsx');
}

// ===== USER MANAGEMENT =====
async function loadUsersPage(){
  const users = await api('/users');
  const tbody = document.getElementById('usersTable');
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${u.username}</td>
      <td>${u.full_name || '-'}</td>
      <td><span class="badge-role badge-${u.role}">${u.role === 'admin' ? 'Admin' : 'Kasir'}</span></td>
      <td><span class="badge-role ${u.active ? 'badge-active' : 'badge-inactive'}">${u.active ? 'Aktif' : 'Nonaktif'}</span></td>
      <td>${u.created_at || '-'}</td>
      <td>
        <button class="btn btn-sm btn-gray" onclick='openUserModal(${JSON.stringify(u)})'>Edit</button>
        <button class="btn btn-sm btn-outline" onclick="openResetPassword(${u.id})">Reset Pwd</button>
        ${u.id !== currentUser.id ? `<button class="btn btn-sm btn-red" onclick="deleteUser(${u.id})">Hapus</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty">Belum ada pengguna</td></tr>';
}

function openUserModal(user=null){
  document.getElementById('userModalTitle').textContent = user ? 'Edit Pengguna' : 'Tambah Pengguna';
  document.getElementById('userId').value = user ? user.id : '';
  document.getElementById('userUsername').value = user ? user.username : '';
  document.getElementById('userUsername').disabled = !!user;
  document.getElementById('userFullName').value = user ? (user.full_name || '') : '';
  document.getElementById('userRoleSelect').value = user ? user.role : 'kasir';
  document.getElementById('userPasswordSection').style.display = user ? 'none' : 'block';
  document.getElementById('userStatusSection').style.display = user ? 'block' : 'none';
  if (user) document.getElementById('userActive').value = user.active ? '1' : '0';
  document.getElementById('userPassword').value = '';
  document.getElementById('userModalOverlay').classList.add('active');
}

async function saveUser(){
  const id = document.getElementById('userId').value;
  const username = document.getElementById('userUsername').value.trim();
  const full_name = document.getElementById('userFullName').value.trim();
  const role = document.getElementById('userRoleSelect').value;

  try {
    if (id) {
      const active = document.getElementById('userActive').value === '1';
      await api('/users/' + id, 'PUT', { full_name, role, active });
      toast('Pengguna diperbarui');
    } else {
      const password = document.getElementById('userPassword').value;
      if (!username) return toast('Username wajib diisi', 'error');
      if (!password || password.length < 4) return toast('Password minimal 4 karakter', 'error');
      await api('/users', 'POST', { username, password, full_name, role });
      toast('Pengguna ditambahkan');
    }
    closeModal('userModalOverlay');
    loadUsersPage();
  } catch(e){ toast(e.message, 'error'); }
}

function openResetPassword(id){
  document.getElementById('resetUserId').value = id;
  document.getElementById('resetNewPassword').value = '';
  document.getElementById('resetPasswordOverlay').classList.add('active');
}

async function confirmResetPassword(){
  const id = document.getElementById('resetUserId').value;
  const newPassword = document.getElementById('resetNewPassword').value;
  if (!newPassword || newPassword.length < 4) return toast('Password minimal 4 karakter', 'error');
  try {
    await api('/users/' + id + '/reset-password', 'POST', { newPassword });
    toast('Password berhasil direset');
    closeModal('resetPasswordOverlay');
  } catch(e){ toast(e.message, 'error'); }
}

async function deleteUser(id){
  if (!confirm('Hapus pengguna ini?')) return;
  try {
    await api('/users/' + id, 'DELETE');
    toast('Pengguna dihapus');
    loadUsersPage();
  } catch(e){ toast(e.message, 'error'); }
}

// ===== CHANGE OWN PASSWORD =====
function openPasswordModal(){
  document.getElementById('oldPassword').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('passwordModalOverlay').classList.add('active');
}
async function changeMyPassword(){
  if(currentUser.role !== 'admin'){
  toast(
    'Password hanya dapat diubah admin',
    'error'
  );
  return;
}
  const oldPassword = document.getElementById('oldPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  if (!newPassword || newPassword.length < 4) return toast('Password baru minimal 4 karakter', 'error');
  try {
    await api('/change-password', 'POST', { oldPassword, newPassword });
    toast('Password berhasil diubah');
    closeModal('passwordModalOverlay');
  } catch(e){ toast(e.message, 'error'); }
}

function playBeep(){
  const audio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');
  audio.play();
}

window.onload = () => {

  const savedToken =
  localStorage.getItem('stok_token');

  const savedUser =
  localStorage.getItem('stok_user');

  if(savedToken && savedUser){

    authToken = savedToken;
    currentUser = JSON.parse(savedUser);

    enterApp();

  }

};

  document.getElementById('loginPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') login();
  });


// findProductByBarcode — kompatibilitas, arahkan ke pilihProdukStock
function findProductByBarcode(barcode){
  barcode = String(barcode || '').trim();
  if (!barcode) return;
  const exact = stockProducts.find(p => String(p.barcode || '').trim() === barcode);
  if (exact) {
    pilihProdukStock(exact);
  } else {
    showStockSearch(barcode);
    toast('Barcode tidak ditemukan', 'error');
  }
}


// ===== SCANNER KAMERA: STOK MASUK/KELUAR =====
function startBarcodeScanner(){
  const reader = document.getElementById('reader');
  if(!reader){ toast('Reader tidak ditemukan', 'error'); return; }
  reader.style.display = 'block';
  const scanner = new Html5Qrcode('reader');
  scanner.start(
    { facingMode: 'environment' },
    { fps: 20, qrbox: { width: 300, height: 150 }, aspectRatio: 1.7778,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,  Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39
      ]
    },
    async (decodedText) => {
      await scanner.stop();
      reader.style.display = 'none';
      const scanInput = document.getElementById('scanBarcode');
      if (scanInput) {
        scanInput.value = decodedText;
        // PENTING: trigger event 'input' agar setupStockScanListener() mendeteksi nilai baru
        scanInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const exact = stockProducts.find(p => String(p.barcode || '').trim() === decodedText.trim());
      if (exact) {
        pilihProdukStock(exact);
      } else {
        showStockSearch(decodedText);
        toast('Barcode tidak ditemukan di daftar produk', 'error');
      }
    },
    () => {}
  );
}

// ===== SCANNER KAMERA: STOCK OPNAME =====
async function startOpnameScanner(){
  const reader = document.getElementById('opnameReader');
  if(!reader){ toast('Reader opname tidak ditemukan', 'error'); return; }
  reader.style.display = 'block';
  const scanner = new Html5Qrcode('opnameReader');
  scanner.start(
    { facingMode: 'environment' },
    { fps: 20, qrbox: { width: 300, height: 120 }, aspectRatio: 1.7778,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,  Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39
      ]
    },
    async (decodedText) => {
      document.getElementById('scanBarcodeOpname').value = decodedText;
      await handleOpnameScan(decodedText);
      await scanner.stop();
      reader.style.display = 'none';
    },
    () => {}
  );
}

// Listener scanBarcode dihandle di setupStockScanListener() — tidak perlu duplikat di sini

async function startProductBarcodeScanner(){
  const reader = document.getElementById('productReader');
  if (!reader) { toast('Element productReader tidak ditemukan', 'error'); return; }

  // Kalau sudah ada scanner aktif sebelumnya, bersihkan dulu
  if (window._productScanner) {
    try { await window._productScanner.stop(); } catch(e) {}
    window._productScanner = null;
  }

  reader.style.display = 'block';
  reader.innerHTML = '';

  const scanner = new Html5Qrcode('productReader');
  window._productScanner = scanner;

  try {
    await scanner.start(
      { facingMode: 'environment' },
      {
        fps: 20,
        // qrbox memanjang horizontal — penting untuk EAN-13 / barcode produk
        qrbox: { width: 300, height: 120 },
        aspectRatio: 1.7778,
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39
        ]
      },
      async (decodedText) => {
        // Stop scanner segera setelah barcode terbaca
        try { await scanner.stop(); } catch(e) {}
        window._productScanner = null;
        reader.style.display = 'none';

        const barcodeInput = document.getElementById('barcode');
        if (barcodeInput) {
          barcodeInput.value = decodedText.trim();
          barcodeInput.dispatchEvent(new Event('input', { bubbles: true }));
          barcodeInput.dispatchEvent(new Event('change', { bubbles: true }));
          barcodeInput.focus();
          toast('Barcode terbaca: ' + decodedText, 'success');
          if (typeof playBeep === 'function') playBeep();
        } else {
          toast('Input barcode tidak ditemukan', 'error');
        }
      },
      () => {} // error per-frame — abaikan
    );
  } catch(err) {
    reader.style.display = 'none';
    window._productScanner = null;
    toast('Gagal akses kamera: ' + err.message, 'error');
  }
}
function handleBarcodeScan(barcode){

  const select =
    document.getElementById('stockProductSelect');

  barcode = String(barcode).trim();

  for(let i=0;i<select.options.length;i++){

    const opt = select.options[i];

    const optBarcode =
      String(opt.dataset.barcode || '').trim();

    if(optBarcode === barcode){

      select.selectedIndex = i;

      toast(
        'Produk ditemukan: ' + opt.text,
        'success'
      );

      const qtyEl = document.getElementById('stockQty'); if (qtyEl) qtyEl.focus();

      playBeep();

      return;
    }
  }

  console.log('TIDAK KETEMU:', barcode);

  toast(
    'Produk tidak ditemukan',
    'error'
  );
}

document.addEventListener('keydown', function(e){

  if(e.key === 'Enter'){

    const qty = document.getElementById('stockQty');

    if(document.activeElement === qty){
      submitStock('in');
    }

  }

});

// PATCH KOPPA
document.addEventListener('DOMContentLoaded',()=>{
 const barcodeInput=document.getElementById('barcode');
 if(barcodeInput){
   barcodeInput.addEventListener('change',()=>playBeep && playBeep());
 }
});

function fillBarcodeToProduct(code){
 const el=document.getElementById('barcode');
 if(el){
   el.value=code;
   el.dispatchEvent(new Event('input'));
   if(typeof playBeep==='function') playBeep();
 }
}
async function handleOpnameScan(barcode){
  barcode = String(barcode).trim();
  if(!barcode) return;

  // Cari exact match di cache
  let product = opnameProducts.find(p => String(p.barcode || '').trim() === barcode);

  if(!product){
    // Belum ada di cache → fetch ulang
    try {
      const products = await api('/opname/products');
      opnameProducts = products;
      product = products.find(p => String(p.barcode || '').trim() === barcode);
    } catch(err){ toast(err.message, 'error'); return; }
  }

  if(product){
    pilihProdukOpname(product);
  } else {
    toast('Barcode tidak ditemukan: ' + barcode, 'error');
    const scanInput = document.getElementById('scanBarcodeOpname');
    if(scanInput) scanInput.value = barcode;
    showOpnameDropdown(barcode);
  }
}

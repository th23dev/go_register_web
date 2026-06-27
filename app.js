import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDaNbVpvkGov4vtabbk-bAWOpb7nDpmzrA",
  authDomain: "goregister-7394b.firebaseapp.com",
  databaseURL: "https://goregister-7394b-default-rtdb.firebaseio.com",
  projectId: "goregister-7394b",
  storageBucket: "goregister-7394b.firebasestorage.app",
  messagingSenderId: "1071850298174",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const root = document.querySelector("#app");

const collections = {
  products: "products",
  sales: "sales",
  categories: "categories",
  suppliers: "suppliers",
  registers: "cash_registers",
  entries: "financial_entries",
  exits: "financial_exits",
  users: "users",
  stockMovements: "stock_movements",
};

const state = {
  user: JSON.parse(localStorage.getItem("goRegisterUser") || "null"),
  view: "dashboard",
  darkTheme: localStorage.getItem("goRegisterDarkTheme") === "true",
  data: {
    products: [],
    sales: [],
    categories: [],
    suppliers: [],
    registers: [],
    entries: [],
    exits: [],
    users: [],
    stockMovements: [],
  },
  cart: [],
  search: "",
  discount: 0,
  loading: true,
  loadedCollections: new Set(),
  firebaseError: "",
  lastSync: null,
};

const navItems = [
  ["dashboard", "Painel", "dashboard", "all"],
  ["pos", "Vendas", "point_of_sale", "all"],
  ["cash", "Caixa", "payments", "all"],
  ["inventory", "Estoque", "inventory_2", "admin"],
  ["settings", "Ajustes", "settings", "all"],
];

const adminRoutes = new Set(["inventory", "stockHistory", "cashHistory", "categories", "suppliers", "users", "reports"]);

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });

const paymentLabels = {
  CASH: "Dinheiro",
  PIX: "Pix",
  DEBIT_CARD: "Cartao de Debito",
  CREDIT_CREDIT: "Cartao de Credito",
};

function getRouteView() {
  const route = window.location.hash.replace(/^#\/?/, "");
  return [...navItems.map(([id]) => id), ...adminRoutes].includes(route) ? route : "dashboard";
}

function isAdmin() {
  return state.user?.role === "ADMIN" || state.user?.role === "MASTER_ADMIN";
}

function isMasterAdmin() {
  return state.user?.role === "MASTER_ADMIN";
}

function roleLabel(role) {
  if (role === "MASTER_ADMIN") return "Administrador Mestre";
  if (role === "ADMIN") return "Administrador";
  return "Funcionario";
}

function isPrivilegedRole(role) {
  return role === "ADMIN" || role === "MASTER_ADMIN";
}

function canManageUser(user) {
  if (!user) return false;
  if (Number(user.id) === Number(state.user?.id)) return true;
  return !isPrivilegedRole(user.role) || isMasterAdmin();
}

function canAccess(view) {
  return !adminRoutes.has(view) || isAdmin();
}

function availableNavItems() {
  return navItems.filter(([, , , access]) => access !== "admin" || isAdmin());
}

function enforceAccess() {
  if (!canAccess(state.view)) {
    state.view = "dashboard";
    window.location.hash = "/dashboard";
    toast("Acesso restrito ao administrador.");
  }
}

function icon(name) {
  return `<span class="material-symbols-rounded" aria-hidden="true">${name}</span>`;
}

function nextId(items) {
  return Math.max(0, ...items.map((item) => Number(item.id) || 0)) + 1;
}

function todayBounds(offset = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offset);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.getTime(), end.getTime()];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseDecimal(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value ?? "")
    .trim()
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDecimalInput(value) {
  return String(value ?? 0).replace(".", ",");
}

function toast(message) {
  const old = document.querySelector(".toast");
  old?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

function applyTheme() {
  document.body.classList.toggle("dark", state.darkTheme);
}

function toggleTheme() {
  state.darkTheme = !state.darkTheme;
  localStorage.setItem("goRegisterDarkTheme", String(state.darkTheme));
  applyTheme();
}

function isReady() {
  return state.loadedCollections.size >= Object.keys(collections).length && !state.loading;
}

function syncLabel() {
  if (state.firebaseError) return "Erro no Firebase";
  if (!isReady()) return "Sincronizando";
  return state.lastSync ? `Atualizado ${dateTime.format(state.lastSync)}` : "Online";
}

function hasOpenModal() {
  return Boolean(document.querySelector(".modal-backdrop"));
}

async function runAction(task, successMessage = "") {
  try {
    await task();
    state.firebaseError = "";
    if (successMessage) toast(successMessage);
  } catch (error) {
    state.firebaseError = error.message || "Falha ao salvar no Firebase.";
    toast(state.firebaseError);
    renderApp();
  }
}

async function createInitialUsers() {
  const snap = await getDocs(collection(db, collections.users));
  const users = snap.docs.map((item) => ({ ...item.data(), docId: item.id }));
  const existingAdmin = users.find((user) => user.username === "admin");
  if (existingAdmin && existingAdmin.role !== "MASTER_ADMIN") {
    await updateDoc(doc(db, collections.users, existingAdmin.docId), { role: "MASTER_ADMIN" });
  }
  if (users.length === 0) {
    await setDoc(doc(db, collections.users, "1"), {
      id: 1,
      username: "admin",
      passwordHash: "admin",
      role: "MASTER_ADMIN",
      isActive: true,
    });
    await setDoc(doc(db, collections.users, "2"), {
      id: 2,
      username: "funcionario",
      passwordHash: "123",
      role: "OPERATOR",
      isActive: true,
    });
  }
}

function subscribe() {
  Object.entries(collections).forEach(([key, name]) => {
    onSnapshot(query(collection(db, name)), (snapshot) => {
      const dataKey = key === "registers" ? "registers" : key;
      state.data[dataKey] = snapshot.docs.map((item) => item.data()).sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
      if (dataKey === "products") syncCartProducts();
      state.loadedCollections.add(key);
      state.loading = false;
      state.firebaseError = "";
      state.lastSync = new Date();
      if (state.user && !hasOpenModal()) renderApp();
    }, (error) => {
      state.loading = false;
      state.firebaseError = error.message || `Falha ao carregar ${name}.`;
      if (state.user) renderApp();
      else renderLogin(state.firebaseError);
    });
  });
}

function syncCartProducts() {
  state.cart = state.cart
    .map((item) => {
      const freshProduct = findById(state.data.products, item.product.id);
      if (!freshProduct) return null;
      return {
        product: freshProduct,
        quantity: Math.min(item.quantity, Number(freshProduct.stockQuantity) || 0),
      };
    })
    .filter((item) => item && item.quantity > 0);
}

function renderLogin(error = "") {
  root.innerHTML = `
    <main class="login-shell">
      <form class="login-card" id="loginForm">
        <img class="login-logo" src="./assets/goregisterlogo.png" alt="GO REGISTER" />
        <h1 class="login-title">GO REGISTER</h1>
        <label class="field">
          <span>Usuario</span>
          <span class="input-wrap">${icon("person")}<input name="username" autocomplete="username" placeholder="Usuario" required /></span>
        </label>
        <label class="field">
          <span>Senha</span>
          <span class="input-wrap">${icon("key")}<input name="password" type="password" autocomplete="current-password" placeholder="Senha" required /></span>
        </label>
        <p class="error">${escapeHtml(error)}</p>
        <button class="btn full" type="submit">Entrar</button>
      </form>
    </main>
  `;

  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await login(form.get("username"), form.get("password"));
  });

}

async function login(username, password) {
  try {
    await createInitialUsers();
    const snap = await getDocs(collection(db, collections.users));
    const user = snap.docs.map((item) => item.data()).find((item) => item.username === username && item.passwordHash === password && item.isActive !== false);
    if (!user) {
      renderLogin("Usuario ou senha invalidos");
      return;
    }
    state.user = user;
    state.firebaseError = "";
    localStorage.setItem("goRegisterUser", JSON.stringify(user));
    renderApp();
  } catch (error) {
    state.firebaseError = error.message || "Falha ao entrar.";
    renderLogin(state.firebaseError);
  }
}

function logout() {
  state.user = null;
  localStorage.removeItem("goRegisterUser");
  state.cart = [];
  renderLogin();
}

function renderApp(focusId = null) {
  enforceAccess();
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <img src="./assets/goregisterlogo.png" alt="" />
          <strong>GO REGISTER</strong>
        </div>
        <nav class="nav">
          ${availableNavItems().map(([id, label, glyph]) => `<button data-view="${id}" class="${state.view === id ? "active" : ""}">${icon(glyph)} ${label}</button>`).join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="sync-pill ${state.firebaseError ? "bad" : isReady() ? "good" : ""}">
            <span></span>
            ${escapeHtml(syncLabel())}
          </div>
          <div class="user-pill"><strong>${escapeHtml(state.user.username)}</strong>${escapeHtml(roleLabel(state.user.role))}</div>
          <button class="btn secondary" id="logoutBtn">${icon("logout")} Sair</button>
        </div>
      </aside>
      <main class="main">
        ${renderView()}
      </main>
    </div>
    <div id="modalRoot"></div>
  `;

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      state.search = "";
      window.location.hash = `/${state.view}`;
      renderApp();
    });
  });
  document.querySelector("#logoutBtn").addEventListener("click", logout);
  bindViewEvents();
  if (focusId) {
    const field = document.querySelector(`#${focusId}`);
    field?.focus();
    field?.setSelectionRange?.(field.value.length, field.value.length);
  }
}

function renderView() {
  const title = [...navItems, ["stockHistory", "Historico Estoque"], ["cashHistory", "Historico Caixa"], ["categories", "Categorias"], ["suppliers", "Fornecedores"], ["users", "Usuarios"], ["reports", "Relatorios"]].find(([id]) => id === state.view)?.[1] || "Painel";
  const actions = renderTopActions();
  return `
    <header class="topbar">
      <h1>${title}</h1>
      <div>${actions}</div>
    </header>
    ${state.firebaseError ? `<div class="notice error-notice">${icon("error")} ${escapeHtml(state.firebaseError)}</div>` : ""}
    ${!isReady() ? `<div class="notice">${icon("sync")} Carregando dados...</div>` : ""}
    ${views[state.view]()}
  `;
}

function renderTopActions() {
  if (!canAccess(state.view)) return "";
  if (state.view === "inventory") return `<button class="btn" data-action="product-new">${icon("add")} Produto</button>`;
  if (state.view === "stockHistory") return `<button class="btn" data-action="stock-adjust">${icon("tune")} Ajustar Estoque</button>`;
  if (state.view === "categories") return `<button class="btn" data-action="category-new">${icon("add")} Categoria</button>`;
  if (state.view === "suppliers") return `<button class="btn" data-action="supplier-new">${icon("add")} Fornecedor</button>`;
  if (state.view === "users" && state.user.role === "ADMIN") return `<button class="btn" data-action="user-new">${icon("add")} Usuario</button>`;
  return "";
}

const views = {
  dashboard: renderDashboard,
  pos: renderPos,
  inventory: renderInventory,
  stockHistory: renderStockHistory,
  cash: renderCash,
  cashHistory: renderCashHistory,
  categories: renderCategories,
  suppliers: renderSuppliers,
  users: renderUsers,
  reports: renderReports,
  settings: renderSettings,
};

function allTransactions() {
  const saleRows = state.data.sales.map((item) => ({
    id: item.sale?.id,
    kind: "sale",
    title: "Venda",
    subtitle: paymentLabels[item.sale?.paymentMethod] || "Pagamento",
    amount: Number(item.sale?.finalAmount) || 0,
    timestamp: Number(item.sale?.timestamp) || 0,
    isCancelled: Boolean(item.sale?.isCancelled),
    method: item.sale?.paymentMethod,
    refId: item.sale?.id,
  }));
  const entries = state.data.entries.map((item) => ({
    id: item.id,
    kind: "entry",
    title: item.description || "Entrada",
    subtitle: item.category || paymentLabels[item.paymentMethod] || "Entrada",
    amount: Number(item.amount) || 0,
    timestamp: Number(item.timestamp) || 0,
    isCancelled: Boolean(item.isCancelled),
    method: item.paymentMethod,
    refId: item.id,
  }));
  const exits = state.data.exits.map((item) => ({
    id: item.id,
    kind: "exit",
    title: item.description || "Saida",
    subtitle: item.category || paymentLabels[item.paymentMethod] || "Saida",
    amount: Number(item.amount) || 0,
    timestamp: Number(item.timestamp) || 0,
    isCancelled: Boolean(item.isCancelled),
    method: item.paymentMethod,
    refId: item.id,
  }));
  return [...saleRows, ...entries, ...exits].sort((a, b) => b.timestamp - a.timestamp);
}

function renderDashboard() {
  const [todayStart, todayEnd] = todayBounds();
  const [yesterdayStart, yesterdayEnd] = todayBounds(-1);
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const transactions = allTransactions();
  const income = (start, end) => transactions
    .filter((item) => !item.isCancelled && item.kind !== "exit" && item.timestamp >= start && item.timestamp < end)
    .reduce((sum, item) => sum + item.amount, 0);
  const totalToday = income(todayStart, todayEnd);
  const yesterday = income(yesterdayStart, yesterdayEnd);
  const weekly = income(weekStart, todayEnd);
  const comparison = yesterday > 0 ? ((totalToday - yesterday) / yesterday) * 100 : 0;
  const todayCount = transactions.filter((item) => item.kind === "sale" && item.timestamp >= todayStart && item.timestamp < todayEnd).length;
  const lowStock = state.data.products.filter((item) => Number(item.stockQuantity) <= Number(item.minStockThreshold));

  return `
    <section class="section">
      <div class="grid cols-3">
        <article class="panel metric primary">
          <span>Rendimento do Dia</span>
          <strong>${money.format(totalToday)}</strong>
          <small>${comparison >= 0 ? "↑" : "↓"} ${Math.abs(comparison).toFixed(1)}% em relacao a ontem</small>
        </article>
        <article class="panel metric secondary">
          <span>Rendimento Semanal</span>
          <strong>${money.format(weekly)}</strong>
        </article>
        <article class="panel metric tertiary">
          <span>Transacoes Hoje</span>
          <strong>${todayCount}</strong>
        </article>
      </div>
      <div class="grid cols-2">
        <section class="panel">
          <h2>Extrato Recente</h2>
          <div class="transactions">
            ${transactions.slice(0, 8).map(renderTransactionRow).join("") || `<p class="muted">Nenhuma transacao registrada.</p>`}
          </div>
        </section>
        <section class="panel">
          <h2>Produtos com Baixo Estoque</h2>
          <div class="transactions">
            ${lowStock.map((item) => `
              <div class="transaction-row">
                <div><strong>${escapeHtml(item.name)}</strong><div class="muted">EAN: ${escapeHtml(item.barcode || "-")}</div></div>
                <strong class="amount minus">${Number(item.stockQuantity) || 0} ${escapeHtml(item.unit || "UN")}</strong>
              </div>
            `).join("") || `<p class="muted">Nenhum produto com estoque baixo.</p>`}
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderTransactionRow(item) {
  const sign = item.kind === "exit" ? "-" : "+";
  const klass = item.kind === "exit" ? "minus" : "plus";
  return `
    <div class="transaction-row">
      <div>
        <strong>${escapeHtml(item.title)} ${item.isCancelled ? `<span class="badge bad">CANCELADA</span>` : ""}</strong>
        <div class="muted">${escapeHtml(item.subtitle)} · ${item.timestamp ? dateTime.format(new Date(item.timestamp)) : "-"}</div>
      </div>
      <div class="row-actions">
        <strong class="amount ${klass}">${sign} ${money.format(item.amount)}</strong>
        ${!item.isCancelled ? `<button class="icon-btn" title="Cancelar" data-cancel-kind="${item.kind}" data-cancel-id="${item.refId}">${icon("cancel")}</button>` : ""}
      </div>
    </div>
  `;
}

function renderPos() {
  const openRegister = state.data.registers.find((item) => item.isOpen);
  if (!openRegister) {
    return `<section class="panel" style="min-height: 420px; display:grid; place-items:center;"><div style="text-align:center">${icon("shopping_cart")}<h2>Por favor, ABRA o caixa primeiro!</h2><button class="btn" data-action="open-register">${icon("lock_open")} Abrir Caixa</button></div></section>`;
  }
  const filtered = state.data.products.filter((item) => `${item.name} ${item.barcode || ""}`.toLowerCase().includes(state.search.toLowerCase()));
  const total = state.cart.reduce((sum, item) => sum + item.product.sellingPrice * item.quantity, 0);
  const finalTotal = Math.max(0, total - state.discount);
  return `
    <section class="panel pos-layout">
      <div class="pos-products">
        <label class="field search"><span>Pesquisar</span><span class="input-wrap">${icon("search")}<input id="posSearch" value="${escapeHtml(state.search)}" placeholder="Pesquisar por nome ou codigo..." /></span></label>
        <h3>Produtos Disponiveis</h3>
        <div class="product-list">
          ${filtered.map((product) => {
            const out = Number(product.stockQuantity) <= 0;
            return `
              <button class="product-row ${out ? "out" : ""}" data-add-cart="${product.id}" ${out ? "disabled" : ""}>
                <span><strong>${escapeHtml(product.name)}</strong><span class="muted"><br>${money.format(product.sellingPrice || 0)} / ${escapeHtml(product.unit || "UN")} · Estoque: ${Number(product.stockQuantity) || 0}</span></span>
                ${out ? `<span class="badge bad">ESGOTADO</span>` : icon("add")}
              </button>
            `;
          }).join("") || `<p class="muted">Nenhum produto encontrado.</p>`}
        </div>
      </div>
      <aside class="pos-cart">
        <div class="toolbar"><h3>Resumo do Pedido</h3>${state.cart.length ? `<button class="btn danger" data-action="cart-clear">${icon("delete_sweep")} Limpar</button>` : ""}</div>
        <div class="cart-list">
          ${state.cart.map((item) => `
            <div class="cart-row">
              <div>
                <strong>${escapeHtml(item.product.name)}</strong>
                <div class="muted">${money.format(item.product.sellingPrice || 0)} / ${escapeHtml(item.product.unit || "UN")} · subtotal ${money.format((item.product.sellingPrice || 0) * item.quantity)}</div>
                <label class="qty-field"><span>Qtd</span><input value="${formatDecimalInput(item.quantity)}" inputmode="decimal" data-qty-input="${item.product.id}" /></label>
              </div>
              <div class="row-actions">
                <button class="icon-btn" title="Diminuir" data-qty-minus="${item.product.id}">${icon("remove")}</button>
                <button class="icon-btn" title="Aumentar" data-qty-plus="${item.product.id}">${icon("add")}</button>
                <button class="icon-btn" title="Remover" data-remove-cart="${item.product.id}">${icon("delete")}</button>
              </div>
            </div>
          `).join("") || `<p class="muted">Carrinho vazio.</p>`}
        </div>
        <div class="cart-total">
          <label class="field"><span>Desconto</span><span class="input-wrap">${icon("sell")}<input id="discountInput" inputmode="decimal" value="${formatDecimalInput(state.discount)}" /></span></label>
          <div class="total-line"><span>Subtotal</span><span>${money.format(total)}</span></div>
          <div class="total-line"><span>Total</span><span>${money.format(finalTotal)}</span></div>
          <button class="btn full" data-action="checkout" ${state.cart.length ? "" : "disabled"}>${icon("done")} FINALIZAR VENDA</button>
        </div>
      </aside>
    </section>
  `;
}

function renderInventory() {
  const rows = state.data.products.filter((item) => `${item.name} ${item.barcode || ""}`.toLowerCase().includes(state.search.toLowerCase()));
  return tableSection("inventorySearch", ["Produto", "Categoria", "Fornecedor", "Preco", "Estoque", ""], rows.map((item) => {
    const category = state.data.categories.find((cat) => Number(cat.id) === Number(item.categoryId));
    const supplier = state.data.suppliers.find((sup) => Number(sup.id) === Number(item.supplierId));
    const low = Number(item.stockQuantity) <= Number(item.minStockThreshold);
    return `
      <tr>
        <td><strong>${escapeHtml(item.name)}</strong><div class="muted">EAN: ${escapeHtml(item.barcode || "-")}</div></td>
        <td>${escapeHtml(category?.name || "-")}</td>
        <td>${escapeHtml(supplier?.name || "-")}</td>
        <td>${money.format(item.sellingPrice || 0)}</td>
        <td><span class="badge ${low ? "warn" : "good"}">${Number(item.stockQuantity) || 0} ${escapeHtml(item.unit || "UN")}</span></td>
        <td><button class="icon-btn" data-edit-product="${item.id}" title="Editar">${icon("edit")}</button><button class="icon-btn" data-delete-product="${item.id}" title="Excluir">${icon("delete")}</button></td>
      </tr>
    `;
  }).join(""));
}

function renderStockHistory() {
  const rows = state.data.stockMovements
    .filter((item) => {
      const product = findById(state.data.products, item.productId);
      return `${product?.name || ""} ${item.reason || ""}`.toLowerCase().includes(state.search.toLowerCase());
    })
    .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

  return tableSection("genericSearch", ["Data", "Produto", "Tipo", "Quantidade", "Motivo"], rows.map((item) => {
    const product = findById(state.data.products, item.productId);
    const qty = Number(item.quantity) || 0;
    return `
      <tr>
        <td>${item.timestamp ? dateTime.format(new Date(item.timestamp)) : "-"}</td>
        <td><strong>${escapeHtml(product?.name || `Produto #${item.productId}`)}</strong></td>
        <td><span class="badge ${item.type === "EXIT" ? "bad" : item.type === "ADJUSTMENT" ? "warn" : "good"}">${escapeHtml(item.type || "-")}</span></td>
        <td><strong class="amount ${qty < 0 ? "minus" : "plus"}">${qty > 0 ? "+" : ""}${qty}</strong></td>
        <td>${escapeHtml(item.reason || "-")}</td>
      </tr>
    `;
  }).join(""));
}

function tableSection(searchId, headers, rows) {
  return `
    <section class="section">
      <div class="toolbar">
        <label class="field search"><span>Pesquisar</span><span class="input-wrap">${icon("search")}<input id="${searchId}" value="${escapeHtml(state.search)}" placeholder="Pesquisar..." /></span></label>
      </div>
      <div class="panel table-wrap">
        <table>
          <thead><tr>${headers.map((item) => `<th>${item}</th>`).join("")}</tr></thead>
          <tbody>${rows || `<tr><td colspan="${headers.length}" class="muted">Nenhum registro encontrado.</td></tr>`}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderCash() {
  const open = state.data.registers.find((item) => item.isOpen);
  const report = open ? registerReport(open) : null;
  return `
    <section class="section">
      <div class="grid cols-3">
        <article class="panel metric ${open ? "secondary" : "tertiary"}">
          <span>Status do Caixa</span>
          <strong>${open ? "Aberto" : "Fechado"}</strong>
          <small>${open ? `Aberto em ${dateTime.format(new Date(open.openingTimestamp || Date.now()))}` : "Abra o caixa para vender"}</small>
        </article>
        <article class="panel metric primary">
          <span>Saldo Inicial</span>
          <strong>${money.format(open?.initialBalance || 0)}</strong>
        </article>
        <article class="panel metric">
          <span>${open ? "Saldo Esperado" : "Acoes"}</span>
          ${open ? `<strong>${money.format(report.expected)}</strong>` : ""}
          ${open ? `<button class="btn danger" data-action="close-register">${icon("lock")} Fechar Caixa</button>` : `<button class="btn" data-action="open-register">${icon("lock_open")} Abrir Caixa</button>`}
        </article>
      </div>
      <div class="panel">
        <div class="toolbar"><h2>Movimentos Financeiros</h2><div><button class="btn secondary" data-action="entry-new">${icon("add")} Entrada</button> <button class="btn secondary" data-action="exit-new">${icon("remove")} Saida</button></div></div>
        <div class="transactions">${allTransactions().slice(0, 16).map(renderTransactionRow).join("") || `<p class="muted">Sem movimentos.</p>`}</div>
      </div>
    </section>
  `;
}

function registerReport(register) {
  const registerId = Number(register.id);
  const sales = state.data.sales
    .filter((item) => Number(item.sale?.cashRegisterId) === registerId && !item.sale?.isCancelled)
    .reduce((sum, item) => sum + (Number(item.sale?.finalAmount) || 0), 0);
  const entries = state.data.entries
    .filter((item) => Number(item.cashRegisterId) === registerId && !item.isCancelled)
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const exits = state.data.exits
    .filter((item) => Number(item.cashRegisterId) === registerId && !item.isCancelled)
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const expected = (Number(register.initialBalance) || 0) + sales + entries - exits;
  const closing = register.closingBalance == null ? null : Number(register.closingBalance);
  return { sales, entries, exits, expected, closing, difference: closing == null ? null : closing - expected };
}

function renderCashHistory() {
  const rows = [...state.data.registers].sort((a, b) => (Number(b.openingTimestamp) || 0) - (Number(a.openingTimestamp) || 0));
  return `
    <section class="section">
      <div class="panel table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Status</th><th>Abertura</th><th>Fechamento</th><th>Vendas</th><th>Entradas</th><th>Saidas</th><th>Saldo esperado</th><th>Saldo informado</th><th>Diferenca</th></tr></thead>
          <tbody>
            ${rows.map((register) => {
              const report = registerReport(register);
              const diffClass = report.difference == null ? "" : report.difference < 0 ? "bad" : "good";
              return `
                <tr>
                  <td>#${register.id}</td>
                  <td><span class="badge ${register.isOpen ? "good" : ""}">${register.isOpen ? "ABERTO" : "FECHADO"}</span></td>
                  <td>${register.openingTimestamp ? dateTime.format(new Date(register.openingTimestamp)) : "-"}</td>
                  <td>${register.closingTimestamp ? dateTime.format(new Date(register.closingTimestamp)) : "-"}</td>
                  <td>${money.format(report.sales)}</td>
                  <td>${money.format(report.entries)}</td>
                  <td>${money.format(report.exits)}</td>
                  <td><strong>${money.format(report.expected)}</strong></td>
                  <td>${report.closing == null ? "-" : money.format(report.closing)}</td>
                  <td>${report.difference == null ? "-" : `<span class="badge ${diffClass}">${money.format(report.difference)}</span>`}</td>
                </tr>
              `;
            }).join("") || `<tr><td colspan="10" class="muted">Nenhum caixa aberto ainda.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderCategories() {
  return tableSection("genericSearch", ["Nome", ""], state.data.categories
    .filter((item) => item.name.toLowerCase().includes(state.search.toLowerCase()))
    .map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td><button class="icon-btn" data-edit-category="${item.id}">${icon("edit")}</button><button class="icon-btn" data-delete-category="${item.id}">${icon("delete")}</button></td></tr>`).join(""));
}

function renderSuppliers() {
  return tableSection("genericSearch", ["Nome", "Contato", "Email", ""], state.data.suppliers
    .filter((item) => `${item.name} ${item.contact || ""} ${item.email || ""}`.toLowerCase().includes(state.search.toLowerCase()))
    .map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.contact || "-")}</td><td>${escapeHtml(item.email || "-")}</td><td><button class="icon-btn" data-edit-supplier="${item.id}">${icon("edit")}</button><button class="icon-btn" data-delete-supplier="${item.id}">${icon("delete")}</button></td></tr>`).join(""));
}

function renderUsers() {
  return tableSection("genericSearch", ["Usuario", "Perfil", "Status", ""], state.data.users
    .filter((item) => item.username.toLowerCase().includes(state.search.toLowerCase()))
    .map((item) => {
      const isSelf = Number(item.id) === Number(state.user.id);
      const canManage = canManageUser(item);
      return `<tr>
        <td><strong>${escapeHtml(item.username)}</strong>${isSelf ? ` <span class="badge">VOCE</span>` : ""}</td>
        <td>${escapeHtml(roleLabel(item.role))}</td>
        <td><span class="badge ${item.isActive === false ? "bad" : "good"}">${item.isActive === false ? "Inativo" : "Ativo"}</span></td>
        <td>
          ${canManage ? `<button class="icon-btn" data-password-user="${item.id}" title="Alterar senha">${icon("lock")}</button>` : ""}
          ${canManage ? `<button class="icon-btn" data-edit-user="${item.id}" title="Editar">${icon("edit")}</button>` : ""}
          ${!isSelf && canManage ? `<button class="icon-btn" data-toggle-user="${item.id}" title="Ativar/Inativar">${icon("toggle_on")}</button><button class="icon-btn" data-delete-user="${item.id}" title="Excluir">${icon("delete")}</button>` : ""}
        </td>
      </tr>`;
    }).join(""));
}

function renderReports() {
  const sold = state.data.sales.filter((item) => !item.sale?.isCancelled).reduce((sum, item) => sum + (Number(item.sale?.finalAmount) || 0), 0);
  const exits = state.data.exits.filter((item) => !item.isCancelled).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const entries = state.data.entries.filter((item) => !item.isCancelled).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const stockValue = state.data.products.reduce((sum, item) => sum + (Number(item.stockQuantity) || 0) * (Number(item.costPrice) || 0), 0);
  return `
    <section class="section">
      <div class="grid cols-3">
        <article class="panel metric primary"><span>Vendas Registradas</span><strong>${money.format(sold)}</strong></article>
        <article class="panel metric secondary"><span>Entradas Avulsas</span><strong>${money.format(entries)}</strong></article>
        <article class="panel metric tertiary"><span>Saidas</span><strong>${money.format(exits)}</strong></article>
      </div>
      <div class="panel metric"><span>Valor de Custo em Estoque</span><strong>${money.format(stockValue)}</strong></div>
      <div class="panel table-wrap">
        <table><thead><tr><th>Data</th><th>Tipo</th><th>Descricao</th><th>Valor</th></tr></thead><tbody>
          ${allTransactions().map((item) => `<tr><td>${item.timestamp ? dateOnly.format(new Date(item.timestamp)) : "-"}</td><td>${item.kind}</td><td>${escapeHtml(item.title)}</td><td>${money.format(item.amount)}</td></tr>`).join("") || `<tr><td colspan="4">Sem dados.</td></tr>`}
        </tbody></table>
      </div>
    </section>
  `;
}

function renderSettings() {
  return `
    <section class="section">
      <div class="grid cols-2">
        <article class="panel">
          <h2>Personalizacao</h2>
          <p class="muted">Tema visual do site.</p>
          <button class="btn secondary" data-action="theme-toggle">${icon("dark_mode")} Alternar tema</button>
        </article>
        <article class="panel">
          <h2>Nuvem e Backup</h2>
          <p class="muted">${escapeHtml(syncLabel())}</p>
          <button class="btn secondary" data-action="refresh-data">${icon("sync")} Atualizar dados</button>
        </article>
      </div>
      ${isAdmin() ? `
        <div class="panel">
          <h2>Gestao do Sistema</h2>
          <div class="settings-grid">
            <button class="settings-row" data-view="users">${icon("manage_accounts")}<span><strong>Gerenciar Usuarios</strong><small>Criar funcionarios, alterar senhas e status</small></span></button>
            <button class="settings-row" data-view="reports">${icon("monitoring")}<span><strong>Relatorios</strong><small>Resumo financeiro e movimentacoes</small></span></button>
            <button class="settings-row" data-view="cashHistory">${icon("receipt_long")}<span><strong>Historico de Caixa</strong><small>Fechamentos, saldos e diferencas</small></span></button>
            <button class="settings-row" data-view="stockHistory">${icon("history")}<span><strong>Historico de Estoque</strong><small>Entradas, saidas e ajustes</small></span></button>
            <button class="settings-row" data-view="categories">${icon("category")}<span><strong>Categorias</strong><small>Cadastro auxiliar de produtos</small></span></button>
            <button class="settings-row" data-view="suppliers">${icon("local_shipping")}<span><strong>Fornecedores</strong><small>Cadastro auxiliar de produtos</small></span></button>
          </div>
        </div>
      ` : ""}
      <button class="btn danger full" data-action="logout">${icon("logout")} SAIR DO SISTEMA</button>
    </section>
  `;
}

function bindViewEvents() {
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => runNamedAction(button.dataset.action)));
  document.querySelectorAll("#posSearch,#inventorySearch,#genericSearch").forEach((input) => input.addEventListener("input", (event) => {
    state.search = event.target.value;
    renderApp(event.target.id);
  }));
  document.querySelectorAll("[data-add-cart]").forEach((button) => button.addEventListener("click", () => addCart(Number(button.dataset.addCart))));
  document.querySelectorAll("[data-remove-cart]").forEach((button) => button.addEventListener("click", () => removeCart(Number(button.dataset.removeCart))));
  document.querySelectorAll("[data-qty-minus]").forEach((button) => button.addEventListener("click", () => changeCartQty(Number(button.dataset.qtyMinus), -1)));
  document.querySelectorAll("[data-qty-plus]").forEach((button) => button.addEventListener("click", () => changeCartQty(Number(button.dataset.qtyPlus), 1)));
  document.querySelectorAll("[data-qty-input]").forEach((input) => {
    input.addEventListener("change", () => setCartQty(Number(input.dataset.qtyInput), input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        setCartQty(Number(input.dataset.qtyInput), input.value);
      }
    });
  });
  document.querySelectorAll("[data-cancel-kind]").forEach((button) => button.addEventListener("click", () => cancelTransaction(button.dataset.cancelKind, Number(button.dataset.cancelId))));
  document.querySelector("#discountInput")?.addEventListener("input", (event) => {
    state.discount = Math.max(0, parseDecimal(event.target.value));
  });
  bindCrudButtons();
}

function runNamedAction(action) {
  if (adminActions.has(action) && !isAdmin()) {
    toast("Acesso restrito ao administrador.");
    return;
  }
  actions[action]?.();
}

function bindCrudButtons() {
  if (!isAdmin()) return;
  document.querySelectorAll("[data-edit-product]").forEach((button) => button.addEventListener("click", () => openProductModal(findById(state.data.products, button.dataset.editProduct))));
  document.querySelectorAll("[data-delete-product]").forEach((button) => button.addEventListener("click", () => removeDoc(collections.products, button.dataset.deleteProduct)));
  document.querySelectorAll("[data-edit-category]").forEach((button) => button.addEventListener("click", () => openNameModal("Categoria", collections.categories, state.data.categories, findById(state.data.categories, button.dataset.editCategory))));
  document.querySelectorAll("[data-delete-category]").forEach((button) => button.addEventListener("click", () => removeDoc(collections.categories, button.dataset.deleteCategory)));
  document.querySelectorAll("[data-edit-supplier]").forEach((button) => button.addEventListener("click", () => openSupplierModal(findById(state.data.suppliers, button.dataset.editSupplier))));
  document.querySelectorAll("[data-delete-supplier]").forEach((button) => button.addEventListener("click", () => removeDoc(collections.suppliers, button.dataset.deleteSupplier)));
  document.querySelectorAll("[data-edit-user]").forEach((button) => button.addEventListener("click", () => openUserModal(findById(state.data.users, button.dataset.editUser))));
  document.querySelectorAll("[data-delete-user]").forEach((button) => button.addEventListener("click", () => deleteUser(Number(button.dataset.deleteUser))));
  document.querySelectorAll("[data-toggle-user]").forEach((button) => button.addEventListener("click", () => toggleUser(Number(button.dataset.toggleUser))));
  document.querySelectorAll("[data-password-user]").forEach((button) => button.addEventListener("click", () => changeUserPassword(Number(button.dataset.passwordUser))));
}

function findById(items, id) {
  return items.find((item) => Number(item.id) === Number(id));
}

async function removeDoc(collectionName, id) {
  if (!isAdmin() && [collections.products, collections.categories, collections.suppliers, collections.users].includes(collectionName)) {
    toast("Acesso restrito ao administrador.");
    return;
  }
  if (!confirm("Excluir este registro?")) return;
  await runAction(
    () => deleteDoc(doc(db, collectionName, String(id))),
    "Registro excluido."
  );
}

function addCart(productId) {
  const product = findById(state.data.products, productId);
  if (!product) return;
  const existing = state.cart.find((item) => Number(item.product.id) === Number(productId));
  if (existing) {
    if (existing.quantity + 1 > Number(product.stockQuantity || 0)) {
      toast("Quantidade maior que o estoque disponivel.");
      return;
    }
    existing.quantity += 1;
  } else {
    if (Number(product.stockQuantity || 0) < 1) return;
    state.cart.push({ product, quantity: 1 });
  }
  renderApp();
}

function removeCart(productId) {
  state.cart = state.cart.filter((item) => Number(item.product.id) !== Number(productId));
  if (!state.cart.length) state.discount = 0;
  renderApp();
}

function changeCartQty(productId, delta) {
  const item = state.cart.find((cartItem) => Number(cartItem.product.id) === Number(productId));
  if (!item) return;
  const nextQty = item.quantity + delta;
  if (nextQty <= 0) {
    removeCart(productId);
    return;
  }
  if (nextQty > Number(item.product.stockQuantity || 0)) {
    toast("Quantidade maior que o estoque disponivel.");
    return;
  }
  item.quantity = nextQty;
  renderApp();
}

function setCartQty(productId, value) {
  const item = state.cart.find((cartItem) => Number(cartItem.product.id) === Number(productId));
  if (!item) return;
  const nextQty = parseDecimal(value);
  if (nextQty <= 0) {
    removeCart(productId);
    return;
  }
  if (nextQty > Number(item.product.stockQuantity || 0)) {
    toast("Quantidade maior que o estoque disponivel.");
    renderApp();
    return;
  }
  item.quantity = Math.round(nextQty * 1000) / 1000;
  renderApp();
}

function clearCart() {
  state.cart = [];
  state.discount = 0;
  renderApp();
}

const actions = {
  "product-new": () => openProductModal(),
  "category-new": () => openNameModal("Categoria", collections.categories, state.data.categories),
  "supplier-new": () => openSupplierModal(),
  "user-new": () => openUserModal(),
  "stock-adjust": () => openStockAdjustModal(),
  "open-register": () => openRegisterModal(),
  "close-register": () => closeRegister(),
  "entry-new": () => openMovementModal("entry"),
  "exit-new": () => openMovementModal("exit"),
  "cart-clear": () => clearCart(),
  "theme-toggle": () => toggleTheme(),
  "refresh-data": () => renderApp(),
  logout: () => logout(),
  checkout: () => openCheckoutModal(),
};

const adminActions = new Set(["product-new", "category-new", "supplier-new", "user-new", "stock-adjust"]);

function openModal(title, body, onSubmit) {
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop">
      <section class="modal">
        <header><h2>${title}</h2><button class="icon-btn" type="button" data-close-modal>${icon("close")}</button></header>
        <form id="modalForm">${body}<footer><button class="btn secondary" type="button" data-close-modal>Cancelar</button><button class="btn" type="submit">${icon("save")} Salvar</button></footer></form>
      </section>
    </div>
  `;
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  document.querySelector("#modalForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction(async () => {
      await onSubmit(new FormData(event.currentTarget));
      closeModal();
      renderApp();
    });
  });
}

function closeModal() {
  document.querySelector("#modalRoot").innerHTML = "";
}

function input(name, label, value = "", type = "text") {
  const isNumber = type === "number";
  return `<label class="field"><span>${label}</span><span class="input-wrap"><input name="${name}" type="${isNumber ? "text" : type}" ${isNumber ? "inputmode=\"decimal\"" : ""} value="${escapeHtml(isNumber ? formatDecimalInput(value) : value)}" /></span></label>`;
}

function select(name, label, options, value = "") {
  return `<label class="field"><span>${label}</span><span class="input-wrap"><select name="${name}">${options.map(([id, text]) => `<option value="${id}" ${String(id) === String(value) ? "selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select></span></label>`;
}

function openProductModal(product = null) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  const id = product?.id || nextId(state.data.products);
  openModal(product ? "Editar Produto" : "Novo Produto", `
    <div class="form-grid">
      ${input("name", "Nome", product?.name || "")}
      ${input("barcode", "Codigo de barras", product?.barcode || "")}
      ${select("categoryId", "Categoria", [["", "-"], ...state.data.categories.map((item) => [item.id, item.name])], product?.categoryId || "")}
      ${select("supplierId", "Fornecedor", [["", "-"], ...state.data.suppliers.map((item) => [item.id, item.name])], product?.supplierId || "")}
      ${input("costPrice", "Preco de custo", product?.costPrice || 0, "number")}
      ${input("sellingPrice", "Preco de venda", product?.sellingPrice || 0, "number")}
      ${input("stockQuantity", "Estoque", product?.stockQuantity || 0, "number")}
      ${input("minStockThreshold", "Estoque minimo", product?.minStockThreshold || 5, "number")}
      ${input("unit", "Unidade", product?.unit || "UN")}
    </div>
  `, async (form) => {
    const payload = {
      id,
      name: form.get("name"),
      barcode: form.get("barcode") || null,
      categoryId: form.get("categoryId") ? Number(form.get("categoryId")) : null,
      supplierId: form.get("supplierId") ? Number(form.get("supplierId")) : null,
      costPrice: parseDecimal(form.get("costPrice")),
      sellingPrice: parseDecimal(form.get("sellingPrice")),
      stockQuantity: parseDecimal(form.get("stockQuantity")),
      minStockThreshold: parseDecimal(form.get("minStockThreshold")) || 5,
      unit: form.get("unit") || "UN",
    };
    await setDoc(doc(db, collections.products, String(id)), payload);
    toast("Produto salvo.");
  });
}

function openNameModal(title, collectionName, items, item = null) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  const id = item?.id || nextId(items);
  openModal(item ? `Editar ${title}` : `Nova ${title}`, input("name", "Nome", item?.name || ""), async (form) => {
    await setDoc(doc(db, collectionName, String(id)), { id, name: form.get("name") });
    toast(`${title} salva.`);
  });
}

function openSupplierModal(item = null) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  const id = item?.id || nextId(state.data.suppliers);
  openModal(item ? "Editar Fornecedor" : "Novo Fornecedor", `
    ${input("name", "Nome", item?.name || "")}
    ${input("contact", "Contato", item?.contact || "")}
    ${input("email", "Email", item?.email || "", "email")}
  `, async (form) => {
    await setDoc(doc(db, collections.suppliers, String(id)), { id, name: form.get("name"), contact: form.get("contact") || null, email: form.get("email") || null });
    toast("Fornecedor salvo.");
  });
}

function openUserModal(item = null) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  if (item && !canManageUser(item)) return toast("Apenas o administrador mestre pode gerenciar outros administradores.");
  const id = item?.id || nextId(state.data.users);
  const roleOptions = isMasterAdmin()
    ? [["MASTER_ADMIN", "MASTER_ADMIN"], ["ADMIN", "ADMIN"], ["OPERATOR", "OPERATOR"]]
    : [["OPERATOR", "OPERATOR"]];
  openModal(item ? "Editar Usuario" : "Novo Usuario", `
    ${input("username", "Usuario", item?.username || "")}
    ${input("passwordHash", "Senha", item?.passwordHash || "")}
    ${select("role", "Perfil", roleOptions, item?.role || "OPERATOR")}
    ${select("isActive", "Status", [["true", "Ativo"], ["false", "Inativo"]], item?.isActive === false ? "false" : "true")}
  `, async (form) => {
    const role = isMasterAdmin() ? form.get("role") : "OPERATOR";
    await setDoc(doc(db, collections.users, String(id)), {
      id,
      username: form.get("username"),
      passwordHash: form.get("passwordHash"),
      role,
      isActive: form.get("isActive") === "true",
    });
    toast("Usuario salvo.");
  });
}

async function changeUserPassword(userId) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  const user = findById(state.data.users, userId);
  if (!user) return;
  if (!canManageUser(user)) return toast("Apenas o administrador mestre pode alterar senha de administradores.");
  const password = prompt(`Nova senha para ${user.username}:`);
  if (!password) return;
  await runAction(
    () => updateDoc(doc(db, collections.users, String(userId)), { passwordHash: password }),
    "Senha alterada."
  );
}

async function toggleUser(userId) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  if (Number(userId) === Number(state.user.id)) return toast("Voce nao pode inativar seu proprio usuario.");
  const user = findById(state.data.users, userId);
  if (!user) return;
  if (!canManageUser(user)) return toast("Apenas o administrador mestre pode alterar status de administradores.");
  await runAction(
    () => updateDoc(doc(db, collections.users, String(userId)), { isActive: user.isActive === false }),
    user.isActive === false ? "Usuario ativado." : "Usuario inativado."
  );
}

async function deleteUser(userId) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  if (Number(userId) === Number(state.user.id)) return toast("Voce nao pode excluir seu proprio usuario.");
  const user = findById(state.data.users, userId);
  if (!canManageUser(user)) return toast("Apenas o administrador mestre pode excluir administradores.");
  await removeDoc(collections.users, userId);
}

function openRegisterModal() {
  openModal("Abrir Caixa", input("initialBalance", "Saldo inicial", 0, "number"), async (form) => {
    const id = nextId(state.data.registers);
    const register = {
      id,
      openingTimestamp: Date.now(),
      closingTimestamp: null,
      initialBalance: parseDecimal(form.get("initialBalance")),
      closingBalance: null,
      userId: Number(state.user.id) || 0,
      isOpen: true,
    };
    await setDoc(doc(db, collections.registers, String(id)), register);
    state.data.registers = [...state.data.registers.filter((item) => Number(item.id) !== Number(id)), register];
    toast("Caixa aberto.");
  });
}

async function closeRegister() {
  const open = state.data.registers.find((item) => item.isOpen);
  if (!open) return;
  const closing = prompt("Saldo final do caixa:", String(open.initialBalance || 0));
  if (closing === null) return;
  await runAction(async () => {
    const patch = {
      closingTimestamp: Date.now(),
      closingBalance: parseDecimal(closing),
      isOpen: false,
    };
    await updateDoc(doc(db, collections.registers, String(open.id)), patch);
    state.data.registers = state.data.registers.map((item) => Number(item.id) === Number(open.id) ? { ...item, ...patch } : item);
    renderApp();
  }, "Caixa fechado.");
}

function openMovementModal(kind) {
  const isEntry = kind === "entry";
  openModal(isEntry ? "Nova Entrada" : "Nova Saida", `
    ${input("description", "Descricao")}
    ${input("amount", "Valor", 0, "number")}
    ${select("paymentMethod", "Pagamento", Object.entries(paymentLabels), "CASH")}
    ${input("category", "Categoria")}
  `, async (form) => {
    const list = isEntry ? state.data.entries : state.data.exits;
    const collectionName = isEntry ? collections.entries : collections.exits;
    const open = state.data.registers.find((item) => item.isOpen);
    const id = nextId(list);
    await setDoc(doc(db, collectionName, String(id)), {
      id,
      timestamp: Date.now(),
      description: form.get("description"),
      amount: parseDecimal(form.get("amount")),
      paymentMethod: form.get("paymentMethod"),
      category: form.get("category") || null,
      cashRegisterId: Number(open?.id) || 0,
      isCancelled: false,
    });
    toast("Movimento salvo.");
  });
}

function openStockAdjustModal() {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  openModal("Ajustar Estoque", `
    ${select("productId", "Produto", state.data.products.map((item) => [item.id, `${item.name} (${item.stockQuantity} ${item.unit || "UN"})`]), "")}
    ${select("type", "Tipo", [["ENTRY", "Entrada"], ["EXIT", "Saida"], ["ADJUSTMENT", "Ajuste absoluto"]], "ENTRY")}
    ${input("quantity", "Quantidade", 1, "number")}
    ${input("reason", "Motivo", "Ajuste manual")}
  `, async (form) => {
    const product = findById(state.data.products, form.get("productId"));
    if (!product) throw new Error("Selecione um produto.");
    const type = form.get("type");
    const rawQty = Math.max(0, parseDecimal(form.get("quantity")));
    const current = Number(product.stockQuantity) || 0;
    const movementQty = type === "EXIT" ? -rawQty : type === "ADJUSTMENT" ? rawQty - current : rawQty;
    const nextStock = type === "ADJUSTMENT" ? rawQty : current + movementQty;
    if (nextStock < 0) throw new Error("Estoque nao pode ficar negativo.");
    await updateProductStock(product.id, nextStock);
    await saveStockMovement(product.id, movementQty, type, form.get("reason") || "Ajuste manual");
  });
}

function openCheckoutModal() {
  openModal("Forma de Pagamento", select("paymentMethod", "Pagamento", Object.entries(paymentLabels), "CASH"), async (form) => {
    await checkout(form.get("paymentMethod"));
  });
}

async function cancelTransaction(kind, id) {
  const password = prompt("Senha do administrador para cancelar:");
  if (password === null) return;
  if (password !== "1234") {
    toast("Senha de administrador incorreta.");
    return;
  }
  await runAction(async () => {
    if (kind === "sale") {
      const record = state.data.sales.find((item) => Number(item.sale?.id) === Number(id));
      if (!record) throw new Error("Venda nao encontrada.");
      await updateDoc(doc(db, collections.sales, String(id)), { "sale.isCancelled": true });
      await Promise.all((record.items || []).map(async (item) => {
        const product = findById(state.data.products, item.productId);
        if (!product) return;
        const restored = (Number(product.stockQuantity) || 0) + (Number(item.quantity) || 0);
        await updateProductStock(product.id, restored);
        await saveStockMovement(product.id, Number(item.quantity) || 0, "ENTRY", `Cancelamento venda #${id}`);
      }));
    }
    if (kind === "entry") {
      await updateDoc(doc(db, collections.entries, String(id)), { isCancelled: true });
    }
    if (kind === "exit") {
      await updateDoc(doc(db, collections.exits, String(id)), { isCancelled: true });
    }
  }, "Transacao cancelada.");
}

async function checkout(paymentMethod) {
  const open = state.data.registers.find((item) => item.isOpen);
  if (!open || !state.cart.length) return;
  const id = nextId(state.data.sales.map((item) => item.sale || {}));
  const total = state.cart.reduce((sum, item) => sum + item.product.sellingPrice * item.quantity, 0);
  const discount = Math.min(Math.max(0, parseDecimal(state.discount)), total);
  const sale = {
    id,
    timestamp: Date.now(),
    totalAmount: total,
    discount,
    finalAmount: total - discount,
    paymentMethod,
    userId: Number(state.user.id) || 0,
    cashRegisterId: Number(open.id) || 0,
    isCancelled: false,
  };
  const items = state.cart.map((item, index) => ({
    id: id * 1000 + index + 1,
    saleId: id,
    productId: Number(item.product.id),
    quantity: item.quantity,
    unitPrice: Number(item.product.sellingPrice) || 0,
    subtotal: (Number(item.product.sellingPrice) || 0) * item.quantity,
  }));
  await setDoc(doc(db, collections.sales, String(id)), { sale, items });
  await Promise.all(state.cart.map((item) => {
    const updatedStock = Math.max(0, (Number(item.product.stockQuantity) || 0) - item.quantity);
    return Promise.all([
      updateProductStock(item.product.id, updatedStock),
      saveStockMovement(item.product.id, -item.quantity, "EXIT", `Venda #${id}`),
    ]);
  }));
  state.cart = [];
  state.discount = 0;
  toast("Venda finalizada.");
  renderApp();
}

async function updateProductStock(productId, stockQuantity) {
  await updateDoc(doc(db, collections.products, String(productId)), { stockQuantity });
}

async function saveStockMovement(productId, quantity, type, reason) {
  const id = nextId(state.data.stockMovements);
  await setDoc(doc(db, collections.stockMovements, String(id)), {
    id,
    productId: Number(productId),
    timestamp: Date.now(),
    quantity,
    type,
    reason,
  });
}

async function init() {
  applyTheme();
  state.view = getRouteView();
  renderLogin();
  subscribe();
  if (state.user) renderApp();
}

window.addEventListener("hashchange", () => {
  const nextView = getRouteView();
  if (state.view !== nextView) {
    state.view = nextView;
    state.search = "";
    enforceAccess();
    if (state.user) renderApp();
  }
});

init();

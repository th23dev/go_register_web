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
  user: null,
  session: JSON.parse(localStorage.getItem("goRegisterSession") || "null"),
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
  filters: {
    cashHistoryDate: "",
    reportsPeriod: "all",
    reportsDate: new Date().toISOString().slice(0, 10),
    reportsMonth: new Date().getMonth(),
  },
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
  CREDIT_CARD: "Cartao de Credito",
  CREDIT_CREDIT: "Cartao de Credito",
};

const transactionKindLabels = {
  sale: "Venda",
  entry: "Entrada",
  exit: "Saida",
};

const stockTypeLabels = {
  ENTRY: "Entrada",
  EXIT: "Saida",
  ADJUSTMENT: "Ajuste",
};

function transactionKindLabel(kind) {
  return transactionKindLabels[kind] || kind || "-";
}

function stockTypeLabel(type) {
  return stockTypeLabels[type] || type || "-";
}

function saleData(record) {
  return record?.sale && typeof record.sale === "object" ? { ...record, ...record.sale } : record || {};
}

function normalizeTimestamp(value) {
  if (!value) return 0;
  if (typeof value === "number") return value > 0 && value < 100000000000 ? value * 1000 : value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object") {
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.seconds === "number") return value.seconds * 1000 + Math.floor((Number(value.nanoseconds) || 0) / 1000000);
    if (typeof value._seconds === "number") return value._seconds * 1000 + Math.floor((Number(value._nanoseconds) || 0) / 1000000);
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed > 0 && parsed < 100000000000 ? parsed * 1000 : parsed;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function saleTimestamp(record) {
  const sale = saleData(record);
  return normalizeTimestamp(sale.timestamp ?? sale.createdAt ?? sale.created_at ?? record?.timestamp ?? record?.createdAt ?? record?.created_at);
}

function saleItems(record) {
  const sale = saleData(record);
  return record?.items || sale.items || record?.saleItems || sale.saleItems || record?.sale_items || sale.sale_items || [];
}

function saleIsCancelled(record) {
  const sale = saleData(record);
  return Boolean(sale.isCancelled ?? record?.isCancelled);
}

function saleAmount(record) {
  const sale = saleData(record);
  return Number(sale.finalAmount ?? sale.final_amount ?? sale.totalAmount ?? sale.total_amount ?? sale.amount ?? record?.finalAmount ?? record?.final_amount ?? record?.totalAmount ?? record?.total_amount ?? record?.amount) || 0;
}

function paymentMethodValue(record) {
  const sale = saleData(record);
  const raw = sale.paymentMethod ?? sale.payment_method ?? record?.paymentMethod ?? record?.payment_method ?? record?.method;
  if (raw && typeof raw === "object") {
    return normalizePaymentMethod(raw.name ?? raw.value ?? raw.id ?? raw.label ?? "");
  }
  return normalizePaymentMethod(raw || "");
}

function normalizePaymentMethod(value) {
  const normalized = String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
  const aliases = {
    DINHEIRO: "CASH",
    CARTAO_DE_DEBITO: "DEBIT_CARD",
    CARTAO_DE_CREDITO: "CREDIT_CARD",
    CREDITO: "CREDIT_CARD",
    DEBITO: "DEBIT_CARD",
  };
  return aliases[normalized] || normalized;
}

function paymentMethodLabel(recordOrMethod) {
  const method = typeof recordOrMethod === "string" ? normalizePaymentMethod(recordOrMethod) : paymentMethodValue(recordOrMethod);
  return paymentLabels[method] || method || "Pagamento";
}

function safeSessionUser(user) {
  if (!user) return null;
  const { passwordHash, sessionToken, ...safeUser } = user;
  return safeUser;
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const encoded = new TextEncoder().encode(text);
  return bufferToHex(await crypto.subtle.digest("SHA-256", encoded));
}

function isModernPasswordHash(value) {
  return /^sha256\$[a-f0-9]{32,}\$[a-f0-9]{64}$/i.test(String(value || ""));
}

async function hashPassword(password, salt = randomToken()) {
  const hash = await sha256Hex(`${salt}:${password}`);
  return `sha256$${salt}$${hash}`;
}

async function verifyPassword(password, storedHash) {
  const value = String(storedHash || "");
  if (!isModernPasswordHash(value)) return value === String(password || "");
  const [, salt, expectedHash] = value.split("$");
  return await sha256Hex(`${salt}:${password}`) === expectedHash;
}

function dateGroupKey(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return "no-date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "no-date";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateGroupLabel(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return "Sem data";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Sem data" : dateOnly.format(date);
}

function renderGroupedByDate(items, renderItem, renderDivider) {
  let currentDate = "";
  return items.map((item) => {
    const key = dateGroupKey(item.timestamp);
    const divider = key !== currentDate ? renderDivider(dateGroupLabel(item.timestamp)) : "";
    currentDate = key;
    return `${divider}${renderItem(item)}`;
  }).join("");
}

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
  return Math.max(0, ...items.map((item) => Number(item.id ?? item.docId) || 0)) + 1;
}

function todayBounds(offset = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offset);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.getTime(), end.getTime()];
}

function dateInputBounds(value) {
  if (!value) return null;
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return null;
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.getTime(), end.getTime()];
}

function formatDateInputLabel(value) {
  const bounds = dateInputBounds(value);
  return bounds ? dateOnly.format(new Date(bounds[0])) : "";
}

function reportFilterBounds() {
  const now = new Date();
  if (state.filters.reportsPeriod === "daily") return todayBounds();
  if (state.filters.reportsPeriod === "specificDate") return dateInputBounds(state.filters.reportsDate) || todayBounds();
  if (state.filters.reportsPeriod === "weekly") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 7);
    return [start.getTime(), now.getTime()];
  }
  if (state.filters.reportsPeriod === "monthly") {
    const monthIndex = Number(state.filters.reportsMonth) || 0;
    const start = new Date(now.getFullYear(), monthIndex, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), monthIndex + 1, 1, 0, 0, 0, 0);
    return [start.getTime(), end.getTime()];
  }
  return null;
}

function inBounds(timestamp, bounds) {
  if (!bounds) return true;
  const value = Number(timestamp) || 0;
  return value >= bounds[0] && value < bounds[1];
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

function subscribe() {
  Object.entries(collections).forEach(([key, name]) => {
    onSnapshot(query(collection(db, name)), (snapshot) => {
      const dataKey = key === "registers" ? "registers" : key;
      state.data[dataKey] = snapshot.docs.map((item) => ({ ...item.data(), docId: item.id })).sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
      if (dataKey === "products") syncCartProducts();
      if (dataKey === "users") syncSessionUser();
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

function syncSessionUser() {
  if (!state.session?.userId || !state.session?.sessionToken) return;
  const user = findById(state.data.users, state.session.userId);
  if (!user || user.isActive === false || user.sessionToken !== state.session.sessionToken) {
    state.user = null;
    state.session = null;
    localStorage.removeItem("goRegisterSession");
    return;
  }
  state.user = safeSessionUser(user);
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
    const snap = await getDocs(collection(db, collections.users));
    const users = snap.docs.map((item) => ({ ...item.data(), docId: item.id }));
    if (!users.length) {
      await createFirstMasterAdmin(username, password);
      return;
    }
    const user = users.find((item) => item.username === username && item.isActive !== false);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      renderLogin("Usuario ou senha invalidos");
      return;
    }
    const sessionToken = randomToken();
    const patch = { sessionToken, lastLoginAt: Date.now() };
    if (!isModernPasswordHash(user.passwordHash)) patch.passwordHash = await hashPassword(password);
    if (user.username === "admin" && user.role !== "MASTER_ADMIN") patch.role = "MASTER_ADMIN";
    await updateDoc(doc(db, collections.users, user.docId), patch);
    const loggedUser = { ...user, ...patch };
    state.user = safeSessionUser(loggedUser);
    state.session = { userId: Number(loggedUser.id), sessionToken };
    state.firebaseError = "";
    localStorage.setItem("goRegisterSession", JSON.stringify(state.session));
    localStorage.removeItem("goRegisterUser");
    renderApp();
  } catch (error) {
    state.firebaseError = error.message || "Falha ao entrar.";
    renderLogin(state.firebaseError);
  }
}

async function createFirstMasterAdmin(username, password) {
  const normalizedUsername = String(username || "").trim();
  if (normalizedUsername.length < 3 || String(password || "").length < 6) {
    renderLogin("Primeiro acesso: informe usuario com 3+ caracteres e senha com 6+ caracteres.");
    return;
  }
  const sessionToken = randomToken();
  const user = {
    id: 1,
    username: normalizedUsername,
    passwordHash: await hashPassword(password),
    role: "MASTER_ADMIN",
    isActive: true,
    sessionToken,
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
  };
  await setDoc(doc(db, collections.users, "1"), user);
  state.user = safeSessionUser(user);
  state.session = { userId: 1, sessionToken };
  state.firebaseError = "";
  localStorage.setItem("goRegisterSession", JSON.stringify(state.session));
  localStorage.removeItem("goRegisterUser");
  renderApp();
}

async function authorizeAdminCredentials(username, password) {
  const user = state.data.users.find((item) => item.username === username && item.isActive !== false && isPrivilegedRole(item.role));
  if (!user) {
    return false;
  }
  return await verifyPassword(password, user.passwordHash);
}

async function requestAdminAuthorization() {
  const defaultUsername = isAdmin() ? state.user.username : "";
  const username = prompt("Usuario administrador:", defaultUsername);
  if (username === null) return false;
  const password = prompt("Senha do administrador:");
  if (password === null) return false;
  const allowed = await authorizeAdminCredentials(username.trim(), password);
  if (!allowed) toast("Credenciais de administrador invalidas.");
  return allowed;
}

function logout() {
  state.user = null;
  state.session = null;
  localStorage.removeItem("goRegisterSession");
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
  if (state.view === "users" && isAdmin()) return `<button class="btn" data-action="user-new">${icon("add")} Usuario</button>`;
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
  const saleRows = state.data.sales.map((item) => {
    const sale = saleData(item);
    const saleId = sale.id ?? item.docId;
    return {
      id: saleId,
      kind: "sale",
      title: saleTransactionTitle(item),
      subtitle: `${paymentMethodLabel(item)} - Venda #${saleId ?? "-"}`,
      amount: saleAmount(item),
      timestamp: saleTimestamp(item),
      isCancelled: saleIsCancelled(item),
      method: paymentMethodValue(item),
      refId: saleId,
    };
  });
  const entries = state.data.entries.map((item) => ({
    id: item.id,
    kind: "entry",
    title: item.description || "Entrada",
    subtitle: item.category || paymentMethodLabel(item.paymentMethod),
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
    subtitle: item.category || paymentMethodLabel(item.paymentMethod),
    amount: Number(item.amount) || 0,
    timestamp: Number(item.timestamp) || 0,
    isCancelled: Boolean(item.isCancelled),
    method: item.paymentMethod,
    refId: item.id,
  }));
  return [...saleRows, ...entries, ...exits].sort((a, b) => b.timestamp - a.timestamp);
}

function saleTransactionTitle(record) {
  const products = saleProductNames(record);
  if (products && products !== "N/A") return products;
  return `Venda #${saleData(record).id ?? record?.docId ?? "-"}`;
}

function renderDashboard() {
  const [todayStart, todayEnd] = todayBounds();
  const [yesterdayStart, yesterdayEnd] = todayBounds(-1);
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const transactions = allTransactions();
  const netIncome = (start, end) => transactions
    .filter((item) => !item.isCancelled && item.timestamp >= start && item.timestamp < end)
    .reduce((sum, item) => sum + (item.kind === "exit" ? -item.amount : item.amount), 0);
  const totalToday = netIncome(todayStart, todayEnd);
  const yesterday = netIncome(yesterdayStart, yesterdayEnd);
  const weekly = netIncome(weekStart, todayEnd);
  const todayCents = Math.round(totalToday * 100);
  const yesterdayCents = Math.round(yesterday * 100);
  const comparison = yesterdayCents === 0 ? null : ((totalToday - yesterday) / yesterday) * 100;
  const comparisonText = comparison === null
    ? (todayCents === 0 ? "Sem variacao em relacao a ontem" : "Sem base de comparacao ontem")
    : `${comparison >= 0 ? "↑" : "↓"} ${Math.abs(comparison).toFixed(1)}% em relacao a ontem`;
  const todayCount = transactions.filter((item) => !item.isCancelled && item.timestamp >= todayStart && item.timestamp < todayEnd).length;
  const lowStock = state.data.products.filter((item) => Number(item.stockQuantity) <= Number(item.minStockThreshold));

  return `
    <section class="section">
      <div class="grid cols-3 dashboard-metrics">
        <article class="panel metric primary">
          <span>Rendimento do Dia</span>
          <strong>${money.format(totalToday)}</strong>
          <small>${comparisonText}</small>
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
      <div class="grid cols-2 dashboard-content">
        <section class="panel">
          <h2>Extrato Recente</h2>
          <div class="transactions transactions-scroll transactions-scroll--recent">
            ${renderGroupedTransactionRows(transactions) || `<p class="muted">Nenhuma transacao registrada.</p>`}
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
  const cancelledClass = item.isCancelled ? " transaction-row--cancelled" : "";
  return `
    <div class="transaction-row${cancelledClass}">
      <div>
        <strong><span class="transaction-title">${escapeHtml(item.title)}</span> ${item.isCancelled ? `<span class="badge bad">CANCELADA</span>` : ""}</strong>
        <div class="muted">${escapeHtml(item.subtitle)} · ${item.timestamp ? dateTime.format(new Date(item.timestamp)) : "-"}</div>
      </div>
      <div class="row-actions">
        <strong class="amount ${klass}">${sign} ${money.format(item.amount)}</strong>
        ${!item.isCancelled ? `<button class="icon-btn" title="Cancelar" data-cancel-kind="${item.kind}" data-cancel-id="${item.refId}">${icon("cancel")}</button>` : ""}
      </div>
    </div>
  `;
}

function renderTransactionDateDivider(label) {
  return `<div class="date-divider"><span>${escapeHtml(label)}</span></div>`;
}

function renderGroupedTransactionRows(transactions) {
  return renderGroupedByDate(transactions, renderTransactionRow, renderTransactionDateDivider);
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
        <td><span class="badge ${item.type === "EXIT" ? "bad" : item.type === "ADJUSTMENT" ? "warn" : "good"}">${escapeHtml(stockTypeLabel(item.type))}</span></td>
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
        <div class="transactions transactions-scroll transactions-scroll--cash">${renderGroupedTransactionRows(allTransactions()) || `<p class="muted">Sem movimentos.</p>`}</div>
      </div>
    </section>
  `;
}

function registerReport(register) {
  const registerId = Number(register.id);
  const sales = state.data.sales
    .filter((item) => {
      const sale = saleData(item);
      return Number(sale.cashRegisterId) === registerId && !saleIsCancelled(item);
    })
    .reduce((sum, item) => sum + saleAmount(item), 0);
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
  const bounds = dateInputBounds(state.filters.cashHistoryDate);
  const rows = [...state.data.registers]
    .filter((item) => inBounds(item.openingTimestamp, bounds))
    .sort((a, b) => (Number(b.openingTimestamp) || 0) - (Number(a.openingTimestamp) || 0));
  return `
    <section class="section">
      <div class="toolbar filters-toolbar">
        <label class="field date-filter">
          <span>${state.filters.cashHistoryDate ? `Filtrando: ${formatDateInputLabel(state.filters.cashHistoryDate)}` : "Filtrar por data"}</span>
          <span class="input-wrap">${icon("calendar_month")}<input id="cashHistoryDate" type="date" value="${escapeHtml(state.filters.cashHistoryDate)}" /></span>
        </label>
        ${state.filters.cashHistoryDate ? `<button class="btn secondary" data-action="clear-cash-history-filter">${icon("filter_list_off")} Limpar filtro</button>` : ""}
      </div>
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
            }).join("") || `<tr><td colspan="10" class="muted">${state.filters.cashHistoryDate ? "Nenhum fechamento nesta data." : "Nenhum caixa aberto ainda."}</td></tr>`}
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

function reportSales(bounds) {
  return state.data.sales.filter((item) => {
    return !saleIsCancelled(item) && inBounds(saleTimestamp(item), bounds);
  });
}

function paymentGroupKey(method) {
  const normalized = normalizePaymentMethod(method);
  if (normalized === "PIX") return "pix";
  if (normalized === "CASH") return "cash";
  if (normalized === "DEBIT_CARD" || normalized === "CREDIT_CARD" || normalized === "CREDIT_CREDIT") return "card";
  return "other";
}

function reportPaymentSummary(sales) {
  const summary = {
    cash: { label: "Dinheiro", amount: 0, count: 0 },
    card: { label: "Cartao", amount: 0, count: 0 },
    pix: { label: "Pix", amount: 0, count: 0 },
    other: { label: "Outros", amount: 0, count: 0 },
  };
  sales.forEach((item) => {
    const key = paymentGroupKey(paymentMethodValue(item));
    summary[key].amount += saleAmount(item);
    summary[key].count += 1;
  });
  return summary;
}

function reportDetailedSaleItems(sales) {
  return sales.flatMap((record) => {
    const sale = saleData(record);
    const method = paymentMethodValue(record);
    const saleId = sale.id ?? record.docId ?? "-";
    return saleItems(record).map((item) => {
      const productId = item.productId ?? item.product_id;
      const product = findById(state.data.products, productId);
      const quantity = Number(item.quantity) || 0;
      const subtotal = Number(item.subtotal) || (Number(item.unitPrice ?? item.unit_price) || 0) * quantity;
      return {
        saleId,
        timestamp: saleTimestamp(record),
        quantity,
        productName: product?.name || item.productName || item.product_name || `Produto #${productId}`,
        paymentMethod: method,
        subtotal,
      };
    });
  }).sort((a, b) => a.timestamp - b.timestamp);
}

function renderReports() {
  const bounds = reportFilterBounds();
  const reportTransactions = allTransactions().filter((item) => inBounds(item.timestamp, bounds));
  const sales = reportSales(bounds);
  const sold = sales.reduce((sum, item) => sum + saleAmount(item), 0);
  const exits = state.data.exits
    .filter((item) => !item.isCancelled && inBounds(item.timestamp, bounds))
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const entries = state.data.entries
    .filter((item) => !item.isCancelled && inBounds(item.timestamp, bounds))
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const stockValue = state.data.products.reduce((sum, item) => sum + (Number(item.stockQuantity) || 0) * (Number(item.costPrice) || 0), 0);
  const currentYear = new Date().getFullYear();
  const months = monthNames();
  const paymentSummary = reportPaymentSummary(sales);
  const detailedItems = reportDetailedSaleItems(sales);
  const detailedItemRows = renderGroupedTableRows(detailedItems, 6, renderDetailedSaleItemRow);
  const reportTransactionRows = renderGroupedTableRows(reportTransactions, 4, renderReportTransactionRow);
  return `
    <section class="section">
      <article class="panel report-export">
        <div class="report-action">
          <div class="report-icon">${icon("picture_as_pdf")}</div>
          <div>
            <h2>Exportar Relatorio de Vendas</h2>
            <p class="muted">Gera um documento PDF detalhado com vendas, produtos e total geral.</p>
          </div>
        </div>
        <div class="report-options">
          <div class="report-option-group">
            <span class="report-group-label">Filtros</span>
            <div class="report-filter-grid">
              <label class="field report-filter">
                <span>Periodo</span>
                <span class="input-wrap">
                  ${icon("filter_list")}
                  <select id="reportsPeriod">
                    <option value="all" ${state.filters.reportsPeriod === "all" ? "selected" : ""}>Todos</option>
                    <option value="daily" ${state.filters.reportsPeriod === "daily" ? "selected" : ""}>Hoje</option>
                    <option value="specificDate" ${state.filters.reportsPeriod === "specificDate" ? "selected" : ""}>Data especifica</option>
                    <option value="weekly" ${state.filters.reportsPeriod === "weekly" ? "selected" : ""}>Ultimos 7 dias</option>
                    <option value="monthly" ${state.filters.reportsPeriod === "monthly" ? "selected" : ""}>Mensal</option>
                  </select>
                </span>
              </label>
              <label class="field report-date">
                <span>Dia</span>
                <span class="input-wrap">
                  ${icon("event")}
                  <input id="reportDate" type="date" value="${escapeHtml(state.filters.reportsDate)}" />
                </span>
              </label>
              <label class="field report-month">
                <span>Mes</span>
                <span class="input-wrap">
                  ${icon("calendar_month")}
                  <select id="reportMonth">
                    ${months.map((month, index) => `<option value="${index}" ${Number(state.filters.reportsMonth) === index ? "selected" : ""}>${month} ${currentYear}</option>`).join("")}
                  </select>
                </span>
              </label>
            </div>
          </div>
          <div class="report-option-group report-option-group--actions">
            <span class="report-group-label">Exportar PDF</span>
            <div class="report-export-actions">
              <button class="btn" data-report-period="daily">${icon("today")} Diario</button>
              <button class="btn secondary" data-report-period="specificDate">${icon("event")} Dia selecionado</button>
              <button class="btn" data-report-period="weekly">${icon("date_range")} Semanal</button>
              <button class="btn secondary" data-report-period="monthly">${icon("download")} Mensal</button>
            </div>
          </div>
        </div>
      </article>
      <div class="grid cols-2">
        <article class="panel report-export">
          <div class="report-action">
            <div class="report-icon report-icon--sheet">${icon("table_view")}</div>
            <div>
              <h2>Exportar Inventario</h2>
              <p class="muted">Baixa uma planilha CSV com produtos, categorias, fornecedores, precos e estoque.</p>
            </div>
          </div>
          <button class="btn secondary" data-action="export-inventory">${icon("download")} Exportar CSV</button>
        </article>
        <article class="panel report-export">
          <div class="report-action">
            <div class="report-icon report-icon--backup">${icon("database")}</div>
            <div>
              <h2>Backup de Dados</h2>
              <p class="muted">Gera um JSON com as colecoes do sistema sem expor senhas em claro.</p>
            </div>
          </div>
          <button class="btn secondary" data-action="export-backup">${icon("backup")} Baixar Backup</button>
        </article>
      </div>
      <div class="grid cols-3">
        <article class="panel metric primary"><span>Vendas Registradas</span><strong>${money.format(sold)}</strong></article>
        <article class="panel metric secondary"><span>Entradas Avulsas</span><strong>${money.format(entries)}</strong></article>
        <article class="panel metric tertiary"><span>Saidas</span><strong>${money.format(exits)}</strong></article>
      </div>
      <section class="panel">
        <h2>Resumo por Forma de Pagamento</h2>
        <div class="grid cols-3">
          ${["cash", "card", "pix"].map((key) => `
            <article class="metric compact">
              <span>${escapeHtml(paymentSummary[key].label)}</span>
              <strong>${money.format(paymentSummary[key].amount)}</strong>
              <small>${paymentSummary[key].count} venda${paymentSummary[key].count === 1 ? "" : "s"}</small>
            </article>
          `).join("")}
        </div>
        ${paymentSummary.other.amount > 0 ? `<p class="muted">Outros pagamentos: ${money.format(paymentSummary.other.amount)} em ${paymentSummary.other.count} venda${paymentSummary.other.count === 1 ? "" : "s"}.</p>` : ""}
      </section>
      <div class="panel metric"><span>Valor de Custo em Estoque</span><strong>${money.format(stockValue)}</strong></div>
      <div class="panel table-wrap">
        <h2>Itens Vendidos por Forma de Pagamento</h2>
        <table><thead><tr><th>Venda</th><th>Data</th><th>Quant.</th><th>Produto</th><th>Pagamento</th><th>Valor</th></tr></thead><tbody>
          ${detailedItemRows || `<tr><td colspan="6">Sem itens vendidos neste periodo.</td></tr>`}
        </tbody></table>
      </div>
      <div class="panel table-wrap">
        <h2>Movimentacoes do Periodo</h2>
        <table><thead><tr><th>Data</th><th>Tipo</th><th>Descricao</th><th>Valor</th></tr></thead><tbody>
          ${reportTransactionRows || `<tr><td colspan="4">Sem dados.</td></tr>`}
        </tbody></table>
      </div>
    </section>
  `;
}

function renderTableDateDivider(label, colspan) {
  return `<tr class="date-divider-row"><td colspan="${colspan}"><span>${escapeHtml(label)}</span></td></tr>`;
}

function renderGroupedTableRows(items, colspan, renderRow) {
  return renderGroupedByDate(items, renderRow, (label) => renderTableDateDivider(label, colspan));
}

function renderDetailedSaleItemRow(item) {
  return `
    <tr>
      <td>#${escapeHtml(item.saleId)}</td>
      <td>${item.timestamp ? dateOnly.format(new Date(item.timestamp)) : "-"}</td>
      <td>${formatDecimalInput(item.quantity)}</td>
      <td>${escapeHtml(item.productName)}</td>
      <td>${escapeHtml(paymentMethodLabel(item.paymentMethod))}</td>
      <td>${money.format(item.subtotal)}</td>
    </tr>
  `;
}

function renderReportTransactionRow(item) {
  return `<tr><td>${item.timestamp ? dateOnly.format(new Date(item.timestamp)) : "-"}</td><td>${escapeHtml(transactionKindLabel(item.kind))}</td><td>${escapeHtml(item.title)}</td><td>${money.format(item.amount)}</td></tr>`;
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
            <button class="settings-row" data-view="reports">${icon("monitoring")}<span><strong>Relatorios e Exportacao</strong><small>PDF, Excel e backup de dados</small></span></button>
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
  document.querySelectorAll("[data-report-period]").forEach((button) => button.addEventListener("click", () => exportSalesReport(button.dataset.reportPeriod)));
  document.querySelector("#reportsPeriod")?.addEventListener("change", (event) => {
    state.filters.reportsPeriod = event.target.value;
    renderApp();
  });
  document.querySelector("#reportDate")?.addEventListener("change", (event) => {
    state.filters.reportsDate = event.target.value;
    state.filters.reportsPeriod = "specificDate";
    renderApp();
  });
  document.querySelector("#reportMonth")?.addEventListener("change", (event) => {
    state.filters.reportsMonth = Number(event.target.value) || 0;
    if (state.filters.reportsPeriod === "monthly") renderApp();
  });
  document.querySelector("#cashHistoryDate")?.addEventListener("change", (event) => {
    state.filters.cashHistoryDate = event.target.value;
    renderApp();
  });
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
  document.querySelectorAll("[data-cancel-kind]").forEach((button) => button.addEventListener("click", () => cancelTransaction(button.dataset.cancelKind, button.dataset.cancelId)));
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
  "export-inventory": () => exportInventoryCsv(),
  "export-backup": () => exportBackupJson(),
  "clear-cash-history-filter": () => {
    state.filters.cashHistoryDate = "";
    renderApp();
  },
  logout: () => logout(),
  checkout: () => openCheckoutModal(),
};

const adminActions = new Set(["product-new", "category-new", "supplier-new", "user-new", "stock-adjust", "export-inventory", "export-backup"]);

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
    ? [["MASTER_ADMIN", "Administrador Mestre"], ["ADMIN", "Administrador"], ["OPERATOR", "Funcionario"]]
    : [["OPERATOR", "Funcionario"]];
  openModal(item ? "Editar Usuario" : "Novo Usuario", `
    ${input("username", "Usuario", item?.username || "")}
    ${item ? "" : input("password", "Senha", "", "password")}
    ${select("role", "Perfil", roleOptions, item?.role || "OPERATOR")}
    ${select("isActive", "Status", [["true", "Ativo"], ["false", "Inativo"]], item?.isActive === false ? "false" : "true")}
  `, async (form) => {
    const role = isMasterAdmin() ? form.get("role") : "OPERATOR";
    const username = String(form.get("username") || "").trim();
    if (username.length < 3) throw new Error("Informe um usuario com pelo menos 3 caracteres.");
    const password = String(form.get("password") || "");
    if (!item && password.length < 6) throw new Error("Informe uma senha com pelo menos 6 caracteres.");
    await setDoc(doc(db, collections.users, String(id)), {
      id,
      username,
      passwordHash: item ? item.passwordHash : await hashPassword(password),
      role,
      isActive: form.get("isActive") === "true",
      sessionToken: item?.sessionToken || "",
      createdAt: item?.createdAt || Date.now(),
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
  if (password.length < 6) return toast("A senha deve ter pelo menos 6 caracteres.");
  const sessionToken = randomToken();
  await runAction(
    async () => {
      await updateDoc(doc(db, collections.users, String(userId)), { passwordHash: await hashPassword(password), sessionToken });
      if (Number(userId) === Number(state.user.id)) {
        state.session = { userId: Number(userId), sessionToken };
        localStorage.setItem("goRegisterSession", JSON.stringify(state.session));
      }
    },
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

function monthNames() {
  return ["Janeiro", "Fevereiro", "Marco", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
}

function getReportPeriod(period) {
  const now = new Date();
  if (period === "daily") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return {
      startTime: start.getTime(),
      endTime: end.getTime(),
      title: "Relatorio de Vendas - Diario",
      filename: "relatorio_vendas_diario.pdf",
    };
  }
  if (period === "specificDate") {
    const selectedDate = state.filters.reportsDate || new Date().toISOString().slice(0, 10);
    const bounds = dateInputBounds(selectedDate) || todayBounds();
    const label = formatDateInputLabel(selectedDate) || "Data especifica";
    return {
      startTime: bounds[0],
      endTime: bounds[1],
      title: `Relatorio de Vendas - ${label}`,
      filename: `relatorio_vendas_${selectedDate}.pdf`,
    };
  }
  if (period === "weekly") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 7);
    return {
      startTime: start.getTime(),
      endTime: now.getTime(),
      title: "Relatorio de Vendas - Semanal",
      filename: "relatorio_vendas_semanal.pdf",
    };
  }

  const monthIndex = Number(state.filters.reportsMonth ?? document.querySelector("#reportMonth")?.value ?? now.getMonth());
  const year = now.getFullYear();
  const start = new Date(year, monthIndex, 1, 0, 0, 0, 0);
  const end = new Date(year, monthIndex + 1, 1, 0, 0, 0, 0);
  const month = monthNames()[monthIndex];
  return {
    startTime: start.getTime(),
    endTime: end.getTime(),
    title: `Relatorio de Vendas - ${month} ${year}`,
    filename: `relatorio_vendas_${month.toLowerCase()}.pdf`,
  };
}

function saleProductNames(record) {
  const names = saleItems(record).map((item) => {
    const productId = item.productId ?? item.product_id;
    const product = findById(state.data.products, productId);
    const name = product?.name || item.productName || item.product_name || `Produto #${productId}`;
    const quantity = Number(item.quantity) || 0;
    return `${name} x${quantity}`;
  });
  return names.length ? names.join(", ") : "N/A";
}

function exportSalesReport(period) {
  if (!isAdmin()) {
    toast("Acesso restrito ao administrador.");
    return;
  }
  const report = getReportPeriod(period);
  const sales = state.data.sales
    .filter((item) => {
      const timestamp = saleTimestamp(item);
      return !saleIsCancelled(item) && timestamp >= report.startTime && timestamp < report.endTime;
    })
    .sort((a, b) => saleTimestamp(a) - saleTimestamp(b));

  const rows = sales.map((item) => ({
    id: `#${saleData(item).id ?? item.docId ?? "-"}`,
    date: saleTimestamp(item) ? dateTime.format(new Date(saleTimestamp(item))) : "-",
    products: saleProductNames(item),
    payment: paymentMethodLabel(item),
    amount: money.format(saleAmount(item)),
  }));
  const totalAmount = sales.reduce((sum, item) => sum + saleAmount(item), 0);
  const pdf = createSalesReportPdf(report.title, `Data: ${dateTime.format(new Date())}`, rows, money.format(totalAmount), reportPaymentSummary(sales));
  downloadBlob(pdf, report.filename, "application/pdf");
  toast("Relatorio exportado.");
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function exportInventoryCsv() {
  if (!isAdmin()) {
    toast("Acesso restrito ao administrador.");
    return;
  }
  const headers = ["ID", "Produto", "Codigo de barras", "Categoria", "Fornecedor", "Preco de custo", "Preco de venda", "Estoque", "Estoque minimo", "Unidade"];
  const rows = state.data.products
    .slice()
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR"))
    .map((product) => {
      const category = findById(state.data.categories, product.categoryId);
      const supplier = findById(state.data.suppliers, product.supplierId);
      return [
        product.id,
        product.name,
        product.barcode || "",
        category?.name || "",
        supplier?.name || "",
        Number(product.costPrice) || 0,
        Number(product.sellingPrice) || 0,
        Number(product.stockQuantity) || 0,
        Number(product.minStockThreshold) || 0,
        product.unit || "UN",
      ];
    });
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n");
  downloadBlob(`\uFEFF${csv}`, `inventario_go_register_${dateStamp()}.csv`, "text/csv;charset=utf-8");
  toast("Inventario exportado.");
}

function exportBackupJson() {
  if (!isAdmin()) {
    toast("Acesso restrito ao administrador.");
    return;
  }
  const backup = {
    app: "GO REGISTER",
    exportedAt: new Date().toISOString(),
    collections: {
      products: state.data.products,
      sales: state.data.sales,
      categories: state.data.categories,
      suppliers: state.data.suppliers,
      cash_registers: state.data.registers,
      financial_entries: state.data.entries,
      financial_exits: state.data.exits,
      users: state.data.users.map((user) => ({ ...user, passwordHash: user.passwordHash ? "[redacted]" : "", sessionToken: user.sessionToken ? "[redacted]" : "" })),
      stock_movements: state.data.stockMovements,
    },
  };
  downloadBlob(JSON.stringify(backup, null, 2), `backup_go_register_${dateStamp()}.json`, "application/json");
  toast("Backup exportado.");
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function normalizePdfText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\()]/g, "\\$&");
}

function wrapPdfText(value, size) {
  const words = normalizePdfText(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word;
    if (next.length > size && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : ["-"];
}

function pdfTextLine(x, y, size, text, bold = false) {
  return `BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${normalizePdfText(text)}) Tj ET`;
}

function createSalesReportPdf(title, generatedAt, rows, totalText, paymentSummary = null) {
  const width = 595;
  const height = 842;
  const pages = [];
  let lines = [pdfTextLine(40, 802, 18, title, true), pdfTextLine(40, 770, 10, generatedAt)];
  let y = 730;

  const addHeader = () => {
    lines.push(pdfTextLine(40, y, 12, "ID", true));
    lines.push(pdfTextLine(80, y, 12, "Data", true));
    lines.push(pdfTextLine(170, y, 12, "Produtos", true));
    lines.push(pdfTextLine(390, y, 12, "Pagamento", true));
    lines.push(pdfTextLine(480, y, 12, "Valor", true));
    lines.push(`40 ${y - 8} m 555 ${y - 8} l S`);
    y -= 25;
  };
  const newPage = () => {
    pages.push(lines.join("\n"));
    lines = [];
    y = 802;
    addHeader();
  };

  addHeader();
  if (!rows.length) {
    lines.push(pdfTextLine(40, y, 10, "Nenhuma venda encontrada neste periodo."));
    y -= 22;
  }
  rows.forEach((row) => {
    const productLines = wrapPdfText(row.products, 34);
    const rowHeight = Math.max(22, productLines.length * 14 + 8);
    if (y - rowHeight < 55) newPage();
    lines.push(pdfTextLine(40, y, 10, row.id));
    lines.push(pdfTextLine(80, y, 10, row.date));
    productLines.forEach((line, index) => {
      lines.push(pdfTextLine(170, y - index * 14, 10, line));
    });
    lines.push(pdfTextLine(390, y, 10, row.payment || "-"));
    lines.push(pdfTextLine(480, y, 10, row.amount));
    y -= rowHeight;
  });
  if (y < 120) newPage();
  lines.push(`40 ${y} m 555 ${y} l S`);
  y -= 22;
  if (paymentSummary) {
    lines.push(pdfTextLine(350, y, 11, "RESUMO FINANCEIRO", true));
    y -= 18;
    ["cash", "card", "pix"].forEach((key) => {
      lines.push(pdfTextLine(350, y, 10, `${paymentSummary[key].label}:`));
      lines.push(pdfTextLine(480, y, 10, money.format(paymentSummary[key].amount)));
      y -= 14;
    });
    if (paymentSummary.other.amount > 0) {
      lines.push(pdfTextLine(350, y, 10, "Outros:"));
      lines.push(pdfTextLine(480, y, 10, money.format(paymentSummary.other.amount)));
      y -= 14;
    }
    lines.push(`350 ${y + 5} m 555 ${y + 5} l S`);
    y -= 14;
  }
  lines.push(pdfTextLine(350, y, 12, "TOTAL GERAL:", true));
  lines.push(pdfTextLine(480, y, 12, totalText, true));
  pages.push(lines.join("\n"));

  return buildPdf(pages, width, height);
}

function buildPdf(pageContents, width, height) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageContents.map((_, index) => `${5 + index * 2} 0 R`).join(" ")}] /Count ${pageContents.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  pageContents.forEach((content, index) => {
    const pageId = 5 + index * 2;
    const contentId = pageId + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Blob([output], { type: "application/pdf" });
}

function downloadBlob(blob, filename, type) {
  const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  if (!(await requestAdminAuthorization())) return;
  await runAction(async () => {
    if (kind === "sale") {
      const record = state.data.sales.find((item) => String(saleData(item).id ?? item.docId) === String(id));
      if (!record) throw new Error("Venda nao encontrada.");
      await updateDoc(doc(db, collections.sales, String(id)), { "sale.isCancelled": true });
      await Promise.all(saleItems(record).map(async (item) => {
        const productId = item.productId ?? item.product_id;
        const product = findById(state.data.products, productId);
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
  const id = nextId(state.data.sales.map((item) => saleData(item)));
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

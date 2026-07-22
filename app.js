import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  limit,
  setDoc,
  updateDoc,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence, signInWithEmailAndPassword, createUserWithEmailAndPassword, reauthenticateWithCredential, EmailAuthProvider, updatePassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

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
const auth = getAuth(app);
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
  settings: "settings",
};

const themeOptions = [
  ["classic", "Classico"],
  ["emerald", "Esmeralda"],
  ["sunrise", "Amanhecer"],
  ["midnight", "Noturno"],
  ["graphite", "Grafite"],
  ["ocean", "Oceano Escuro"],
  ["forest", "Floresta Escura"],
  ["wine", "Vinho Escuro"],
  ["contrast", "Alto Contraste"],
];

const darkThemes = new Set(["midnight", "graphite", "ocean", "forest", "wine", "contrast"]);

function initialTheme() {
  const savedTheme = localStorage.getItem("goRegisterTheme");
  if (themeOptions.some(([id]) => id === savedTheme)) return savedTheme;
  return localStorage.getItem("goRegisterDarkTheme") === "true" ? "midnight" : "classic";
}

const state = {
  user: null,
  company: null,
  authStage: "loading",
  view: "dashboard",
  theme: initialTheme(),
  darkTheme: false,
  sidebarCollapsed: false,
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
    settings: [],
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
let unsubscribers = [];

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

const paymentOptions = [
  ["CASH", paymentLabels.CASH],
  ["PIX", paymentLabels.PIX],
  ["DEBIT_CARD", paymentLabels.DEBIT_CARD],
  ["CREDIT_CARD", paymentLabels.CREDIT_CARD],
];

const transactionKindLabels = {
  sale: "Venda",
  entry: "Entrada",
  exit: "Saida",
};

const defaultAdmin = {
  username: "admin",
  password: "admin",
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

function paymentMethodGroup(recordOrMethod) {
  const method = typeof recordOrMethod === "string" ? normalizePaymentMethod(recordOrMethod) : paymentMethodValue(recordOrMethod);
  if (method === "DEBIT_CARD" || method === "CREDIT_CARD" || method === "CREDIT_CREDIT") return "CARD";
  if (method === "PIX") return "PIX";
  if (method === "CASH") return "CASH";
  return method || "OTHER";
}

function paymentMethodGroupLabel(recordOrMethod) {
  const group = paymentMethodGroup(recordOrMethod);
  const labels = {
    CASH: "Dinheiro",
    PIX: "Pix",
    CARD: "Cartao",
    OTHER: "Outros",
  };
  return labels[group] || paymentMethodLabel(recordOrMethod);
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
  return isPrivilegedRole(currentUser()?.role);
}

function isMasterAdmin() {
  return currentUser()?.role === "MASTER_ADMIN";
}

function roleLabel(role) {
  if (role === "MASTER_ADMIN") return "Administrador Mestre";
  if (role === "ADMIN") return "Administrador";
  return "Funcionario";
}

function isPrivilegedRole(role) {
  return role === "ADMIN" || role === "MASTER_ADMIN";
}

function currentUser() {
  if (!state.user) return null;
  const fresh = findUserByKey(docKey(state.user)) || findById(state.data.users, state.user.id);
  return fresh ? safeSessionUser(fresh) : state.user;
}

function canManageUser(user) {
  if (!user) return false;
  if (sameUser(user, state.user)) return true;
  return !isPrivilegedRole(user.role) || isMasterAdmin();
}

function sameUser(left, right) {
  if (!left || !right) return false;
  const leftKey = docKey(left);
  const rightKey = docKey(right);
  if (leftKey && rightKey && leftKey === rightKey) return true;
  const leftId = Number(left.id);
  const rightId = Number(right.id);
  return Number.isFinite(leftId) && Number.isFinite(rightId) && leftId === rightId;
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

function weeklyReportBounds() {
  const [todayStart, todayEnd] = todayBounds();
  const start = new Date(todayStart);
  start.setDate(start.getDate() - 6);
  return [start.getTime(), todayEnd];
}

function reportPeriodBounds(period) {
  const now = new Date();
  if (period === "daily") return todayBounds();
  if (period === "specificDate") return dateInputBounds(state.filters.reportsDate) || todayBounds();
  if (period === "weekly") return weeklyReportBounds();
  if (period === "monthly") {
    const monthIndex = Number(state.filters.reportsMonth) || 0;
    const start = new Date(now.getFullYear(), monthIndex, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), monthIndex + 1, 1, 0, 0, 0, 0);
    return [start.getTime(), end.getTime()];
  }
  return null;
}

function reportFilterBounds() {
  return reportPeriodBounds(state.filters.reportsPeriod);
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
  state.darkTheme = darkThemes.has(state.theme);
  document.body.dataset.theme = state.theme;
  document.body.classList.toggle("dark", state.darkTheme);
}

function toggleTheme() {
  const currentIndex = Math.max(0, themeOptions.findIndex(([id]) => id === state.theme));
  setTheme(themeOptions[(currentIndex + 1) % themeOptions.length][0]);
}

function setTheme(theme) {
  if (!themeOptions.some(([id]) => id === theme)) return;
  state.theme = theme;
  localStorage.setItem("goRegisterTheme", theme);
  localStorage.setItem("goRegisterDarkTheme", String(darkThemes.has(theme)));
  applyTheme();
  renderApp();
}

function isReady() {
  return state.loadedCollections.size >= Object.keys(collections).length && !state.loading;
}

function tenantId() { return state.company?.id || ""; }
function cachedCompany() {
  try {
    return JSON.parse(localStorage.getItem("goRegisterCompany") || sessionStorage.getItem("goRegisterCompany") || "null");
  } catch {
    localStorage.removeItem("goRegisterCompany");
    sessionStorage.removeItem("goRegisterCompany");
    return null;
  }
}
function persistCompany(company) {
  localStorage.setItem("goRegisterCompany", JSON.stringify(company));
  sessionStorage.removeItem("goRegisterCompany");
}
function tenantPayload(payload) {
  if (!tenantId()) throw new Error("Empresa não autenticada.");
  return { ...payload, empresa_id: tenantId() };
}
function tenantDocId(id) {
  if (!tenantId()) throw new Error("Empresa não autenticada.");
  return `${tenantId()}__${id}`;
}
function clearSubscriptions() {
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  unsubscribers = [];
  state.loadedCollections.clear();
  Object.keys(state.data).forEach((key) => { state.data[key] = []; });
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
  clearSubscriptions();
  if (state.authStage !== "user" || !tenantId()) return;
  Object.entries(collections).forEach(([key, name]) => {
    if (key === "users" && !isPrivilegedRole(state.user?.role)) {
      state.loadedCollections.add(key);
      return;
    }
    const unsubscribe = onSnapshot(query(collection(db, name), where("empresa_id", "==", tenantId())), (snapshot) => {
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
      else renderAuthScreen(state.firebaseError);
    });
    unsubscribers.push(unsubscribe);
  });
}

function syncSessionUser() {
  if (!state.user) return;
  const user = findUserByKey(state.user.docId) || findById(state.data.users, state.user.id);
  if (!user || user.isActive === false) {
    exitCompany();
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

function renderAuthScreen(error = "") {
  if (state.authStage === "company") return renderUserLogin(error);
  return renderCompanyLogin(error);
}

function renderCompanyLogin(error = "") {
  root.innerHTML = `
    <main class="login-shell">
      <form class="login-card" id="companyLoginForm">
        <img class="login-logo" src="./assets/goregisterlogo.png" alt="GO REGISTER" />
        <h1 class="login-title">GO REGISTER</h1>
        <p class="muted login-subtitle">Selecione sua empresa para continuar</p>
        <label class="field">
          <span>Empresa</span>
          <span class="input-wrap">${icon("domain")}<input name="identifier" autocomplete="organization" placeholder="Código, CNPJ ou acesso" required /></span>
        </label>
        <p class="error">${escapeHtml(error)}</p>
        <button class="btn full" type="submit">Continuar</button>
      </form>
    </main>
  `;
  document.querySelector("#companyLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true; button.textContent = "Verificando...";
    const form = new FormData(event.currentTarget);
    try {
      const identifier = String(form.get("identifier") || "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const snapshot = await getDocs(query(collection(db, "companies"), where("identifierNormalized", "==", identifier), where("isActive", "==", true), limit(1)));
      if (snapshot.empty) throw new Error("Empresa não encontrada ou desativada.");
      const companyDoc = snapshot.docs[0];
      state.company = { id: companyDoc.id, ...companyDoc.data() };
      state.authStage = "company";
      persistCompany(state.company);
      renderUserLogin();
    } catch (loginError) {
      renderCompanyLogin(loginError.message || "Não foi possível autenticar a empresa.");
    }
  });
}

function renderUserLogin(error = "") {
  root.innerHTML = `<main class="login-shell"><form class="login-card" id="userLoginForm">
    <img class="login-logo" src="./assets/goregisterlogo.png" alt="GO REGISTER" />
    <span class="company-login-badge">${icon("domain")} ${escapeHtml(state.company?.name || "Empresa")}</span>
    <h1 class="login-title">Entrar na conta</h1>
    <label class="field"><span>Usuário ou e-mail</span><span class="input-wrap">${icon("person")}<input name="username" autocomplete="username" required /></span></label>
    <label class="field"><span>Senha</span><span class="input-wrap">${icon("key")}<input name="password" type="password" autocomplete="current-password" required /></span></label>
    <p class="error">${escapeHtml(error)}</p><button class="btn full" type="submit">Entrar</button>
    <button class="btn secondary full" type="button" id="changeCompany">Trocar empresa</button>
  </form></main>`;
  document.querySelector("#changeCompany").addEventListener("click", exitCompany);
  document.querySelector("#userLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true; button.textContent = "Entrando...";
    const form = new FormData(event.currentTarget);
    try {
      const login = String(form.get("username") || "").trim();
      let email = login;
      if (!login.includes("@")) {
        const username = login.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        const aliasSnapshot = await getDoc(doc(db, "login_aliases", `${tenantId()}__${username}`));
        if (!aliasSnapshot.exists() || aliasSnapshot.data().empresa_id !== tenantId()) throw new Error("Usuário ou senha inválidos.");
        email = aliasSnapshot.data().email;
      }
      await signInWithEmailAndPassword(auth, email, String(form.get("password") || ""));
    } catch (loginError) { renderUserLogin(loginError.message || "Usuário ou senha inválidos."); }
  });
}

function isAllowedPassword(password) {
  return String(password || "").length >= 6 || String(password || "") === defaultAdmin.password;
}

function appSetting(id) {
  return state.data.settings.find((item) => docKey(item, item.id) === String(id) || String(item.id ?? "") === String(id));
}

function cancellationPasswordHash() {
  return appSetting("cancellation")?.passwordHash || "";
}

async function verifyCancellationPassword(password) {
  const storedHash = cancellationPasswordHash();
  if (!storedHash) return String(password || "") === defaultAdmin.password;
  return await verifyPassword(password, storedHash);
}

async function requestCancellationAuthorization() {
  const form = await openFormDialog("Autorizar Cancelamento", `
    <p class="muted">Informe a senha de cancelamento para confirmar esta operacao.</p>
    ${input("password", "Senha de cancelamento", "", "password")}
  `, "Cancelar transacao", "cancel", "danger");
  if (!form) return false;
  const allowed = await verifyCancellationPassword(form.get("password"));
  if (!allowed) toast("Senha de cancelamento invalida.");
  return allowed;
}

async function changeCancellationPassword() {
  if (!isMasterAdmin()) return toast("Apenas o administrador mestre pode alterar a senha de cancelamento.");
  const form = await openFormDialog("Senha de Cancelamento", `
    <p class="muted">Essa senha sera solicitada ao cancelar vendas, entradas ou saidas.</p>
    ${input("password", "Nova senha", "", "password")}
    ${input("confirmPassword", "Confirmar senha", "", "password")}
  `, "Alterar senha", "lock");
  if (!form) return;
  const password = String(form.get("password") || "");
  const confirmPassword = String(form.get("confirmPassword") || "");
  if (!isAllowedPassword(password)) return toast("A senha deve ter pelo menos 6 caracteres, ou use admin.");
  if (password !== confirmPassword) return toast("As senhas nao conferem.");
  await runAction(async () => {
    const setting = {
      id: "cancellation",
      passwordHash: await hashPassword(password),
      updatedAt: Date.now(),
      updatedBy: Number(currentUser()?.id) || 0,
    };
    await setDoc(doc(db, collections.settings, tenantDocId("cancellation")), tenantPayload({ ...setting, id: "cancellation" }));
    state.data.settings = [...state.data.settings.filter((item) => item.id !== "cancellation"), { ...setting, id: "cancellation", empresa_id: tenantId(), docId: tenantDocId("cancellation") }];
  }, "Senha de cancelamento alterada.");
}

async function logout() {
  state.user = null;
  clearSubscriptions();
  await signOut(auth);
}

async function exitCompany() {
  state.user = null;
  state.company = null;
  state.authStage = "none";
  clearSubscriptions();
  localStorage.removeItem("goRegisterSession");
  localStorage.removeItem("goRegisterUser");
  localStorage.removeItem("goRegisterCompany");
  sessionStorage.removeItem("goRegisterCompany");
  state.cart = [];
  await signOut(auth).catch(() => {});
  renderCompanyLogin();
}

function renderApp(focusId = null) {
  enforceAccess();
  root.innerHTML = `
    <div class="app-shell ${state.sidebarCollapsed ? "sidebar-collapsed" : ""}">
      <aside class="sidebar">
        <div class="brand">
          <img src="./assets/goregisterlogo.png" alt="" />
          <strong>GO REGISTER</strong>
        </div>
        <div class="active-company">${icon("domain")}<span><small>Empresa</small><strong>${escapeHtml(state.company?.name || "-")}</strong></span></div>
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
      <div class="topbar-title">
        <button class="icon-btn sidebar-toggle" type="button" data-action="toggle-sidebar" title="${state.sidebarCollapsed ? "Mostrar painel lateral" : "Esconder painel lateral"}" aria-label="${state.sidebarCollapsed ? "Mostrar painel lateral" : "Esconder painel lateral"}">
          ${icon(state.sidebarCollapsed ? "menu_open" : "menu")}
        </button>
        <h1>${title}</h1><span class="topbar-company">${escapeHtml(state.company?.name || "")}</span>
      </div>
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
      refId: docKey(item, saleId),
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
    refId: docKey(item, item.id),
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
    refId: docKey(item, item.id),
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
        <section class="panel low-stock-panel">
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
              <button class="product-row ${out ? "out" : ""}" data-add-cart="${product.id}">
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
        <div class="toolbar"><h2>Movimentos Financeiros</h2><div><button class="btn secondary" data-action="entry-new">${icon("add")} Venda manual</button> <button class="btn secondary" data-action="exit-new">${icon("remove")} Saida</button></div></div>
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
      const isSelf = sameUser(item, state.user);
      const canManage = canManageUser(item);
      const userKey = escapeHtml(docKey(item));
      return `<tr>
        <td><strong>${escapeHtml(item.username)}</strong>${isSelf ? ` <span class="badge">VOCE</span>` : ""}</td>
        <td>${escapeHtml(roleLabel(item.role))}</td>
        <td><span class="badge ${item.isActive === false ? "bad" : "good"}">${item.isActive === false ? "Inativo" : "Ativo"}</span></td>
        <td>
          ${canManage ? `<button class="icon-btn" data-password-user="${userKey}" title="Alterar senha">${icon("lock")}</button>` : ""}
          ${canManage ? `<button class="icon-btn" data-edit-user="${userKey}" title="Editar">${icon("edit")}</button>` : ""}
          ${!isSelf && canManage ? `<button class="icon-btn" data-toggle-user="${userKey}" title="Ativar/Inativar">${icon("toggle_on")}</button><button class="icon-btn" data-delete-user="${userKey}" title="Excluir">${icon("delete")}</button>` : ""}
        </td>
      </tr>`;
    }).join(""));
}

function reportSales(bounds) {
  return state.data.sales.filter((item) => {
    return !saleIsCancelled(item) && inBounds(saleTimestamp(item), bounds);
  });
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

function reportFinancialMovements(bounds) {
  const mapMovement = (item, kind) => ({
    id: item.id,
    kind,
    timestamp: Number(item.timestamp) || 0,
    description: item.description || (kind === "entry" ? "Entrada" : "Saida"),
    category: String(item.category || "").trim(),
    paymentMethod: item.paymentMethod,
    cashRegisterId: item.cashRegisterId,
    amount: Number(item.amount) || 0,
    isCancelled: Boolean(item.isCancelled),
  });
  return [
    ...state.data.entries.map((item) => mapMovement(item, "entry")),
    ...state.data.exits.map((item) => mapMovement(item, "exit")),
  ]
    .filter((item) => inBounds(item.timestamp, bounds))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function reportManualStockEntries(bounds) {
  return state.data.stockMovements
    .filter((item) => {
      const reason = String(item.reason || "");
      return item.type === "ENTRY"
        && Number(item.quantity) > 0
        && !/^Cancelamento venda/i.test(reason)
        && inBounds(Number(item.timestamp) || 0, bounds);
    })
    .map((item) => {
      const product = findById(state.data.products, item.productId);
      return {
        id: item.id,
        timestamp: Number(item.timestamp) || 0,
        productName: product?.name || `Produto #${item.productId ?? "-"}`,
        quantity: Number(item.quantity) || 0,
        unit: product?.unit || "UN",
        reason: item.reason || "Entrada manual",
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

function reportPeriodLabel(bounds) {
  if (!bounds) return "Todos os periodos";
  const [start, end] = bounds;
  const endDate = new Date(end - 1);
  const startLabel = dateOnly.format(new Date(start));
  const endLabel = dateOnly.format(endDate);
  return startLabel === endLabel ? startLabel : `${startLabel} ate ${endLabel}`;
}

function reportPaymentTotals(sales, financialMovements = []) {
  const totals = sales.reduce((totals, record) => {
    const amount = saleAmount(record);
    const group = paymentMethodGroup(record);
    totals.total += amount;
    totals.stock += amount;
    if (group === "PIX") totals.pix += amount;
    else if (group === "CARD") totals.card += amount;
    else if (group === "CASH") totals.cash += amount;
    else totals.other += amount;
    return totals;
  }, { total: 0, stock: 0, manual: 0, pix: 0, card: 0, cash: 0, other: 0 });
  financialMovements.filter((item) => item.kind === "entry" && !item.isCancelled).forEach((item) => {
    const amount = Number(item.amount) || 0;
    const group = paymentMethodGroup(item.paymentMethod);
    totals.total += amount;
    totals.manual += amount;
    if (group === "PIX") totals.pix += amount;
    else if (group === "CARD") totals.card += amount;
    else if (group === "CASH") totals.cash += amount;
    else totals.other += amount;
  });
  return totals;
}

function reportConsolidatedRows(sales, financialMovements, manualStockEntries) {
  const saleRows = sales.map((record) => {
    const items = saleItems(record);
    const quantity = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    return {
      id: saleData(record).id ?? record.docId ?? "-",
      timestamp: saleTimestamp(record),
      type: "VENDA",
      typeClass: "good",
      description: saleProductNames(record),
      detail: paymentMethodGroupLabel(record),
      quantity: quantity ? formatDecimalInput(quantity) : "-",
      amount: saleAmount(record),
      amountClass: "plus",
    };
  });
  const movementRows = financialMovements.map((item) => {
    const isExit = item.kind === "exit";
    return {
      id: item.id,
      timestamp: item.timestamp,
      type: isExit ? "SAIDA" : "VENDA MANUAL",
      typeClass: isExit ? "bad" : "manual",
      description: item.description,
      detail: `${paymentMethodGroupLabel(item.paymentMethod)}${item.category && item.category !== "-" ? ` - ${item.category}` : ""}`,
      quantity: "-",
      amount: (isExit ? -1 : 1) * item.amount,
      amountClass: isExit ? "minus" : "plus",
      isCancelled: item.isCancelled,
    };
  });
  const stockRows = manualStockEntries.map((item) => ({
    id: item.id,
    timestamp: item.timestamp,
    type: "Entrada estoque",
    description: item.productName,
    detail: item.reason,
    quantity: `+${formatDecimalInput(item.quantity)} ${item.unit}`,
    amount: null,
    amountClass: "plus",
  }));
  return [...saleRows, ...movementRows, ...stockRows].sort((a, b) => a.timestamp - b.timestamp);
}

function renderReports() {
  const bounds = reportFilterBounds();
  const sales = reportSales(bounds);
  const financialMovements = reportFinancialMovements(bounds);
  const paymentTotals = reportPaymentTotals(sales, financialMovements);
  const sold = paymentTotals.total;
  const currentYear = new Date().getFullYear();
  const months = monthNames();
  const manualStockEntries = reportManualStockEntries(bounds);
  const consolidatedRows = reportConsolidatedRows(sales, financialMovements, manualStockEntries);
  const consolidatedTableRows = renderGroupedTableRows(consolidatedRows, 6, renderConsolidatedReportRow);
  const resultClass = "positive";
  const periodLabel = reportPeriodLabel(bounds);
  const manualSaleCount = financialMovements.filter((item) => item.kind === "entry" && !item.isCancelled).length;
  return `
    <section class="section">
      <article class="panel report-export report-export--sales">
        <div class="report-action"><h2>Relatorio de vendas</h2></div>
        <div class="report-options">
          <div class="report-option-group">
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
            <div class="report-export-actions">
              <button class="btn" data-report-period="specificDate">Dia</button>
              <button class="btn" data-report-period="weekly">Semanal</button>
              <button class="btn secondary" data-report-period="monthly">Mensal</button>
            </div>
          </div>
        </div>
      </article>
      <div class="panel report-secondary-actions">
        <span>Outras exportacoes</span>
        <div>
          <button class="btn secondary" data-action="export-inventory">${icon("table_view")} Inventario CSV</button>
          <button class="btn secondary" data-action="export-backup">${icon("backup")} Backup JSON</button>
        </div>
      </div>
      <section class="report-results">
        <article class="report-result-hero report-result-hero--${resultClass}">
          <div>
            <span>Total de vendas (estoque + manual)</span>
            <strong>${money.format(sold)}</strong>
            <small>${escapeHtml(periodLabel)}</small>
          </div>
          <div class="report-result-icon">${icon("point_of_sale")}</div>
        </article>
        <div class="report-kpi-grid">
          <article class="report-kpi report-kpi--entries">
            <span>Vendas manuais</span>
            <strong>${money.format(paymentTotals.manual)}</strong>
            <small>${manualSaleCount} venda${manualSaleCount === 1 ? "" : "s"} sem baixa</small>
          </article>
          <article class="report-kpi report-kpi--exits">
            <span>Vendas do estoque</span>
            <strong>${money.format(paymentTotals.stock)}</strong>
            <small>${sales.length} venda${sales.length === 1 ? "" : "s"} com baixa</small>
          </article>
          <article class="report-kpi report-kpi--stock">
            <span>Pix</span>
            <strong>${money.format(paymentTotals.pix)}</strong>
            <small>Total recebido em Pix</small>
          </article>
          <article class="report-kpi report-kpi--stock">
            <span>Dinheiro</span>
            <strong>${money.format(paymentTotals.cash)}</strong>
            <small>Somatorio em dinheiro</small>
          </article>
        </div>
      </section>
      <div class="panel table-wrap report-table">
        <div class="report-section-heading">
          <div>
            <h2>Relatorio Consolidado</h2>
          </div>
          <strong>${money.format(sold)}</strong>
        </div>
        <div class="report-table-scroll">
          <table><thead><tr><th>Data/Hora</th><th>Tipo de venda</th><th>Descricao</th><th>Detalhe/Categoria</th><th>Quantidade</th><th>Valor</th></tr></thead><tbody>
            ${consolidatedTableRows || `<tr><td colspan="6">Sem dados neste periodo.</td></tr>`}
          </tbody></table>
        </div>
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

function renderConsolidatedReportRow(item) {
  const amount = item.amount == null ? "-" : money.format(item.amount);
  return `
    <tr>
      <td>${item.timestamp ? dateTime.format(new Date(item.timestamp)) : "-"}</td>
      <td><span class="badge ${escapeHtml(item.typeClass || (item.amountClass === "minus" ? "bad" : "good"))}">${escapeHtml(item.type)}</span></td>
      <td>${escapeHtml(item.description)}${item.isCancelled ? ` <span class="badge bad">CANCELADA</span>` : ""}</td>
      <td>${escapeHtml(item.detail || "-")}</td>
      <td>${escapeHtml(item.quantity || "-")}</td>
      <td><strong class="amount ${item.amountClass}">${escapeHtml(amount)}</strong></td>
    </tr>
  `;
}

function renderSettings() {
  return `
    <section class="section">
      <article class="panel settings-theme">
        <h2>Personalizacao</h2>
        ${select("themeSelect", "Tema", themeOptions, state.theme)}
      </article>
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
            ${isMasterAdmin() ? `<button class="settings-row" data-action="cancel-password">${icon("password")}<span><strong>Senha de Cancelamento</strong><small>Alterar senha usada para cancelar transacoes</small></span></button>` : ""}
          </div>
        </div>
      ` : ""}
      <div class="panel danger-zone"><h2>Sessão da empresa</h2><button class="settings-row" data-action="exit-company">${icon("domain_disabled")}<span><strong>Sair da empresa</strong><small>Encerra a conta e remove a empresa ativa deste dispositivo</small></span></button></div>
    </section>
  `;
}

function bindViewEvents() {
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => runNamedAction(button.dataset.action)));
  document.querySelector("[name='themeSelect']")?.addEventListener("change", (event) => setTheme(event.target.value));
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
  document.querySelectorAll("[data-edit-user]").forEach((button) => button.addEventListener("click", () => openUserModal(findUserByKey(button.dataset.editUser))));
  document.querySelectorAll("[data-delete-user]").forEach((button) => button.addEventListener("click", () => deleteUser(button.dataset.deleteUser)));
  document.querySelectorAll("[data-toggle-user]").forEach((button) => button.addEventListener("click", () => toggleUser(button.dataset.toggleUser)));
  document.querySelectorAll("[data-password-user]").forEach((button) => button.addEventListener("click", () => changeUserPassword(button.dataset.passwordUser)));
}

function findById(items, id) {
  return items.find((item) => Number(item.id) === Number(id));
}

function docKey(item, fallbackId = null) {
  return String(item?.docId ?? item?.id ?? fallbackId ?? "");
}

function findUserByKey(key) {
  return state.data.users.find((item) => docKey(item) === String(key) || String(item.id ?? "") === String(key));
}

async function removeDoc(collectionName, id) {
  if (!isAdmin() && [collections.products, collections.categories, collections.suppliers, collections.users].includes(collectionName)) {
    toast("Acesso restrito ao administrador.");
    return;
  }
  if (!(await openConfirmModal("Excluir Registro", "Tem certeza que deseja excluir este registro?", "Excluir"))) return;
  await runAction(
    () => deleteDoc(doc(db, collectionName, String(id))),
    "Registro excluido."
  );
}

async function addCart(productId) {
  const product = findById(state.data.products, productId);
  if (!product) return;
  const existing = state.cart.find((item) => Number(item.product.id) === Number(productId));
  if (existing) {
    if (existing.quantity + 1 > Number(product.stockQuantity || 0)) {
      await promptAddStockForProduct(product);
      return;
    }
    existing.quantity += 1;
  } else {
    if (Number(product.stockQuantity || 0) < 1) {
      await promptAddStockForProduct(product);
      return;
    }
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
    promptAddStockForProduct(item.product);
    return;
  }
  item.quantity = nextQty;
  renderApp();
}

async function setCartQty(productId, value) {
  const item = state.cart.find((cartItem) => Number(cartItem.product.id) === Number(productId));
  if (!item) return;
  const nextQty = parseDecimal(value);
  if (nextQty <= 0) {
    removeCart(productId);
    return;
  }
  if (nextQty > Number(item.product.stockQuantity || 0)) {
    renderApp();
    await promptAddStockForProduct(item.product);
    return;
  }
  item.quantity = Math.round(nextQty * 1000) / 1000;
  renderApp();
}

async function promptAddStockForProduct(product) {
  const confirmed = await openChoiceModal(
    "Adicionar ao Estoque?",
    `Deseja adicionar "${product.name}" ao estoque para vender agora?`
  );
  if (!confirmed) return;
  if (!isAdmin()) {
    toast("Apenas administradores podem alterar o estoque.");
    return;
  }
  openStockAdjustModal(product);
}

function productNameExists(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return true;
  return state.data.products.some((item) => String(item.name || "").trim().toLowerCase() === normalized);
}

async function promptCreateProductFromManualMovement(name, kind = "entry") {
  const productName = String(name || "").trim();
  if (!productName || productNameExists(productName)) return;
  const context = kind === "exit" ? "saidas futuras" : "vendas futuras";
  const confirmed = await openChoiceModal(
    "Adicionar ao Estoque?",
    `Deseja cadastrar "${productName}" como um produto no seu estoque para ${context}?`
  );
  if (!confirmed) return;
  if (!isAdmin()) {
    toast("Apenas administradores podem cadastrar produtos.");
    return;
  }
  openProductModal({ name: productName, stockQuantity: 0, sellingPrice: 0, costPrice: 0 });
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
  "toggle-sidebar": () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    renderApp();
  },
  "theme-toggle": () => toggleTheme(),
  "refresh-data": () => renderApp(),
  "export-inventory": () => exportInventoryCsv(),
  "export-backup": () => exportBackupJson(),
  "cancel-password": () => changeCancellationPassword(),
  "exit-company": () => exitCompany(),
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
    try {
      const afterSave = await onSubmit(new FormData(event.currentTarget));
      state.firebaseError = "";
      closeModal();
      renderApp();
      if (typeof afterSave === "function") {
        await afterSave();
      }
    } catch (error) {
      const message = error.message || "Falha ao salvar.";
      if (/firebase|firestore|permission|network|offline/i.test(message)) {
        state.firebaseError = message;
      }
      toast(message);
    }
  });
}

function closeModal() {
  document.querySelector("#modalRoot").innerHTML = "";
}

function openFormDialog(title, body, submitText = "Salvar", submitIcon = "save", buttonClass = "") {
  return new Promise((resolve) => {
    const finish = (value) => {
      closeModal();
      resolve(value);
    };
    document.querySelector("#modalRoot").innerHTML = `
      <div class="modal-backdrop">
        <section class="modal">
          <header><h2>${title}</h2><button class="icon-btn" type="button" data-dialog-cancel>${icon("close")}</button></header>
          <form id="dialogForm">
            ${body}
            <footer>
              <button class="btn secondary" type="button" data-dialog-cancel>Cancelar</button>
              <button class="btn ${buttonClass}" type="submit">${icon(submitIcon)} ${submitText}</button>
            </footer>
          </form>
        </section>
      </div>
    `;
    document.querySelectorAll("[data-dialog-cancel]").forEach((button) => button.addEventListener("click", () => finish(null)));
    document.querySelector("#dialogForm").addEventListener("submit", (event) => {
      event.preventDefault();
      finish(new FormData(event.currentTarget));
    });
  });
}

async function openConfirmModal(title, message, confirmText = "Confirmar") {
  const form = await openFormDialog(title, `<p class="muted">${escapeHtml(message)}</p>`, confirmText, "check", "danger");
  return Boolean(form);
}

function openChoiceModal(title, message, cancelText = "NAO", confirmText = "SIM") {
  return new Promise((resolve) => {
    const finish = (value) => {
      closeModal();
      resolve(value);
    };
    document.querySelector("#modalRoot").innerHTML = `
      <div class="modal-backdrop">
        <section class="modal modal-choice">
          <form id="choiceForm">
            <h2>${escapeHtml(title)}</h2>
            <p class="muted">${escapeHtml(message)}</p>
            <footer>
              <button class="btn text" type="button" data-choice-cancel>${escapeHtml(cancelText)}</button>
              <button class="btn" type="submit">${escapeHtml(confirmText)}</button>
            </footer>
          </form>
        </section>
      </div>
    `;
    document.querySelector("[data-choice-cancel]").addEventListener("click", () => finish(false));
    document.querySelector("#choiceForm").addEventListener("submit", (event) => {
      event.preventDefault();
      finish(true);
    });
  });
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
  const isEditing = Boolean(product?.id);
  const id = product?.id || nextId(state.data.products);
  openModal(isEditing ? "Editar Produto" : "Novo Produto", `
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
    await setDoc(doc(db, collections.products, tenantDocId(id)), tenantPayload(payload));
    toast("Produto salvo.");
  });
}

function openNameModal(title, collectionName, items, item = null) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  const id = item?.id || nextId(items);
  openModal(item ? `Editar ${title}` : `Nova ${title}`, input("name", "Nome", item?.name || ""), async (form) => {
    await setDoc(doc(db, collectionName, tenantDocId(id)), tenantPayload({ id, name: form.get("name") }));
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
    await setDoc(doc(db, collections.suppliers, tenantDocId(id)), tenantPayload({ id, name: form.get("name"), contact: form.get("contact") || null, email: form.get("email") || null }));
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
    ${item ? "" : input("email", "E-mail de acesso", "", "email")}
    ${item ? "" : input("password", "Senha", "", "password")}
    ${select("role", "Perfil", roleOptions, item?.role || "OPERATOR")}
    ${select("isActive", "Status", [["true", "Ativo"], ["false", "Inativo"]], item?.isActive === false ? "false" : "true")}
  `, async (form) => {
    const role = isMasterAdmin() ? form.get("role") : "OPERATOR";
    const username = String(form.get("username") || "").trim();
    if (username.length < 3) throw new Error("Informe um usuario com pelo menos 3 caracteres.");
    const email = item?.email || String(form.get("email") || document.querySelector('#modalForm input[name="email"]')?.value || "").trim().toLowerCase();
    if (!item && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Informe um e-mail de acesso válido.");
    const password = String(form.get("password") || "");
    if (!item && !isAllowedPassword(password)) throw new Error("Informe uma senha com pelo menos 6 caracteres, ou use a senha padrao admin.");
    let userDocId = item ? docKey(item, id) : "";
    if (!item) {
      const secondaryApp = initializeApp(firebaseConfig, `create-user-${Date.now()}`);
      try {
        const credential = await createUserWithEmailAndPassword(getAuth(secondaryApp), email, password);
        userDocId = credential.user.uid;
      } finally {
        await signOut(getAuth(secondaryApp)).catch(() => {});
        await deleteApp(secondaryApp);
      }
    }
    await setDoc(doc(db, collections.users, userDocId), tenantPayload({
      id,
      username,
      email,
      usernameNormalized: username.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(),
      role,
      isActive: form.get("isActive") === "true",
      createdAt: item?.createdAt || Date.now(),
    }));
    const aliasId = `${tenantId()}__${username.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()}`;
    await setDoc(doc(db, "login_aliases", aliasId), tenantPayload({ uid: userDocId, email, username }));
    toast("Usuario salvo.");
  });
}

async function changeUserPassword(userKey) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  const user = findUserByKey(userKey);
  if (!user) return toast("Usuario nao encontrado.");
  if (!canManageUser(user)) return toast("Apenas o administrador mestre pode alterar senha de administradores.");
  if (!sameUser(user, state.user)) return toast("Cada usuário deve alterar a própria senha em sua conta.");
  const form = await openFormDialog("Alterar senha", `
    ${input("currentPassword", "Senha atual", "", "password")}
    ${input("newPassword", "Nova senha", "", "password")}
  `, "Alterar senha", "lock");
  if (!form) return;
  const currentPassword = String(form.get("currentPassword") || "");
  const newPassword = String(form.get("newPassword") || "");
  if (newPassword.length < 6) return toast("A nova senha deve ter pelo menos 6 caracteres.");
  await runAction(async () => {
    const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPassword);
    await reauthenticateWithCredential(auth.currentUser, credential);
    await updatePassword(auth.currentUser, newPassword);
  }, "Senha alterada.");
}

async function toggleUser(userKey) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  const user = findUserByKey(userKey);
  if (!user) return toast("Usuario nao encontrado.");
  if (sameUser(user, state.user)) return toast("Voce nao pode inativar seu proprio usuario.");
  if (!canManageUser(user)) return toast("Apenas o administrador mestre pode alterar status de administradores.");
  await runAction(
    () => updateDoc(doc(db, collections.users, docKey(user, userKey)), { isActive: user.isActive === false }),
    user.isActive === false ? "Usuario ativado." : "Usuario inativado."
  );
}

async function deleteUser(userKey) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  const user = findUserByKey(userKey);
  if (!user) return toast("Usuario nao encontrado.");
  if (sameUser(user, state.user)) return toast("Voce nao pode excluir seu proprio usuario.");
  if (!canManageUser(user)) return toast("Apenas o administrador mestre pode excluir administradores.");
  if (!(await openConfirmModal("Excluir Usuario", `Tem certeza que deseja excluir ${user.username}?`, "Excluir"))) return;
  await runAction(
    () => deleteDoc(doc(db, collections.users, docKey(user, userKey))),
    "Registro excluido."
  );
}

function monthNames() {
  return ["Janeiro", "Fevereiro", "Marco", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
}

function getReportPeriod(period) {
  const now = new Date();
  const bounds = reportPeriodBounds(period);
  if (period === "daily") {
    return {
      startTime: bounds[0],
      endTime: bounds[1],
      title: "Relatorio de Vendas - Diario",
      filename: "relatorio_vendas_diario.pdf",
    };
  }
  if (period === "specificDate") {
    const selectedDate = state.filters.reportsDate || new Date().toISOString().slice(0, 10);
    const label = formatDateInputLabel(selectedDate) || "Data especifica";
    return {
      startTime: bounds[0],
      endTime: bounds[1],
      title: `Relatorio de Vendas - ${label}`,
      filename: `relatorio_vendas_${selectedDate}.pdf`,
    };
  }
  if (period === "weekly") {
    return {
      startTime: bounds[0],
      endTime: bounds[1],
      title: "Relatorio de Vendas - Semanal",
      filename: "relatorio_vendas_semanal.pdf",
    };
  }

  const monthIndex = Number(state.filters.reportsMonth ?? document.querySelector("#reportMonth")?.value ?? now.getMonth());
  const year = now.getFullYear();
  const month = monthNames()[monthIndex];
  return {
    startTime: bounds[0],
    endTime: bounds[1],
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
  const bounds = [report.startTime, report.endTime];
  const sales = state.data.sales
    .filter((item) => {
      const timestamp = saleTimestamp(item);
      return !saleIsCancelled(item) && timestamp >= report.startTime && timestamp < report.endTime;
    })
    .sort((a, b) => saleTimestamp(a) - saleTimestamp(b));

  const financialMovements = reportFinancialMovements(bounds);
  const manualStockEntries = reportManualStockEntries(bounds);
  const rows = reportConsolidatedRows(sales, financialMovements, manualStockEntries);
  const paymentTotals = reportPaymentTotals(sales, financialMovements);
  const pdf = createSalesReportPdf(report.title, `Data de exportacao: ${dateTime.format(new Date())}`, rows, paymentTotals);
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
      settings: state.data.settings.map((setting) => ({ ...setting, passwordHash: setting.passwordHash ? "[redacted]" : "" })),
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

function createSalesReportPdf(title, generatedAt, rows, paymentTotals) {
  const width = 595;
  const height = 842;
  const pages = [];
  const totalText = money.format(paymentTotals.total);
  let lines = [
    pdfTextLine(40, 802, 18, title, true),
    pdfTextLine(40, 775, 11, "Relatorio consolidado de vendas"),
    pdfTextLine(40, 752, 9, generatedAt),
    pdfTextLine(40, 720, 10, `Total de vendas: ${totalText}`, true),
    pdfTextLine(225, 720, 10, `Venda manual: ${money.format(paymentTotals.manual)}`, true),
    pdfTextLine(410, 720, 10, `Venda estoque: ${money.format(paymentTotals.stock)}`, true),
    pdfTextLine(40, 700, 10, `Pix: ${money.format(paymentTotals.pix)}`, true),
    pdfTextLine(225, 700, 10, `Dinheiro: ${money.format(paymentTotals.cash)}`, true),
    pdfTextLine(410, 700, 10, `Cartao: ${money.format(paymentTotals.card)}`, true),
  ];
  let y = 660;

  const addHeader = () => {
    lines.push(pdfTextLine(40, y, 9, "Data/Hora", true));
    lines.push(pdfTextLine(116, y, 9, "Tipo de venda", true));
    lines.push(pdfTextLine(205, y, 9, "Descricao", true));
    lines.push(pdfTextLine(355, y, 9, "Pag./Categoria", true));
    lines.push(pdfTextLine(435, y, 9, "Qtde", true));
    lines.push(pdfTextLine(500, y, 9, "Valor", true));
    lines.push(`40 ${y - 8} m 555 ${y - 8} l S`);
    y -= 25;
  };
  const newPage = () => {
    pages.push(lines.join("\n"));
    lines = [];
    y = 802;
    addHeader();
  };
  const newPlainPage = () => {
    pages.push(lines.join("\n"));
    lines = [
      pdfTextLine(40, 802, 18, title, true),
      pdfTextLine(40, 775, 11, "Relatorio consolidado de vendas"),
      pdfTextLine(40, 758, 9, generatedAt),
    ];
    y = 725;
  };

  addHeader();
  if (!rows.length) {
    lines.push(pdfTextLine(40, y, 10, "Nenhum movimento encontrado neste periodo."));
    y -= 22;
  }
  rows.forEach((row) => {
    const descriptionLines = wrapPdfText(row.description, 22);
    const detailLines = wrapPdfText(row.detail, 13);
    const rowHeight = Math.max(22, Math.max(descriptionLines.length, detailLines.length) * 13 + 8);
    if (y - rowHeight < 55) newPage();
    lines.push(pdfTextLine(40, y, 8, row.timestamp ? dateTime.format(new Date(row.timestamp)) : "-"));
    lines.push(pdfTextLine(116, y, 8, row.type));
    descriptionLines.forEach((line, index) => lines.push(pdfTextLine(205, y - index * 13, 9, line)));
    detailLines.forEach((line, index) => lines.push(pdfTextLine(355, y - index * 13, 9, line)));
    lines.push(pdfTextLine(435, y, 9, row.quantity || "-"));
    lines.push(pdfTextLine(500, y, 9, row.amount == null ? "-" : money.format(row.amount)));
    y -= rowHeight;
  });
  if (y < 90) newPage();
  lines.push(`40 ${y} m 555 ${y} l S`);
  y -= 22;
  lines.push(pdfTextLine(330, y, 12, "TOTAL DE VENDAS:", true));
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
    await setDoc(doc(db, collections.registers, tenantDocId(id)), tenantPayload(register));
    state.data.registers = [...state.data.registers.filter((item) => Number(item.id) !== Number(id)), register];
    toast("Caixa aberto.");
  });
}

async function closeRegister() {
  const open = state.data.registers.find((item) => item.isOpen);
  if (!open) return;
  const form = await openFormDialog("Fechar Caixa", input("closingBalance", "Saldo final do caixa", open.initialBalance || 0, "number"), "Fechar caixa", "lock", "danger");
  if (!form) return;
  const closing = form.get("closingBalance");
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
  openModal(isEntry ? "Nova Venda Manual (sem retirar do estoque)" : "Nova Saida", `
    ${input("description", "Descricao")}
    ${input("amount", "Valor", 0, "number")}
    ${select("paymentMethod", "Pagamento", paymentOptions, "CASH")}
    ${input("category", "Categoria")}
  `, async (form) => {
    const list = isEntry ? state.data.entries : state.data.exits;
    const collectionName = isEntry ? collections.entries : collections.exits;
    const open = state.data.registers.find((item) => item.isOpen);
    const id = nextId(list);
    const description = String(form.get("description") || "").trim();
    await setDoc(doc(db, collectionName, tenantDocId(id)), tenantPayload({
      id,
      timestamp: Date.now(),
      description,
      amount: parseDecimal(form.get("amount")),
      paymentMethod: form.get("paymentMethod"),
      category: form.get("category") || null,
      transactionType: isEntry ? "MANUAL_SALE" : "EXIT",
      cashRegisterId: Number(open?.id) || 0,
      isCancelled: false,
    }));
    toast(isEntry ? "Venda manual salva sem alterar o estoque." : "Saida salva.");
    return isEntry ? undefined : () => promptCreateProductFromManualMovement(description, "exit");
  });
}

function openStockAdjustModal(selectedProduct = null) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  openModal("Ajustar Estoque", `
    ${select("productId", "Produto", state.data.products.map((item) => [item.id, `${item.name} (${item.stockQuantity} ${item.unit || "UN"})`]), selectedProduct?.id || "")}
    ${select("type", "Tipo", [["ENTRY", "Entrada"], ["EXIT", "Saida"], ["ADJUSTMENT", "Ajuste absoluto"]], "ENTRY")}
    ${input("quantity", "Quantidade", 1, "number")}
    ${input("reason", "Motivo", selectedProduct ? `Entrada para venda de ${selectedProduct.name}` : "Ajuste manual")}
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
  openModal("Forma de Pagamento", select("paymentMethod", "Pagamento", paymentOptions, "CASH"), async (form) => {
    await checkout(form.get("paymentMethod"));
  });
}

async function cancelTransaction(kind, id) {
  if (!(await requestCancellationAuthorization())) return;
  await runAction(async () => {
    if (kind === "sale") {
      const record = state.data.sales.find((item) => String(docKey(item, saleData(item).id)) === String(id) || String(saleData(item).id ?? "") === String(id));
      if (!record) throw new Error("Venda nao encontrada.");
      const saleId = saleData(record).id ?? id;
      await updateDoc(doc(db, collections.sales, docKey(record, id)), { "sale.isCancelled": true, isCancelled: true });
      await Promise.all(saleItems(record).map(async (item) => {
        const productId = item.productId ?? item.product_id;
        const product = findById(state.data.products, productId);
        if (!product) return;
        const restored = (Number(product.stockQuantity) || 0) + (Number(item.quantity) || 0);
        await updateProductStock(product.id, restored);
        await saveStockMovement(product.id, Number(item.quantity) || 0, "ENTRY", `Cancelamento venda #${saleId}`);
      }));
    }
    if (kind === "entry") {
      const record = state.data.entries.find((item) => String(docKey(item, item.id)) === String(id) || String(item.id ?? "") === String(id));
      if (!record) throw new Error("Entrada nao encontrada.");
      await updateDoc(doc(db, collections.entries, docKey(record, id)), { isCancelled: true });
    }
    if (kind === "exit") {
      const record = state.data.exits.find((item) => String(docKey(item, item.id)) === String(id) || String(item.id ?? "") === String(id));
      if (!record) throw new Error("Saida nao encontrada.");
      await updateDoc(doc(db, collections.exits, docKey(record, id)), { isCancelled: true });
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
  await setDoc(doc(db, collections.sales, tenantDocId(id)), tenantPayload({ sale: { ...sale, empresa_id: tenantId() }, items }));
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
  const product = findById(state.data.products, productId);
  const productKey = docKey(product, productId);
  if (!productKey) throw new Error("Produto nao encontrado para atualizar o estoque.");
  await updateDoc(doc(db, collections.products, productKey), { stockQuantity });
  state.data.products = state.data.products.map((item) => Number(item.id) === Number(productId) ? { ...item, stockQuantity } : item);
}

async function saveStockMovement(productId, quantity, type, reason) {
  const id = nextId(state.data.stockMovements);
  await setDoc(doc(db, collections.stockMovements, tenantDocId(id)), tenantPayload({
    id,
    productId: Number(productId),
    timestamp: Date.now(),
    quantity,
    type,
    reason,
  }));
}

async function init() {
  applyTheme();
  state.view = getRouteView();
  await setPersistence(auth, browserLocalPersistence);
  onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
      state.user = null;
      clearSubscriptions();
      const company = cachedCompany();
      if (company?.id) {
        state.company = company;
        state.authStage = "company";
        renderUserLogin();
      } else {
        state.authStage = "none";
        state.company = null;
        renderCompanyLogin();
      }
      return;
    }
    try {
      const profileSnapshot = await getDoc(doc(db, "users", firebaseUser.uid));
      if (!profileSnapshot.exists() || profileSnapshot.data().isActive === false) throw new Error("Usuário sem acesso ativo.");
      const profile = { ...profileSnapshot.data(), docId: profileSnapshot.id, uid: firebaseUser.uid };
      const selectedCompany = cachedCompany();
      if (selectedCompany?.id && selectedCompany.id !== profile.empresa_id) {
        throw new Error("Este usuário não pertence à empresa selecionada.");
      }
      const companySnapshot = await getDoc(doc(db, "companies", profile.empresa_id));
      if (!companySnapshot.exists() || companySnapshot.data().isActive === false) throw new Error("Empresa inexistente ou desativada.");
      state.company = { id: companySnapshot.id, ...companySnapshot.data() };
      persistCompany(state.company);
      state.user = profile;
      state.authStage = "user";
      state.loading = true;
      renderApp();
      subscribe();
    } catch (error) {
      await signOut(auth);
      renderUserLogin(error.message || "Acesso negado.");
    }
  });
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

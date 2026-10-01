import { installKeyboardSupport, rememberFocus } from "./keyboard.mjs";
import { receiptSubtotalCents, receiptQrSvg } from "./receipt-core.mjs";
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
  writeBatch,
  runTransaction,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence, signInWithEmailAndPassword, createUserWithEmailAndPassword, reauthenticateWithCredential, EmailAuthProvider, updatePassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  applyReceivablePayment,
  filterReceivables,
  groupReceivablesByCustomer,
  localDateInputToMillis,
  matchesExistingPayment,
  millisToLocalDateInput,
  parseMoneyToCents,
  receivableDisplayStatus,
  receivablePaymentFingerprint,
  receivablePaymentsForCustomer,
  receivablesEntitlementAccess,
  receivablesSummary,
} from "./receivables-core.mjs?v=partial-payment-filter-v2";
import { calculateExpectedRegisterBalance } from "./cash-register-core.mjs?v=all-payment-methods-v1";
import { buildInternalAlerts } from "./alerts-core.mjs?v=internal-alerts-v1";
import { calculateBusinessAnalytics } from "./business-analytics-core.mjs?v=business-analytics-v1";
import {
  PRODUCT_STOCK_LEVEL,
  compareProductsByAvailabilityAndName,
  compareProductsByStockLevelAndName,
  productMatchesStockFilter,
  productStockLevel,
} from "./stock-order-core.mjs?v=pos-availability-order-v1";

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

const ACTIVE_REGISTER_DOCUMENT = "active_register";
const ACCOUNTS_RECEIVABLE_ENTITLEMENT = "accounts_receivable";
const receivablesCollections = {
  customers: "customers",
  receivables: "receivables",
  payments: "receivable_payments",
};

const themeOptions = [
  ["classic", "Clássico"],
  ["white", "Branco"],
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
  companyProfile: null,
  receiptSettings: null,
  receivablesEntitlement: null,
  receivablesEntitlementLoaded: false,
  mainSubscriptionEntitlement: null,
  auditLogs: [],
  auditLoaded: false,
  authStage: "loading",
  view: "dashboard",
  theme: initialTheme(),
  darkTheme: false,
  sidebarCollapsed: false,
  notificationsOpen: false,
  activeRegisterControl: null,
  activeRegisterControlInitialized: false,
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
    reportsStartDate: millisToLocalDateInput(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()),
    reportsEndDate: millisToLocalDateInput(Date.now()),
    reportsMonth: new Date().getMonth(),
    inventoryStockLevel: "ALL",
    receivablesView: "customers",
    receivablesCustomerSearch: "",
    receivablesStatus: "OPEN",
    receivablesSearch: "",
    auditSearch: "",
    auditCategory: "ALL",
  },
  receivables: {
    customers: [],
    receivables: [],
    payments: [],
    loadedCollections: new Set(),
    errors: new Map(),
  },
  discount: 0,
  loading: true,
  loadedCollections: new Set(),
  collectionErrors: new Map(),
  firebaseError: "",
  lastSync: null,
};
let unsubscribers = [];
let receivablesEntitlementUnsubscribe = null;
let mainSubscriptionUnsubscribe = null;
let receivablesUnsubscribers = [];
let receivablesSubscribedTenant = "";
let auditUnsubscribe = null;
const pendingReceivablePayments = new Map();
const RECEIVABLE_PAYMENT_RETRY_STORAGE_KEY = "goRegisterReceivablePaymentRetriesV1";
let checkoutInProgress = false;

const navItems = [
  ["dashboard", "Painel", "dashboard", "all"],
  ["pos", "Vendas", "payments", "all"],
  ["cash", "Caixa", "point_of_sale", "all"],
  ["receivables", "Clientes e Contas", "request_quote", "receivables"],
  ["inventory", "Estoque", "inventory_2", "admin"],
  ["audit", "Auditoria", "policy", "admin"],
  ["settings", "Ajustes", "settings", "all"],
];

const adminRoutes = new Set(["inventory", "stockHistory", "cashHistory", "categories", "suppliers", "users", "reports", "audit"]);

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });
const receiptDate = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });
const receiptTime = new Intl.DateTimeFormat("pt-BR", { timeStyle: "short" });

function formatReceiptDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${receiptDate.format(date)} H ${receiptTime.format(date)}`;
}

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

function publicStockMovementReason(value) {
  return String(value || "")
    .replace(/\bCancelamento\s+(?:de\s+)?venda\s*#[^\s]+/gi, "Cancelamento de venda")
    .replace(/\bVenda\s*#[^\s]+/gi, "Venda")
    .trim();
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

function salePaymentParts(record) {
  const sale = saleData(record);
  const total = saleAmount(record);
  const primaryMethod = paymentMethodValue(record) || "CASH";
  const secondaryMethod = normalizePaymentMethod(
    sale.secondaryPaymentMethod ?? sale.secondary_payment_method ?? ""
  );
  const secondaryAmount = Number(
    sale.secondaryPaymentAmount ?? sale.secondary_payment_amount ?? 0
  ) || 0;
  const totalCents = Math.round(total * 100);
  const secondaryCents = Math.round(secondaryAmount * 100);

  if (!secondaryMethod || secondaryMethod === primaryMethod || secondaryCents <= 0 || secondaryCents >= totalCents) {
    return [{ method: primaryMethod, amount: totalCents / 100 }];
  }
  return [
    { method: primaryMethod, amount: (totalCents - secondaryCents) / 100 },
    { method: secondaryMethod, amount: secondaryCents / 100 },
  ];
}

function salePaymentSummary(record, includeAmounts = true) {
  const parts = salePaymentParts(record);
  if (parts.length === 1) return paymentMethodLabel(parts[0].method);
  return parts.map((part) => includeAmounts
    ? `${paymentMethodLabel(part.method)} ${money.format(part.amount)}`
    : paymentMethodLabel(part.method)
  ).join(" + ");
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
    CREDIT_CREDIT: "CREDIT_CARD",
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
  const companyId = String(safeUser.companyId || state.company?.id || safeUser.empresa_id || "");
  return { ...safeUser, companyId };
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function readReceivablePaymentRetries() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECEIVABLE_PAYMENT_RETRY_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeReceivablePaymentRetries(retries) {
  try {
    if (Object.keys(retries).length === 0) localStorage.removeItem(RECEIVABLE_PAYMENT_RETRY_STORAGE_KEY);
    else localStorage.setItem(RECEIVABLE_PAYMENT_RETRY_STORAGE_KEY, JSON.stringify(retries));
    return true;
  } catch {
    return false;
  }
}

function getOrCreateReceivablePaymentRetry(companyId, receivableId, fingerprint) {
  const scope = `${companyId}::${receivableId}`;
  const retries = readReceivablePaymentRetries();
  const previous = retries[scope];
  const paymentId = typeof previous?.paymentId === "string" && previous.paymentId.length <= 64
    ? previous.paymentId
    : randomUuid();
  retries[scope] = { paymentId, fingerprint, createdAt: Number(previous?.createdAt) || Date.now() };
  if (!writeReceivablePaymentRetries(retries)) {
    throw new Error("O navegador bloqueou o armazenamento seguro da tentativa. Libere o armazenamento do site antes de registrar o pagamento.");
  }
  return { scope, paymentId };
}

function clearReceivablePaymentRetry(scope, paymentId) {
  const retries = readReceivablePaymentRetries();
  if (retries[scope]?.paymentId !== paymentId) return;
  delete retries[scope];
  writeReceivablePaymentRetries(retries);
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
  if (view === "receivables") return accountsReceivableAccess().visible;
  return !adminRoutes.has(view) || isAdmin();
}

function accountsReceivableAccess() {
  return receivablesEntitlementAccess(state.receivablesEntitlement);
}

function availableNavItems() {
  return navItems.filter(([, , , access]) => {
    if (access === "admin") return isAdmin();
    if (access === "receivables") return accountsReceivableAccess().visible;
    return true;
  });
}

function enforceAccess() {
  if (!canAccess(state.view)) {
    const restrictedView = state.view;
    state.view = "dashboard";
    window.location.hash = "/dashboard";
    toast(restrictedView === "receivables"
      ? "Modulo de contas a receber indisponivel para esta empresa."
      : "Acesso restrito ao administrador.");
  }
}

function icon(name) {
  return `<span class="material-symbols-rounded" aria-hidden="true">${name}</span>`;
}

function sectionBlockHeading(title, description, glyph = "view_agenda") {
  return `<div class="section-block-heading">${icon(glyph)}<div><h2>${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div></div>`;
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
  if (period === "custom") {
    const start = dateInputBounds(state.filters.reportsStartDate);
    const end = dateInputBounds(state.filters.reportsEndDate);
    return start && end && start[0] <= end[0] ? [start[0], end[1]] : todayBounds();
  }
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

function tenantId() { return state.user?.companyId || state.company?.companyId || state.company?.id || ""; }
function companyFromSnapshot(snapshot) {
  return { ...snapshot.data(), id: snapshot.id, companyId: snapshot.id };
}
function cachedCompany() {
  try {
    const company = JSON.parse(localStorage.getItem("goRegisterCompany") || sessionStorage.getItem("goRegisterCompany") || "null");
    if (company?.companyId) return { ...company, id: company.companyId };
    if (company) {
      localStorage.removeItem("goRegisterCompany");
      sessionStorage.removeItem("goRegisterCompany");
    }
    return null;
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
  return { ...payload, empresa_id: tenantId(), companyId: tenantId() };
}
function tenantDocId(id) {
  if (!tenantId()) throw new Error("Empresa não autenticada.");
  return String(id);
}
function tenantCollection(collectionName) {
  if (!tenantId()) throw new Error("Empresa não autenticada.");
  return collection(db, "companies", tenantId(), collectionName);
}
function tenantDocument(collectionName, id) {
  return doc(tenantCollection(collectionName), String(id));
}

function accountsReceivableEntitlementDocument() {
  if (!tenantId()) throw new Error("Empresa não autenticada.");
  return doc(db, "companies", tenantId(), "entitlements", ACCOUNTS_RECEIVABLE_ENTITLEMENT);
}

function currentOpenRegister() {
  if (state.activeRegisterControlInitialized) {
    return state.activeRegisterControl?.isOpen === true ? state.activeRegisterControl : null;
  }

  // Compatibilidade apenas para empresas ainda não migradas para o documento active_register.
  return state.data.registers
    .filter((item) => item.isOpen === true)
    .sort((a, b) => {
      const timeDifference = (Number(b.openingTimestamp) || 0) - (Number(a.openingTimestamp) || 0);
      return timeDifference || (Number(b.id) || 0) - (Number(a.id) || 0);
    })[0] || null;
}

async function closeOlderOpenRegisters(activeRegister) {
  const activeId = Number(activeRegister.id);
  const activeTimestamp = Number(activeRegister.openingTimestamp) || 0;
  const staleRegisters = state.data.registers.filter((item) =>
    item.isOpen === true &&
    Number(item.id) !== activeId &&
    (Number(item.openingTimestamp) || 0) <= activeTimestamp
  );
  if (!staleRegisters.length) return;

  const closedAt = Date.now();
  await Promise.all(staleRegisters.map((item) => updateDoc(
    tenantDocument(collections.registers, item.docId || tenantDocId(item.id)),
    {
      isOpen: false,
      open: deleteField(),
      closingTimestamp: item.closingTimestamp || closedAt,
    }
  )));
}
function clearSubscriptions() {
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  unsubscribers = [];
  receivablesEntitlementUnsubscribe?.();
  receivablesEntitlementUnsubscribe = null;
  mainSubscriptionUnsubscribe?.();
  mainSubscriptionUnsubscribe = null;
  auditUnsubscribe?.();
  auditUnsubscribe = null;
  state.auditLogs = [];
  state.auditLoaded = false;
  stopReceivablesSubscriptions(true);
  state.loadedCollections.clear();
  state.collectionErrors.clear();
  state.companyProfile = null;
  state.receiptSettings = null;
  state.receivablesEntitlement = null;
  state.receivablesEntitlementLoaded = false;
  state.mainSubscriptionEntitlement = null;
  state.activeRegisterControl = null;
  state.activeRegisterControlInitialized = false;
  Object.keys(state.data).forEach((key) => { state.data[key] = []; });
}

function clearReceivablesData() {
  state.receivables.customers = [];
  state.receivables.receivables = [];
  state.receivables.payments = [];
  state.receivables.loadedCollections.clear();
  state.receivables.errors.clear();
  pendingReceivablePayments.clear();
}

function stopReceivablesSubscriptions(clearData = false) {
  receivablesUnsubscribers.forEach((unsubscribe) => unsubscribe());
  receivablesUnsubscribers = [];
  receivablesSubscribedTenant = "";
  if (clearData) clearReceivablesData();
}

function subscribeReceivablesData() {
  const companyId = tenantId();
  if (!companyId || receivablesSubscribedTenant === companyId || !accountsReceivableAccess().visible) return;
  stopReceivablesSubscriptions(true);
  receivablesSubscribedTenant = companyId;

  Object.entries(receivablesCollections).forEach(([key, collectionName]) => {
    const unsubscribe = onSnapshot(tenantCollection(collectionName), (snapshot) => {
      if (tenantId() !== companyId || !accountsReceivableAccess().visible) return;
      state.receivables[key] = snapshot.docs
        .map((item) => ({ ...item.data(), docId: item.id }))
        .sort((left, right) => (Number(right.updatedAt ?? right.createdAt ?? right.timestamp) || 0)
          - (Number(left.updatedAt ?? left.createdAt ?? left.timestamp) || 0));
      state.receivables.loadedCollections.add(key);
      state.receivables.errors.delete(key);
      state.lastSync = new Date();
      if (state.user && !hasOpenModal()) renderApp();
    }, (error) => {
      if (tenantId() !== companyId) return;
      state.receivables.errors.set(key, error.message || `Falha ao carregar ${collectionName}.`);
      if (state.user && !hasOpenModal()) renderApp();
    });
    receivablesUnsubscribers.push(unsubscribe);
  });
}

function subscribeAccountsReceivableEntitlement() {
  const companyId = tenantId();
  if (!companyId) return;
  receivablesEntitlementUnsubscribe?.();
  receivablesEntitlementUnsubscribe = onSnapshot(accountsReceivableEntitlementDocument(), (snapshot) => {
    if (tenantId() !== companyId) return;
    const previousMode = accountsReceivableAccess().mode;
    state.receivablesEntitlement = snapshot.exists()
      ? { ...snapshot.data(), id: snapshot.id }
      : null;
    state.receivablesEntitlementLoaded = true;
    state.receivables.errors.delete("entitlement");
    const access = accountsReceivableAccess();
    if (access.visible) {
      subscribeReceivablesData();
    } else {
      stopReceivablesSubscriptions(true);
      if (state.view === "receivables") {
        state.view = "dashboard";
        window.location.hash = "/dashboard";
      }
    }
    if (state.user && (previousMode !== access.mode || !hasOpenModal())) renderApp();
  }, (error) => {
    if (tenantId() !== companyId) return;
    state.receivablesEntitlement = null;
    state.receivablesEntitlementLoaded = true;
    stopReceivablesSubscriptions(true);
    if (state.view === "receivables") {
      state.view = "dashboard";
      window.location.hash = "/dashboard";
    }
    state.receivables.errors.set("entitlement", error.message || "Falha ao verificar o modulo de contas a receber.");
    if (state.user) renderApp();
  });
}

function subscribeMainSubscriptionEntitlement() {
  const companyId = tenantId();
  if (!companyId) return;
  mainSubscriptionUnsubscribe?.();
  mainSubscriptionUnsubscribe = onSnapshot(
    tenantDocument("entitlements", "main_subscription"),
    (snapshot) => {
      if (tenantId() !== companyId) return;
      state.mainSubscriptionEntitlement = snapshot.exists() ? snapshot.data() : null;
      if (state.user && !hasOpenModal()) renderApp();
    },
    () => {
      if (tenantId() === companyId) state.mainSubscriptionEntitlement = null;
    },
  );
}

function syncLabel() {
  if (combinedFirebaseError()) return "Erro no Firebase";
  if (!isReady()) return "Sincronizando";
  return state.lastSync ? `Atualizado ${dateTime.format(state.lastSync)}` : "Online";
}

function receivablesFirebaseError() {
  return [...state.receivables.errors.values()][0] || "";
}

function combinedFirebaseError() {
  return state.firebaseError || [...state.collectionErrors.values()][0] || receivablesFirebaseError();
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
    const unsubscribe = onSnapshot(tenantCollection(name), (snapshot) => {
      const dataKey = key === "registers" ? "registers" : key;
      if (dataKey === "registers") {
        const controlDocument = snapshot.docs.find((item) => item.id === ACTIVE_REGISTER_DOCUMENT);
        state.activeRegisterControlInitialized = Boolean(controlDocument);
        state.activeRegisterControl = controlDocument
          ? { ...controlDocument.data(), docId: controlDocument.id }
          : null;
      }
      const visibleDocuments = dataKey === "registers"
        ? snapshot.docs.filter((item) => item.id !== ACTIVE_REGISTER_DOCUMENT)
        : snapshot.docs;
      state.data[dataKey] = visibleDocuments
        .map((item) => ({ ...item.data(), docId: item.id }))
        .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
      if (dataKey === "products") syncCartProducts();
      if (dataKey === "users") syncSessionUser();
      state.loadedCollections.add(key);
      state.collectionErrors.delete(key);
      state.loading = false;
      state.lastSync = new Date();
      if (state.user && !hasOpenModal()) renderApp();
    }, (error) => {
      state.loading = false;
      const message = error.message || `Falha ao carregar ${name}.`;
      state.collectionErrors.set(key, message);
      if (state.user) renderApp();
      else renderAuthScreen(message);
    });
    unsubscribers.push(unsubscribe);
  });
  subscribeAccountsReceivableEntitlement();
  subscribeMainSubscriptionEntitlement();
  subscribeAuditLogs();
}

function subscribeAuditLogs() {
  if (!isAdmin() || !tenantId()) return;
  auditUnsubscribe?.();
  auditUnsubscribe = onSnapshot(tenantCollection("audit_logs"), (snapshot) => {
    state.auditLogs = snapshot.docs
      .map((item) => ({ ...item.data(), docId: item.id }))
      .sort((left, right) => (Number(right.timestamp) || 0) - (Number(left.timestamp) || 0));
    state.auditLoaded = true;
    if (state.user && state.view === "audit" && !hasOpenModal()) renderApp();
  }, (error) => {
    state.auditLoaded = true;
    state.collectionErrors.set("audit", error.message || "Falha ao carregar a auditoria.");
    if (state.user && state.view === "audit") renderApp();
  });
}

async function writeAuditLog({ action, entityType, entityId, description, amountCents = null }) {
  const companyId = tenantId();
  const actorUid = auth.currentUser?.uid;
  if (!companyId || !actorUid || !state.user) throw new Error("Sessão inválida para registrar auditoria.");
  const eventId = crypto.randomUUID();
  const payload = {
    id: eventId,
    empresa_id: companyId,
    companyId,
    action: String(action || "").trim().slice(0, 64),
    entityType: String(entityType || "").trim().slice(0, 64),
    entityId: String(entityId || "").trim().slice(0, 128),
    description: String(description || "").trim().slice(0, 500),
    amountCents: amountCents == null ? null : Math.max(0, Math.round(Number(amountCents) || 0)),
    actorUid,
    actorName: String(state.user.username || "Usuário").trim().slice(0, 120),
    actorRole: String(state.user.role || "OPERATOR"),
    timestamp: Date.now(),
    source: "WEB",
  };
  await setDoc(tenantDocument("audit_logs", eventId), payload);
}

function syncSessionUser() {
  if (!state.user) return;
  const user = findUserByKey(state.user.docId) || findById(state.data.users, state.user.id);
  if (!user || user.isActive === false) {
    exitCompany();
    return;
  }
  state.user = safeSessionUser(user);
  if (!isPrivilegedRole(state.user.role)) state.companyProfile = null;
}

function syncCartProducts() {
  state.cart = state.cart
    .map((item) => {
      const freshProduct = findById(state.data.products, item.product.id);
      if (!freshProduct) return null;
      return {
        product: freshProduct,
        quantity: productTracksStock(freshProduct) ? Math.min(item.quantity, Number(freshProduct.stockQuantity) || 0) : item.quantity,
      };
    })
    .filter((item) => item && item.quantity > 0);
}

function renderAuthScreen(error = "") {
  if (state.authStage === "company") return renderUserLogin(error);
  return renderCompanyLogin(error);
}

function renderLoginBrand() {
  return `<img class="login-brand-logo" src="./assets/goregisterlogo.png" alt="GO REGISTER" />`;
}

function renderCompanyLogin(error = "") {
  root.innerHTML = `
    <main class="login-shell">
      <form class="login-card" id="companyLoginForm">
        ${renderLoginBrand()}
        <h1 class="login-title">Acesse sua empresa</h1>
        <p class="muted login-subtitle">Use o identificador de acesso para continuar</p>
        <label class="field">
          <span>Empresa</span>
          <span class="input-wrap">${icon("domain")}<input name="identifier" autocomplete="organization" placeholder="Identificador de acesso" required /></span>
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
      const identifierInput = String(form.get("identifier") || "").trim();
      const identifier = /^[\d\s./-]+$/.test(identifierInput)
        ? identifierInput.replace(/\D/g, "")
        : identifierInput.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const snapshot = await getDocs(query(collection(db, "companies"), where("identifierNormalized", "==", identifier), where("isActive", "==", true), limit(1)));
      if (snapshot.empty) throw new Error("Empresa não encontrada ou desativada.");
      const companyDoc = snapshot.docs[0];
      state.company = companyFromSnapshot(companyDoc);
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
    ${renderLoginBrand()}
    <div class="login-company">
      <small>Empresa selecionada</small>
      <strong>${escapeHtml(state.company?.name || "Empresa")}</strong>
    </div>
    <h1 class="login-title">Entrar na conta</h1>
    <label class="field"><span>Nome de usuário</span><span class="input-wrap">${icon("person")}<input name="username" autocomplete="username" placeholder="Seu nome de usuário" required /></span></label>
    <label class="field"><span>Senha</span><span class="input-wrap">${icon("key")}<input name="password" type="password" autocomplete="current-password" placeholder="Sua senha" required /></span></label>
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
      const username = login.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const aliasSnapshot = await getDoc(doc(db, "login_aliases", `${tenantId()}__${username}`));
      let authEmail = "";
      if (aliasSnapshot.exists() && aliasSnapshot.data().empresa_id === tenantId()) {
        authEmail = String(aliasSnapshot.data().email || aliasSnapshot.data().authEmail || "");
      }
      if (!authEmail) throw new Error("Usuário ou senha inválidos.");
      renderUserLoginTransition(login);
      await signInWithEmailAndPassword(auth, authEmail, String(form.get("password") || ""));
    } catch (loginError) { renderUserLogin(userLoginErrorMessage(loginError)); }
  });
}

function renderUserLoginTransition(pendingUserName = "") {
  const userName = pendingUserName || state.user?.username || "Usuário";
  const companyName = state.company?.name || "GO REGISTER";
  root.innerHTML = `
    <main class="login-transition" role="status" aria-live="polite" aria-label="Login concluído. Preparando o painel.">
      <div class="login-transition__content">
        <img class="login-transition__logo" src="./assets/goregisterlogo.png" alt="" />
        <span class="login-transition__eyebrow">Acesso autorizado</span>
        <h1>Bem-vindo, ${escapeHtml(userName)}</h1>
        <p>${escapeHtml(companyName)}</p>
        <div class="login-transition__progress" aria-hidden="true"><span></span></div>
        <small>Preparando seu painel...</small>
      </div>
    </main>
  `;
}

function userLoginErrorMessage(error) {
  if (["auth/invalid-credential", "auth/invalid-login-credentials", "auth/user-not-found", "auth/wrong-password"].includes(error?.code)) {
    return "Usuário ou senha inválidos.";
  }
  if (error?.code === "permission-denied") {
    return "Não foi possível autorizar o acesso. Confira no painel administrativo a liberação da empresa, limpezas pendentes e o vínculo deste usuário.";
  }
  return error?.message || "Acesso negado.";
}

function isAllowedPassword(password) {
  return String(password || "").length >= 6 || String(password || "") === defaultAdmin.password;
}

function appSetting(id) {
  return state.data.settings.find((item) => docKey(item, item.id) === String(id) || String(item.id ?? "") === String(id));
}

async function loadOfficialCompanyProfile() {
  state.companyProfile = null;
  if (!state.user || !isPrivilegedRole(state.user.role) || !tenantId()) return false;
  const requestedCompanyId = tenantId();
  try {
    const profileSnapshot = await getDoc(doc(db, "companies", requestedCompanyId, "company_profile", "official"));
    if (!state.user || !isPrivilegedRole(state.user.role) || tenantId() !== requestedCompanyId) return false;
    // Um documento oficial existente e canonico, inclusive quando algum campo foi apagado.
    // Sem documento, mantemos o root completo apenas em memoria para empresas legadas.
    state.companyProfile = profileSnapshot.exists()
      ? { ...profileSnapshot.data(), __officialProfile: true }
      : { ...(state.company || {}), __officialProfile: false };
    return true;
  } catch (error) {
    if (!state.user || tenantId() !== requestedCompanyId) return false;
    state.companyProfile = null;
    console.warn("Nao foi possivel carregar o perfil oficial da empresa.", error);
    return false;
  }
}

function receiptSettingValue(settings, keys, maxLength, preserveLines = false) {
  let value = "";
  for (const key of keys) {
    const candidate = settings?.[key];
    if (typeof candidate !== "string" && typeof candidate !== "number") continue;
    value = String(candidate).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    if (value) break;
  }
  if (!value) return "";
  value = preserveLines
    ? value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n")
    : value.replace(/\s+/g, " ");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function safeReceiptLogoUrl(settings) {
  const value = receiptSettingValue(settings, ["logoUrl", "logoURL", "logo_url"], 500);
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.includes(".") ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function safeReceiptSettings(settings) {
  return {
    logoUrl: safeReceiptLogoUrl(settings),
    socialMedia: receiptSettingValue(settings, ["socialMedia", "socialNetworks", "socialNetwork", "redesSociais", "redes_sociais"], 240),
    receiptMessage: receiptSettingValue(settings, ["receiptMessage", "customReceiptMessage", "mensagemRecibo", "mensagem_recibo"], 500, true),
    exchangePolicy: receiptSettingValue(settings, ["exchangePolicy", "returnPolicy", "refundPolicy", "politicaTroca", "politica_troca", "politicaDeTroca"], 1200, true),
  };
}

function sessionUserKey(user) {
  return String(user?.uid || user?.docId || user?.id || "");
}

async function loadReceiptSettings() {
  state.receiptSettings = null;
  if (!state.user || !tenantId()) return false;
  const requestedCompanyId = tenantId();
  const requestedUserKey = sessionUserKey(state.user);
  try {
    const settingsSnapshot = await getDoc(doc(db, "companies", requestedCompanyId, "receipt_settings", "official"));
    if (!state.user || tenantId() !== requestedCompanyId || sessionUserKey(state.user) !== requestedUserKey) return false;
    state.receiptSettings = safeReceiptSettings(settingsSnapshot.exists() ? settingsSnapshot.data() : {});
    return true;
  } catch (error) {
    if (!state.user || tenantId() !== requestedCompanyId || sessionUserKey(state.user) !== requestedUserKey) return false;
    state.receiptSettings = {};
    console.warn("Nao foi possivel carregar as configuracoes publicas do recibo.", error);
    return false;
  }
}

function cancellationPasswordHash() {
  return appSetting("cancellation")?.passwordHash || "";
}

async function verifyCancellationPassword(password) {
  const storedHash = cancellationPasswordHash();
  if (!storedHash) return false;
  return await verifyPassword(password, storedHash);
}

async function requestCancellationPassword() {
  if (!cancellationPasswordHash()) {
    toast("Senha de cancelamento não configurada. Defina-a no site de administração.");
    return "";
  }
  const form = await openFormDialog("Autorizar Cancelamento", `
    <p class="muted">Informe a senha de cancelamento para confirmar esta operacao.</p>
    ${input("password", "Senha de cancelamento", "", "password")}
  `, "Cancelar transacao", "cancel", "danger");
  if (!form) return "";
  const password = String(form.get("password") || "");
  const allowed = await verifyCancellationPassword(password);
  if (!allowed) toast("Senha de cancelamento invalida.");
  return allowed ? password : "";
}

async function requestCancellationAuthorization() {
  return Boolean(await requestCancellationPassword());
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
  await signOut(auth).catch(() => { });
  renderCompanyLogin();
}

function renderApp(focusId = null) {
  const restoreFocus = rememberFocus(root);
  enforceAccess();
  root.innerHTML = `
    <div class="app-shell ${state.sidebarCollapsed ? "sidebar-collapsed" : ""}">
      <button type="button" class="skip-content" data-action="focus-content">Ir para o conteúdo</button>
      <aside class="sidebar">
        <div class="brand">
          <img src="./assets/goregisterlogo.png" alt="" />
          <strong>GO REGISTER</strong>
          <button class="icon-btn sidebar-toggle" type="button" data-action="toggle-sidebar" title="${state.sidebarCollapsed ? "Expandir painel lateral" : "Recolher painel lateral"}" aria-label="${state.sidebarCollapsed ? "Expandir painel lateral" : "Recolher painel lateral"}">
            ${icon(state.sidebarCollapsed ? "keyboard_double_arrow_right" : "keyboard_double_arrow_left")}
          </button>
        </div>
        <div class="active-company" title="Empresa: ${escapeHtml(state.company?.name || "-")}">${icon("domain")}<span><small>Empresa</small><strong>${escapeHtml(state.company?.name || "-")}</strong></span></div>
        <nav class="nav">
          ${availableNavItems().map(([id, label, glyph]) => `<button data-view="${id}" class="${state.view === id ? "active" : ""}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon(glyph)}<span class="nav-label">${escapeHtml(label)}</span></button>`).join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="sync-pill ${combinedFirebaseError() ? "bad" : isReady() ? "good" : ""}" title="${escapeHtml(syncLabel())}" aria-label="${escapeHtml(syncLabel())}">
            <span></span>
            <span class="sync-label">${escapeHtml(syncLabel())}</span>
          </div>
          <div class="user-pill"><strong>${escapeHtml(state.user.username)}</strong>${escapeHtml(roleLabel(state.user.role))}</div>
          <button class="btn secondary" id="logoutBtn" title="Sair" aria-label="Sair">${icon("logout")}<span class="logout-label">Sair</span></button>
        </div>
      </aside>
      <main class="main" tabindex="-1">
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
  if (!focusId) restoreFocus();
  if (focusId) {
    const field = document.querySelector(`#${focusId}`);
    field?.focus();
    field?.setSelectionRange?.(field.value.length, field.value.length);
  }
}

function renderView() {
  const title = [...navItems, ["stockHistory", "Historico Estoque"], ["cashHistory", "Historico Caixa"], ["categories", "Categorias"], ["suppliers", "Fornecedores"], ["users", "Usuarios"], ["reports", "Relatorios"]].find(([id]) => id === state.view)?.[1] || "Painel";
  const actions = renderTopActions();
  const alerts = currentInternalAlerts();
  return `
    <header class="topbar">
      <div class="topbar-title">
        <h1>${title}</h1><span class="topbar-company">${escapeHtml(state.company?.name || "")}</span>
      </div>
      <div class="topbar-actions">
        <button class="icon-btn" type="button" data-action="keyboard-help" title="Ajuda do teclado (F1)" aria-label="Ajuda do teclado">${icon("keyboard")}</button>
        ${actions ? `<div class="topbar-page-actions">${actions}</div>` : ""}
        <div class="notification-anchor">
          <button class="icon-btn notification-trigger" type="button" data-action="toggle-notifications" aria-label="Abrir notificações" aria-expanded="${state.notificationsOpen}" aria-controls="notificationCenter">
            ${icon("notifications")}
            ${alerts.length ? `<span class="notification-badge" aria-label="${alerts.length} alertas">${alerts.length > 9 ? "9+" : alerts.length}</span>` : ""}
          </button>
          ${state.notificationsOpen ? renderNotificationCenter(alerts) : ""}
        </div>
      </div>
    </header>
    ${views[state.view]()}
  `;
}

function renderTopActions() {
  if (!canAccess(state.view)) return "";
  if (state.view === "receivables" && accountsReceivableAccess().canCreate) {
    return `<button class="btn secondary" data-action="receivable-customer-new">${icon("person_add")} Cliente</button> <button class="btn" data-action="receivable-new">${icon("post_add")} Conta manual</button>`;
  }
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
  receivables: renderReceivables,
  inventory: renderInventory,
  stockHistory: renderStockHistory,
  cash: renderCash,
  cashHistory: renderCashHistory,
  categories: renderCategories,
  suppliers: renderSuppliers,
  users: renderUsers,
  reports: renderReports,
  audit: renderAudit,
  settings: renderSettings,
};

const auditActionLabels = {
  SALE_CREATED: "Venda concluída", SALE_CANCELLED: "Venda cancelada",
  CASH_OPENED: "Caixa aberto", CASH_CLOSED: "Caixa fechado",
  MANUAL_ENTRY_CREATED: "Entrada manual", MANUAL_EXIT_CREATED: "Saída manual",
  MANUAL_ENTRY_CANCELLED: "Entrada cancelada", MANUAL_EXIT_CANCELLED: "Saída cancelada",
  PRODUCT_CREATED: "Produto criado", PRODUCT_UPDATED: "Produto atualizado", PRODUCT_DELETED: "Produto excluído",
  STOCK_ADDED: "Estoque adicionado", STOCK_REMOVED: "Estoque retirado",
  CUSTOMER_CREATED: "Cliente criado", CUSTOMER_UPDATED: "Cliente atualizado",
  RECEIVABLE_CREATED: "Conta lançada", RECEIVABLE_CANCELLED: "Conta cancelada",
  RECEIVABLE_DELETED: "Conta apagada", PAYMENT_RECEIVED: "Pagamento recebido",
  USER_CREATED: "Usuário criado", USER_UPDATED: "Usuário atualizado", USER_DELETED: "Usuário excluído",
  BACKUP_RESTORED: "Backup restaurado",
};

function auditMatchesCategory(event, category) {
  if (category === "ALL") return true;
  if (category === "CASH") return event.action.includes("CASH") || event.action.includes("MANUAL");
  if (category === "RECEIVABLE") return ["RECEIVABLE", "PAYMENT", "CUSTOMER"].some((value) => event.action.includes(value));
  return event.action.includes(category);
}

function currentInternalAlerts() {
  return buildInternalAlerts({
    products: state.data.products,
    receivables: state.receivables.receivables,
    openRegister: currentOpenRegister(),
    subscription: state.mainSubscriptionEntitlement,
  });
}

function alertPresentation(alert) {
  if (alert.id === "stock-zero") return { icon: "warning", target: "inventory", filter: "OUT" };
  if (alert.id === "stock-low") return { icon: "inventory_2", target: "inventory", filter: "LOW" };
  if (alert.id === "receivables-overdue") return { icon: "schedule", target: "receivables", filter: "OVERDUE" };
  if (alert.id === "cash-open-long") return { icon: "point_of_sale", target: "cash" };
  return { icon: "event", target: "settings" };
}

function renderNotificationCenter(alerts) {
  const countLabel = `${alerts.length} ${alerts.length === 1 ? "alerta" : "alertas"}`;
  return `
    <button class="notification-scrim" type="button" data-close-notifications aria-label="Fechar notificações"></button>
    <aside class="notification-center" id="notificationCenter" role="dialog" aria-modal="true" aria-labelledby="notificationTitle">
      <header class="notification-center__header">
        <div><h2 id="notificationTitle">Notificações</h2><p>${countLabel}</p></div>
        <button class="icon-btn notification-close" type="button" data-close-notifications aria-label="Fechar notificações">${icon("close")}</button>
      </header>
      <div class="notification-list">
        ${alerts.map((alert) => {
    const presentation = alertPresentation(alert);
    return `
            <button class="notification-item notification-item--${escapeHtml(alert.severity)}" type="button" data-alert-id="${escapeHtml(alert.id)}">
              <span class="notification-item__icon">${icon(presentation.icon)}</span>
              <span class="notification-item__content"><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.message)}</small></span>
              ${icon("chevron_right")}
            </button>
          `;
  }).join("") || `<div class="notification-empty">${icon("notifications_none")}<strong>Nenhum alerta</strong><small>Tudo certo no momento.</small></div>`}
      </div>
    </aside>
  `;
}

function renderAudit() {
  const search = state.filters.auditSearch.trim().toLocaleLowerCase("pt-BR");
  const events = state.auditLogs.filter((event) => auditMatchesCategory(event, state.filters.auditCategory)
    && `${event.actorName || ""} ${event.description || ""} ${event.entityId || ""}`.toLocaleLowerCase("pt-BR").includes(search));
  return `<section class="section sectioned-page">
    <article class="section-block data-table-block">
      ${sectionBlockHeading("Registro de auditoria", "Consulte operações realizadas por usuários e dispositivos", "policy")}
      <div class="toolbar section-filters">
        <label class="field"><span>Tipo de operação</span><select id="auditCategory">
          ${[["ALL", "Todos"], ["SALE", "Vendas"], ["CASH", "Caixa"], ["PRODUCT", "Estoque"], ["RECEIVABLE", "Contas"], ["USER", "Usuários"]]
      .map(([value, label]) => `<option value="${value}" ${state.filters.auditCategory === value ? "selected" : ""}>${label}</option>`).join("")}
        </select></label>
        <label class="field"><span>Buscar</span><span class="input-wrap">${icon("search")}<input id="auditSearch" value="${escapeHtml(state.filters.auditSearch)}" placeholder="Usuário, descrição ou código" /></span></label>
      </div>
      ${!state.auditLoaded ? `<p class="muted">Carregando auditoria...</p>` : events.length ? `
        <div class="table-wrap audit-list-scroll" tabindex="0" role="region" aria-label="Registros de auditoria"><table><thead><tr><th>Data/Hora</th><th>Ação</th><th>Usuário</th><th>Descrição</th><th>Valor</th><th>Origem</th></tr></thead>
        <tbody>${events.map((event) => `<tr>
          <td>${escapeHtml(dateTime.format(new Date(Number(event.timestamp) || 0)))}</td>
          <td><strong>${escapeHtml(auditActionLabels[event.action] || event.action)}</strong></td>
          <td>${escapeHtml(event.actorName || "-")}<br><small>${escapeHtml(event.actorRole || "-")}</small></td>
          <td>${escapeHtml(event.description || "-")}<br><small>Código: ${escapeHtml(event.entityId || "-")}</small></td>
          <td>${event.amountCents == null ? "-" : money.format(Number(event.amountCents) / 100)}</td>
          <td>${event.source === "ANDROID" ? "Aplicativo" : "Site"}</td>
        </tr>`).join("")}</tbody></table></div>` : `<p class="muted">Nenhum registro encontrado.</p>`}
    </article>
  </section>`;
}

function allTransactions() {
  const saleRows = state.data.sales.map((item) => {
    const sale = saleData(item);
    const saleId = sale.id ?? item.docId;
    return {
      id: saleId,
      kind: "sale",
      title: saleTransactionTitle(item),
      subtitle: salePaymentSummary(item),
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
  return "Venda";
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
  const lowStock = state.data.products
    .filter((item) => productStockLevel(item) !== PRODUCT_STOCK_LEVEL.ACCEPTABLE)
    .sort(compareProductsByStockLevelAndName);
  return `
    <section class="section dashboard-page">
      <section class="dashboard-block dashboard-summary">
        <div class="dashboard-block-heading">
          ${icon("monitoring")}
          <div><h2>Resumo do dia</h2><p>Indicadores financeiros e volume de transações</p></div>
        </div>
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
      </section>
      <section class="dashboard-block dashboard-operation">
        <div class="dashboard-block-heading">
          ${icon("query_stats")}
          <div><h2>Operação recente</h2><p>Movimentações financeiras e situação do estoque</p></div>
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
            <div class="transactions transactions-scroll transactions-scroll--low-stock">
              ${lowStock.map((item) => {
    const stock = productStockDetails(item);
    return `
                  <div class="transaction-row">
                    <div><strong>${escapeHtml(item.name)}</strong><div class="muted">EAN: ${escapeHtml(item.barcode || "-")}</div></div>
                    <div class="stock-level stock-level--summary">
                      <span class="badge ${stock.badgeClass}">${escapeHtml(stock.label)}</span>
                      <strong class="stock-level-value">${escapeHtml(stock.quantityLabel)}</strong>
                    </div>
                  </div>
                `;
  }).join("") || `<p class="muted">Nenhum produto com estoque baixo.</p>`}
            </div>
          </section>
        </div>
      </section>
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
        ${item.kind === "sale" || !item.isCancelled ? `<button class="icon-btn" type="button" aria-label="Opções da transação" aria-haspopup="dialog" data-transaction-kind="${item.kind}" data-transaction-id="${escapeHtml(String(item.refId))}">${icon("expand_more")}</button>` : ""}
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
  const openRegister = currentOpenRegister();
  if (!openRegister) {
    return `<section class="section-block empty-state" style="min-height: 420px; display:grid; place-items:center;"><div style="text-align:center">${icon("shopping_cart")}<h2>Por favor, ABRA o caixa primeiro!</h2><button class="btn" data-action="open-register">${icon("lock_open")} Abrir Caixa</button></div></section>`;
  }
  const filtered = state.data.products
    .filter((item) => `${item.name} ${item.barcode || ""}`.toLowerCase().includes(state.search.toLowerCase()))
    .sort(compareProductsByAvailabilityAndName);
  const total = state.cart.reduce((sum, item) => sum + item.product.sellingPrice * item.quantity, 0);
  const finalTotal = Math.max(0, total - state.discount);
  return `
    <section class="section-block pos-layout pos-section-block">
      <div class="pos-products">
        ${sectionBlockHeading("Produtos", "Pesquise e adicione itens ao pedido", "inventory_2")}
        <label class="field search"><span>Pesquisar</span><span class="input-wrap">${icon("search")}<input id="posSearch" value="${escapeHtml(state.search)}" placeholder="Pesquisar por nome ou codigo..." /></span></label>
        <div class="product-list">
          ${filtered.map((product) => {
    const tracksStock = productTracksStock(product);
    const out = tracksStock && Number(product.stockQuantity) <= 0;
    const stockLabel = tracksStock ? String(Number(product.stockQuantity) || 0) : "∞";
    return `
              <button class="product-row ${out ? "out" : ""}" data-add-cart="${product.id}">
                <span><strong>${escapeHtml(product.name)}</strong><span class="muted"><br>${money.format(product.sellingPrice || 0)} / ${escapeHtml(product.unit || "UN")} · Estoque: ${stockLabel}</span></span>
                ${out ? `<span class="badge bad">ESGOTADO</span>` : icon("add")}
              </button>
            `;
  }).join("") || `<p class="muted">Nenhum produto encontrado.</p>`}
        </div>
      </div>
      <aside class="pos-cart">
        ${sectionBlockHeading("Resumo do pedido", "Itens, quantidades e total da venda", "shopping_cart")}
        <div class="toolbar pos-cart-actions">${state.cart.length ? `<button class="btn danger" data-action="cart-clear">${icon("delete_sweep")} Limpar</button>` : ""}</div>
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
  const rows = state.data.products
    .filter((item) => `${item.name} ${item.barcode || ""}`.toLowerCase().includes(state.search.toLowerCase()))
    .filter((item) => productMatchesStockFilter(item, state.filters.inventoryStockLevel))
    .sort(compareProductsByStockLevelAndName);
  const stockFilter = `
    <label class="field inventory-stock-filter"><span>Nível de estoque</span><span class="input-wrap">${icon("filter_list")}<select id="inventoryStockLevelFilter">
      ${[["ALL", "Todos"], ["ACCEPTABLE", "Produto em estoque"], ["LOW", "Estoque baixo"], ["OUT", "Sem estoque"], ["UNLIMITED", "Estoque ilimitado"]].map(([value, label]) => `<option value="${value}" ${state.filters.inventoryStockLevel === value ? "selected" : ""}>${label}</option>`).join("")}
    </select></span></label>
  `;
  return tableSection("inventorySearch", ["Produto", "Categoria", "Fornecedor", "Preco", "Estoque", ""], rows.map((item) => {
    const category = state.data.categories.find((cat) => Number(cat.id) === Number(item.categoryId));
    const supplier = state.data.suppliers.find((sup) => Number(sup.id) === Number(item.supplierId));
    const stock = productStockDetails(item);
    return `
      <tr>
        <td><strong>${escapeHtml(item.name)}</strong><div class="muted">EAN: ${escapeHtml(item.barcode || "-")}</div></td>
        <td>${escapeHtml(category?.name || "-")}</td>
        <td>${escapeHtml(supplier?.name || "-")}</td>
        <td>${money.format(item.sellingPrice || 0)}</td>
        <td>
          <div class="stock-level">
            <span class="badge ${stock.badgeClass}">${escapeHtml(stock.label)}</span>
            <strong class="stock-level-value">${escapeHtml(stock.quantityLabel)}</strong>
            ${stock.minimumLabel ? `<small class="muted">Mínimo: ${escapeHtml(stock.minimumLabel)}</small>` : ""}
          </div>
        </td>
        <td><button class="icon-btn" data-edit-product="${item.id}" title="Editar">${icon("edit")}</button><button class="icon-btn" data-delete-product="${item.id}" title="Excluir">${icon("delete")}</button></td>
      </tr>
    `;
  }).join(""), stockFilter, "inventory-filters-toolbar", "Produtos cadastrados");
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
        <td>${escapeHtml(publicStockMovementReason(item.reason) || "-")}</td>
      </tr>
    `;
  }).join(""), "", "", "Movimentações de estoque");
}

function tableSection(searchId, headers, rows, extraFilters = "", toolbarClass = "", sectionTitle = "Registros") {
  return `
    <section class="section sectioned-page">
      <section class="section-block filter-section-block">
        ${sectionBlockHeading("Filtros", "Use a busca e os filtros disponíveis para localizar registros", "filter_alt")}
        <div class="toolbar section-filters ${toolbarClass}">
          <label class="field search"><span>Pesquisar</span><span class="input-wrap">${icon("search")}<input id="${searchId}" value="${escapeHtml(state.search)}" placeholder="Pesquisar..." /></span></label>
          ${extraFilters}
        </div>
      </section>
      <section class="section-block data-table-block">
        ${sectionBlockHeading(sectionTitle, "Dados disponíveis nesta seção", "table_rows")}
        <div class="table-wrap">
          <table>
            <thead><tr>${headers.map((item) => `<th>${item}</th>`).join("")}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${headers.length}" class="muted">Nenhum registro encontrado.</td></tr>`}</tbody>
          </table>
        </div>
      </section>
    </section>
  `;
}

function renderCash() {
  const open = currentOpenRegister();
  const report = open ? registerReport(open) : null;
  return `
    <section class="section sectioned-page cash-page">
      <section class="section-block cash-summary-block">
        ${sectionBlockHeading("Situação do caixa", "Status, saldos e ações do caixa atual", "point_of_sale")}
        <div class="grid cols-3 sectioned-metrics">
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
      </section>
      <section class="section-block cash-movements-block">
        ${sectionBlockHeading("Movimentos financeiros", "Vendas, entradas e saídas do caixa", "receipt_long")}
        <div class="toolbar cash-actions"><div><button class="btn secondary" data-action="entry-new" ${open ? "" : 'disabled title="Abra o caixa para fazer uma venda"'}>${icon("add")} Venda manual</button> <button class="btn secondary" data-action="exit-new" ${open ? "" : 'disabled title="Abra o caixa para registrar uma saída"'}>${icon("remove")} Saida</button></div></div>
        <div class="transactions transactions-scroll transactions-scroll--cash">${renderGroupedTransactionRows(allTransactions()) || `<p class="muted">Sem movimentos.</p>`}</div>
      </section>
    </section>
  `;
}

function registerReport(register) {
  const registerId = Number(register.id);
  const registerSales = state.data.sales
    .filter((item) => {
      const sale = saleData(item);
      return Number(sale.cashRegisterId) === registerId && !saleIsCancelled(item);
    });
  const sales = registerSales.reduce((sum, item) => sum + saleAmount(item), 0);
  const cashSales = registerSales.reduce((sum, item) => sum + salePaymentParts(item)
    .filter((part) => paymentMethodGroup(part.method) === "CASH")
    .reduce((subtotal, part) => subtotal + part.amount, 0), 0);
  const registerEntries = state.data.entries
    .filter((item) => Number(item.cashRegisterId) === registerId && !item.isCancelled);
  const entries = registerEntries
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const cashEntries = registerEntries
    .filter((item) => paymentMethodGroup(item.paymentMethod) === "CASH")
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const registerExits = state.data.exits
    .filter((item) => Number(item.cashRegisterId) === registerId && !item.isCancelled);
  const exits = registerExits
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const cashExits = registerExits
    .filter((item) => paymentMethodGroup(item.paymentMethod) === "CASH")
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const expected = calculateExpectedRegisterBalance({
    initialBalance: register.initialBalance,
    sales,
    entries,
    exits,
  });
  const closing = register.closingBalance == null ? null : Number(register.closingBalance);
  return { sales, entries, exits, cashSales, cashEntries, cashExits, expected, closing, difference: closing == null ? null : closing - expected };
}

function parseMoneyCents(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  }
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s/g, "")
    .replace(/^R\$/i, "");
  if (!/^\d[\d.,]*$/.test(normalized)) return null;

  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  const lastSeparator = Math.max(lastComma, lastDot);
  const trailingDigits = lastSeparator >= 0 ? normalized.length - lastSeparator - 1 : 0;
  const hasBothSeparators = lastComma >= 0 && lastDot >= 0;
  const shouldUseDecimals = lastSeparator >= 0 && (
    hasBothSeparators || trailingDigits === 1 || trailingDigits === 2
  );
  const integerPart = shouldUseDecimals ? normalized.slice(0, lastSeparator) : normalized;
  const fraction = shouldUseDecimals ? normalized.slice(lastSeparator + 1) : "";
  if (shouldUseDecimals && !/^\d{1,2}$/.test(fraction)) return null;

  const integerGroups = integerPart.split(/[.,]/);
  if (integerGroups.some((group) => !/^\d+$/.test(group))) return null;
  if (integerGroups.length > 1 && (
    !/^\d{1,3}$/.test(integerGroups[0]) ||
    integerGroups.slice(1).some((group) => group.length !== 3)
  )) return null;

  const whole = integerGroups.join("");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

function formatMoneyCentsInput(cents) {
  return (Math.max(0, Number(cents) || 0) / 100).toFixed(2).replace(".", ",");
}

function cartTotals(cartItems = state.cart) {
  const totalCents = Math.max(0, Math.round(cartItems.reduce(
    (sum, item) => sum + (Number(item.product?.sellingPrice) || 0) * (Number(item.quantity) || 0),
    0
  ) * 100));
  const discountCents = Math.min(
    Math.max(0, Math.round(parseDecimal(state.discount) * 100)),
    totalCents
  );
  return { totalCents, discountCents, finalCents: totalCents - discountCents };
}

function normalizeCheckoutPayments(payments, totalCents) {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    throw new Error("O total da venda deve ser maior que zero.");
  }
  if (!Array.isArray(payments) || payments.length < 1 || payments.length > 2) {
    throw new Error("Informe uma ou duas formas de pagamento.");
  }
  const normalized = payments.map((part) => ({
    method: normalizePaymentMethod(part?.method),
    amountCents: Number(part?.amountCents),
  }));
  if (normalized.some((part) => !paymentOptions.some(([method]) => method === part.method))) {
    throw new Error("Selecione uma forma de pagamento valida.");
  }
  if (normalized.some((part) => !Number.isSafeInteger(part.amountCents) || part.amountCents <= 0)) {
    throw new Error(payments.length === 2
      ? "Informe um valor maior que zero nos dois pagamentos."
      : "Informe um valor de pagamento maior que zero.");
  }
  if (normalized.length === 2 && normalized[0].method === normalized[1].method) {
    throw new Error("Selecione duas formas de pagamento diferentes.");
  }
  const informedCents = normalized.reduce((sum, part) => sum + part.amountCents, 0);
  if (informedCents < totalCents) {
    throw new Error(`Faltam ${money.format((totalCents - informedCents) / 100)} para completar o total.`);
  }
  if (informedCents > totalCents) {
    throw new Error(`O valor informado excede o total em ${money.format((informedCents - totalCents) / 100)}.`);
  }
  return normalized;
}

function renderCashHistory() {
  const bounds = dateInputBounds(state.filters.cashHistoryDate);
  const rows = [...state.data.registers]
    .filter((item) => inBounds(item.openingTimestamp, bounds))
    .sort((a, b) => (Number(b.openingTimestamp) || 0) - (Number(a.openingTimestamp) || 0));
  return `
    <section class="section sectioned-page">
      <section class="section-block filter-section-block">
        ${sectionBlockHeading("Filtros", "Consulte os caixas por data de abertura", "filter_alt")}
        <div class="toolbar section-filters filters-toolbar">
        <label class="field date-filter">
          <span>${state.filters.cashHistoryDate ? `Filtrando: ${formatDateInputLabel(state.filters.cashHistoryDate)}` : "Filtrar por data"}</span>
          <span class="input-wrap">${icon("calendar_month")}<input id="cashHistoryDate" type="date" value="${escapeHtml(state.filters.cashHistoryDate)}" /></span>
        </label>
        ${state.filters.cashHistoryDate ? `<button class="btn secondary" data-action="clear-cash-history-filter">${icon("filter_list_off")} Limpar filtro</button>` : ""}
        </div>
      </section>
      <section class="section-block data-table-block">
        ${sectionBlockHeading("Histórico de caixas", "Aberturas, fechamentos, saldos e diferenças", "history")}
        <div class="table-wrap"><table>
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
        </table></div>
      </section>
    </section>
  `;
}

function renderCategories() {
  return tableSection("genericSearch", ["Nome", ""], state.data.categories
    .filter((item) => item.name.toLowerCase().includes(state.search.toLowerCase()))
    .map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td><button class="icon-btn" data-edit-category="${item.id}">${icon("edit")}</button><button class="icon-btn" data-delete-category="${item.id}">${icon("delete")}</button></td></tr>`).join(""), "", "", "Categorias cadastradas");
}

function renderSuppliers() {
  return tableSection("genericSearch", ["Nome", "Contato", "Email", ""], state.data.suppliers
    .filter((item) => `${item.name} ${item.contact || ""} ${item.email || ""}`.toLowerCase().includes(state.search.toLowerCase()))
    .map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.contact || "-")}</td><td>${escapeHtml(item.email || "-")}</td><td><button class="icon-btn" data-edit-supplier="${item.id}">${icon("edit")}</button><button class="icon-btn" data-delete-supplier="${item.id}">${icon("delete")}</button></td></tr>`).join(""), "", "", "Fornecedores cadastrados");
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
    }).join(""), "", "", "Usuários cadastrados");
}

const receivableStatusLabels = {
  OPEN: "Em aberto",
  PARTIAL: "Parcial",
  PAID: "Paga",
  OVERDUE: "Atrasada",
  CANCELLED: "Cancelada",
};

function receivableStatusBadge(status) {
  const classes = {
    OPEN: "manual",
    PARTIAL: "warn",
    PAID: "good",
    OVERDUE: "bad",
    CANCELLED: "bad",
  };
  return `<span class="badge ${classes[status] || ""}">${escapeHtml(receivableStatusLabels[status] || status)}</span>`;
}

function receivablesDataReady() {
  return state.receivables.loadedCollections.size >= Object.keys(receivablesCollections).length;
}

function findReceivableCustomer(customerId) {
  return state.receivables.customers.find((customer) => String(customer.id ?? "") === String(customerId)
    || String(customer.docId ?? "") === String(customerId));
}

function findReceivable(receivableId) {
  return state.receivables.receivables.find((receivable) => String(receivable.id ?? "") === String(receivableId)
    || String(receivable.docId ?? "") === String(receivableId));
}

function formatReceivableDueDate(value) {
  const millis = normalizeTimestamp(value);
  return millis ? dateOnly.format(new Date(millis)) : "-";
}

function renderReceivables() {
  const access = accountsReceivableAccess();
  if (!access.visible) return `<section class="section"></section>`;

  const showingCustomers = state.filters.receivablesView !== "debts";
  const customerSearch = String(state.filters.receivablesCustomerSearch || "").trim().toLocaleLowerCase("pt-BR");
  const search = String(state.filters.receivablesSearch || "").trim().toLocaleLowerCase("pt-BR");
  const filteredByStatus = filterReceivables(
    state.receivables.receivables,
    state.filters.receivablesStatus,
  );
  const matchingAccounts = filteredByStatus.filter((receivable) => {
    if (!search) return true;
    return `${receivable.customerName || ""} ${receivable.description || ""}`.toLocaleLowerCase("pt-BR").includes(search);
  });
  const accounts = groupReceivablesByCustomer(matchingAccounts);
  const customers = state.receivables.customers
    .filter((customer) => customer.isActive !== false)
    .filter((customer) => !customerSearch || `${customer.name || ""} ${customer.phone || ""} ${customer.document || ""}`.toLocaleLowerCase("pt-BR").includes(customerSearch))
    .sort((left, right) => String(left.name || "").trim().localeCompare(String(right.name || "").trim(), "pt-BR", { sensitivity: "base" }));
  const summary = receivablesSummary(state.receivables.receivables);

  return `
    <section class="section receivables-page sectioned-page">
      <header class="receivables-view-header">
        <div><h2>Clientes e contas</h2><p class="muted">Selecione a visualização que deseja consultar.</p></div>
        <div class="receivables-view-switch" role="group" aria-label="Visualização de clientes e contas">
          <button type="button" id="receivablesViewCustomers" data-receivables-view="customers" aria-pressed="${showingCustomers}" aria-controls="receivablesList">${icon("group")} Clientes</button>
          <button type="button" id="receivablesViewDebts" data-receivables-view="debts" aria-pressed="${!showingCustomers}" aria-controls="receivablesList">${icon("receipt_long")} Dívidas</button>
        </div>
      </header>
      <section class="section-block receivables-summary-block">
        ${sectionBlockHeading("Resumo de recebimentos", "Saldos pendentes, atrasados e recebidos", "account_balance_wallet")}
        <div class="grid receivables-metrics sectioned-metrics">
        <article class="panel metric primary"><span>Total a receber</span><strong>${money.format(summary.outstandingAmountCents / 100)}</strong><small>${state.receivables.receivables.filter((item) => ["OPEN", "PARTIAL", "OVERDUE"].includes(receivableDisplayStatus(item))).length} conta(s) pendente(s)</small></article>
        <article class="panel metric tertiary"><span>Total atrasado</span><strong>${money.format(summary.overdueAmountCents / 100)}</strong><small>Saldo com vencimento anterior a hoje</small></article>
        <article class="panel metric secondary"><span>Total recebido</span><strong>${money.format(summary.receivedAmountCents / 100)}</strong><small>Pagamentos registrados neste módulo</small></article>
        </div>
      </section>

      ${!showingCustomers ? `<section id="receivablesList" class="section-block receivables-accounts-block" aria-label="Dívidas">
        <div class="toolbar receivables-toolbar">
          <div><h2>Contas a receber</h2><p class="muted">Contas cadastradas manualmente, sem ligação automática com vendas.</p></div>
          <div class="receivables-filters">
            <label class="field"><span>Situação</span><span class="input-wrap">${icon("filter_list")}<select id="receivablesStatusFilter">
              ${[["ALL", "Todas"], ["OPEN", "Em aberto"], ["PARTIAL", "Parciais"], ["PAID", "Pagas"], ["OVERDUE", "Atrasadas"], ["CANCELLED", "Canceladas"]].map(([value, label]) => `<option value="${value}" ${state.filters.receivablesStatus === value ? "selected" : ""}>${label}</option>`).join("")}
            </select></span></label>
            <label class="field receivables-search"><span>Buscar</span><span class="input-wrap">${icon("search")}<input id="receivablesSearch" value="${escapeHtml(state.filters.receivablesSearch)}" placeholder="Cliente ou descrição" /></span></label>
          </div>
        </div>
        ${receivablesDataReady() ? `
          <div class="table-wrap receivables-list-scroll" tabindex="0" role="region" aria-label="Lista de contas a receber"><table class="receivables-table">
            <thead><tr><th>Cliente</th><th>Descrição</th><th>Valor original</th><th>Saldo</th><th>Vencimento</th><th>Situação</th><th>Ações</th></tr></thead>
            <tbody>${accounts.map((receivable) => {
    const status = receivableDisplayStatus(receivable);
    const customer = findReceivableCustomer(receivable.customerId);
    const key = escapeHtml(docKey(receivable));
    const canReceive = access.canCollect && Number(receivable.outstandingAmountCents) > 0 && !["PAID", "CANCELLED"].includes(status);
    const hasPhone = Boolean(String(customer?.phone || "").replace(/\D/g, ""));
    return `<tr>
                <td>${customer ? `<button type="button" class="receivable-customer-link" data-receivable-customer-history="${escapeHtml(docKey(customer))}" aria-haspopup="dialog">${escapeHtml(receivable.customerName || customer.name || "Cliente")}</button>` : `<strong>${escapeHtml(receivable.customerName || "Cliente")}</strong>`}</td>
                <td>${escapeHtml(receivable.description || "Conta manual")}</td>
                <td>${money.format((Number(receivable.originalAmountCents) || 0) / 100)}</td>
                <td><strong>${money.format((Number(receivable.outstandingAmountCents) || 0) / 100)}</strong></td>
                <td>${escapeHtml(formatReceivableDueDate(receivable.dueAt))}</td>
                <td>${receivableStatusBadge(status)}</td>
                <td class="receivables-row-actions">
                  ${canReceive ? `<button class="icon-btn" data-receivable-payment="${key}" title="Registrar pagamento">${icon("payments")}</button>` : ""}
                  <button class="icon-btn" data-receivable-history="${key}" title="Histórico de pagamentos">${icon("history")}</button>
                  ${hasPhone && Number(receivable.outstandingAmountCents) > 0 && status !== "CANCELLED" ? `<button class="icon-btn" data-receivable-whatsapp="${key}" title="Enviar lembrete pelo WhatsApp">${icon("chat")}</button>` : ""}
                  ${access.canCollect && ["OPEN", "PARTIAL", "OVERDUE", "PAID", "CANCELLED"].includes(status) ? `<button class="btn secondary compact" data-cancel-receivable="${key}" title="${status === "CANCELLED" ? "Apagar do histórico" : "Cancelar lançamento"}">${icon("cancel")} ${status === "CANCELLED" ? "Apagar" : "Cancelar"}</button>` : ""}
                </td>
              </tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">Nenhuma conta encontrada para este filtro.</td></tr>`}</tbody>
          </table></div>
        ` : `<p class="muted">Carregando clientes e contas...</p>`}
      </section>

      ` : ` <section id="receivablesList" class="section-block receivables-customers-block" aria-label="Clientes">
        <div class="toolbar receivables-toolbar"><div><h2>Clientes</h2><p class="muted">Selecione um cliente para ver suas dívidas e pagamentos.</p></div><label class="field receivables-search"><span>Buscar cliente</span><span class="input-wrap">${icon("search")}<input id="receivablesCustomerSearch" value="${escapeHtml(state.filters.receivablesCustomerSearch || "")}" placeholder="Nome, telefone ou documento" /></span></label></div>
        <div class="table-wrap receivables-list-scroll" tabindex="0" role="region" aria-label="Lista de clientes"><table class="receivables-customers-table">
          <thead><tr><th>Nome</th><th>Telefone</th><th>Documento</th><th>Observações</th><th>Ações</th></tr></thead>
          <tbody>${customers.map((customer) => {
    const key = escapeHtml(docKey(customer));
    return `<tr>
              <td><button type="button" class="receivable-customer-link" data-receivable-customer-history="${key}" aria-haspopup="dialog">${escapeHtml(customer.name || "-")}</button></td>
              <td>${escapeHtml(customer.phone || "-")}</td>
              <td>${escapeHtml(customer.document || "-")}</td>
              <td>${escapeHtml(customer.notes || "-")}</td>
              <td class="receivables-row-actions">
                <button class="btn secondary receivable-customer-history-button" data-receivable-customer-history="${key}" title="Histórico individual de pagamentos" aria-label="Histórico individual de pagamentos de ${escapeHtml(customer.name || "cliente")}">${icon("history")} Histórico</button>
                ${access.canCreate ? `<button class="icon-btn" data-receivable-customer-account="${key}" title="Criar conta manual">${icon("post_add")}</button><button class="icon-btn" data-edit-receivable-customer="${key}" title="Editar cliente">${icon("edit")}</button><button class="icon-btn" data-remove-receivable-customer="${key}" title="Remover cliente">${icon("delete")}</button>` : ""}
              </td>
            </tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">Nenhum cliente encontrado.</td></tr>`}</tbody>
        </table></div>
      </section>
    `}
    </section>
  `;
}

function reportSales(bounds) {
  return state.data.sales.filter((item) => {
    return !saleIsCancelled(item) && inBounds(saleTimestamp(item), bounds);
  });
}

function analyticsSales() {
  return state.data.sales.map((record) => {
    const sale = saleData(record);
    return {
      timestamp: saleTimestamp(record),
      amount: saleAmount(record),
      isCancelled: saleIsCancelled(record),
      customerName: sale.customerName || sale.customer_name || "",
      payments: salePaymentParts(record),
      items: saleItems(record).map((item) => ({
        productId: item.productId ?? item.product_id,
        productName: item.productName || item.product_name || "",
        quantity: Number(item.quantity) || 0,
        subtotal: Number(item.subtotal) || (Number(item.unitPrice ?? item.unit_price) || 0) * (Number(item.quantity) || 0),
      })),
    };
  });
}

function renderAnalyticsRanking(title, rows, valueFormatter, emptyMessage = "Sem dados neste período.") {
  const maximum = Math.max(0, ...rows.map((item) => Number(item.value ?? item.revenue ?? item.quantity) || 0));
  return `<article class="panel analytics-ranking"><h3>${escapeHtml(title)}</h3><div class="analytics-ranking__rows">${rows.map((item, index) => {
    const value = Number(item.value ?? item.revenue ?? item.quantity) || 0;
    const width = maximum > 0 ? Math.max(5, (value / maximum) * 100) : 0;
    return `<div class="analytics-ranking__row"><div><span>${index + 1}. ${escapeHtml(item.name)}</span><strong>${escapeHtml(valueFormatter(item))}</strong></div><i style="width:${width.toFixed(1)}%"></i></div>`;
  }).join("") || `<p class="muted">${escapeHtml(emptyMessage)}</p>`}</div></article>`;
}

function renderBusinessAnalytics(analytics) {
  return `<section class="business-analytics">
    <div class="report-subsection-heading"><h3>Análises detalhadas</h3><span>Rankings e padrões do período</span></div>
    <div class="analytics-grid">
      ${renderAnalyticsRanking("Produtos mais vendidos", analytics.topProducts, (item) => `${formatDecimalInput(item.quantity)} un. · ${money.format(item.revenue)}`)}
      ${renderAnalyticsRanking("Formas de pagamento", analytics.paymentMethods, (item) => money.format(item.value))}
      ${renderAnalyticsRanking("Horários de maior movimento", analytics.peakHours, (item) => money.format(item.value))}
      ${renderAnalyticsRanking("Dias da semana", analytics.peakWeekdays, (item) => money.format(item.value))}
      ${analytics.topCustomers.length ? renderAnalyticsRanking("Clientes com maiores compras", analytics.topCustomers, (item) => money.format(item.value)) : ""}
      <article class="panel analytics-ranking"><h3>Produtos sem saída</h3><div class="analytics-inactive">${analytics.inactiveProducts.map((item) => `<div><span>${escapeHtml(item.name)}</span><strong>Estoque: ${escapeHtml(formatDecimalInput(item.stockQuantity))}</strong></div>`).join("") || '<p class="muted">Todos os produtos tiveram saída no período.</p>'}</div></article>
    </div>
  </section>`;
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
        && !/^Cancelamento\s+(?:de\s+)?venda/i.test(reason)
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
        reason: publicStockMovementReason(item.reason) || "Entrada manual",
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
    totals.total += amount;
    totals.stock += amount;
    salePaymentParts(record).forEach((part) => {
      const group = paymentMethodGroup(part.method);
      if (group === "PIX") totals.pix += part.amount;
      else if (group === "CARD") totals.card += part.amount;
      else if (group === "CASH") totals.cash += part.amount;
      else totals.other += part.amount;
    });
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
      detail: salePaymentSummary(record),
      paymentParts: salePaymentParts(record),
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
  return [...saleRows, ...movementRows, ...stockRows].sort((a, b) => b.timestamp - a.timestamp);
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
  const analytics = calculateBusinessAnalytics({ sales: analyticsSales(), products: state.data.products, bounds });
  return `
    <section class="section">
      <article class="section-block report-export report-export--sales">
        ${sectionBlockHeading("Relatório de vendas", "Selecione o período para consultar ou exportar", "monitoring")}
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
                    <option value="custom" ${state.filters.reportsPeriod === "custom" ? "selected" : ""}>Período personalizado</option>
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
              <label class="field report-date"><span>Início</span><span class="input-wrap">${icon("date_range")}<input id="reportStartDate" type="date" value="${escapeHtml(state.filters.reportsStartDate)}" /></span></label>
              <label class="field report-date"><span>Fim</span><span class="input-wrap">${icon("event_available")}<input id="reportEndDate" type="date" value="${escapeHtml(state.filters.reportsEndDate)}" /></span></label>
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
        <div class="report-block-heading">
          ${icon("account_balance_wallet")}
          <div><h2>Resumo financeiro</h2><p>${escapeHtml(periodLabel)}</p></div>
        </div>
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
            <span>Vendas no cartão</span>
            <strong>${money.format(paymentTotals.card)}</strong>
            <small>Total recebido em cartão</small>
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
      ${renderBusinessAnalytics(analytics)}
      <div class="panel table-wrap report-table">
        <div class="report-section-heading">
          <div>
            <h2>Vendas e movimentações</h2>
            <p>${escapeHtml(periodLabel)} · Registros mais recentes primeiro</p>
          </div>
          <div class="report-sales-total"><span>Total em vendas</span><strong>${money.format(sold)}</strong><small>Vendas de produtos + vendas manuais</small></div>
        </div>
        <div class="report-table-scroll">
          <table class="consolidated-report-table"><thead><tr><th>Horário</th><th>Movimentação</th><th>Produto ou descrição</th><th>Pagamento / detalhes</th><th>Quantidade</th><th>Valor da movimentação</th></tr></thead><tbody>
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
  const isStock = item.amount == null;
  const amount = isStock ? "Sem valor financeiro" : money.format(item.amount);
  const typeLabel = isStock ? "Entrada de estoque" : item.type === "VENDA" ? "Venda de produtos" : item.type === "VENDA MANUAL" ? "Venda manual" : item.type === "SAIDA" ? "Saída de dinheiro" : item.type;
  const detail = item.paymentParts?.length
    ? `<div class="report-payment-parts">${item.paymentParts.map((part) => `<span><span>${escapeHtml(paymentMethodLabel(part.method))}</span><strong>${escapeHtml(money.format(part.amount))}</strong></span>`).join("")}</div>`
    : escapeHtml(item.detail || "—");
  return `
    <tr class="${isStock ? "report-stock-row" : ""}">
      <td><time title="${item.timestamp ? escapeHtml(dateTime.format(new Date(item.timestamp))) : ""}">${item.timestamp ? new Date(item.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—"}</time></td>
      <td><span class="badge ${isStock ? "report-stock-badge" : escapeHtml(item.typeClass || (item.amountClass === "minus" ? "bad" : "good"))}">${escapeHtml(typeLabel)}</span></td>
      <td>${escapeHtml(item.description)}${item.isCancelled ? ` <span class="badge bad">CANCELADA</span>` : ""}</td>
      <td>${detail}</td>
      <td>${escapeHtml(item.quantity || "-")}</td>
      <td>${isStock ? `<span class="muted report-no-value">${amount}</span>` : `<strong class="amount ${item.isCancelled ? "muted" : item.amountClass}">${escapeHtml(amount)}</strong>${item.isCancelled ? '<small class="report-value-note">Não entra no total</small>' : ""}`}</td>
    </tr>
  `;
}

function renderSettings() {
  return `
    <section class="section sectioned-page settings-page">
      <article class="section-block settings-theme">
        ${sectionBlockHeading("Personalização", "Ajuste a aparência do sistema", "palette")}
        ${select("themeSelect", "Tema", themeOptions, state.theme)}
      </article>
      ${isAdmin() ? `
        <section class="section-block settings-management-block">
          ${sectionBlockHeading("Gestão do sistema", "Cadastros, históricos, relatórios e auditoria", "admin_panel_settings")}
          <div class="settings-grid">
            <button class="settings-row" data-view="users">${icon("manage_accounts")}<span><strong>Gerenciar Usuarios</strong><small>Criar funcionarios, alterar senhas e status</small></span></button>
            <button class="settings-row" data-view="reports">${icon("monitoring")}<span><strong>Relatorios e Exportacao</strong><small>PDF, Excel e backup de dados</small></span></button>
            <button class="settings-row" data-view="cashHistory">${icon("receipt_long")}<span><strong>Historico de Caixa</strong><small>Fechamentos, saldos e diferencas</small></span></button>
            <button class="settings-row" data-view="stockHistory">${icon("history")}<span><strong>Historico de Estoque</strong><small>Entradas, saidas e ajustes</small></span></button>
            <button class="settings-row" data-view="audit">${icon("policy")}<span><strong>Registro de Auditoria</strong><small>Quem fez cada operação e quando</small></span></button>
            <button class="settings-row" data-view="categories">${icon("category")}<span><strong>Categorias</strong><small>Cadastro auxiliar de produtos</small></span></button>
            <button class="settings-row" data-view="suppliers">${icon("local_shipping")}<span><strong>Fornecedores</strong><small>Cadastro auxiliar de produtos</small></span></button>
          </div>
        </section>
      ` : ""}
      <section class="section-block danger-zone">
        ${sectionBlockHeading("Sessão da empresa", "Controles da empresa ativa neste dispositivo", "domain")}
        <button class="settings-row" data-action="exit-company">${icon("domain_disabled")}<span><strong>Sair da empresa</strong><small>Encerra a conta e remove a empresa ativa deste dispositivo</small></span></button>
      </section>
    </section>
  `;
}

function bindViewEvents() {
  document.querySelectorAll("[data-transaction-kind]").forEach((button) => button.addEventListener("click", () => openTransactionOptions(button.dataset.transactionKind, button.dataset.transactionId)));
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => runNamedAction(button.dataset.action)));
  document.querySelectorAll("[data-close-notifications]").forEach((button) => button.addEventListener("click", closeNotifications));
  document.querySelectorAll("[data-alert-id]").forEach((button) => button.addEventListener("click", () => openAlertDestination(button.dataset.alertId)));
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
  document.querySelector("#inventoryStockLevelFilter")?.addEventListener("change", (event) => {
    state.filters.inventoryStockLevel = event.target.value;
    renderApp();
  });
  document.querySelectorAll("[data-receivables-view]").forEach((button) => button.addEventListener("click", () => {
    state.filters.receivablesView = button.dataset.receivablesView;
    renderApp();
    document.getElementById(button.id)?.focus();
  }));
  document.querySelector("#receivablesCustomerSearch")?.addEventListener("input", (event) => {
    state.filters.receivablesCustomerSearch = event.target.value;
    renderApp("receivablesCustomerSearch");
  });
  document.querySelector("#receivablesStatusFilter")?.addEventListener("change", (event) => {
    state.filters.receivablesStatus = event.target.value;
    renderApp();
  });
  document.querySelector("#receivablesSearch")?.addEventListener("input", (event) => {
    state.filters.receivablesSearch = event.target.value;
    renderApp("receivablesSearch");
  });
  ["reportStartDate", "reportEndDate"].forEach((id) => document.querySelector(`#${id}`)?.addEventListener("change", (event) => {
    state.filters[id === "reportStartDate" ? "reportsStartDate" : "reportsEndDate"] = event.target.value;
    state.filters.reportsPeriod = "custom";
    renderApp();
  }));
  document.querySelector("#auditCategory")?.addEventListener("change", (event) => {
    state.filters.auditCategory = event.target.value;
    renderApp();
  });
  document.querySelector("#auditSearch")?.addEventListener("input", (event) => {
    state.filters.auditSearch = event.target.value;
    renderApp("auditSearch");
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
  document.querySelectorAll("[data-edit-receivable-customer]").forEach((button) => button.addEventListener("click", () => openReceivableCustomerModal(button.dataset.editReceivableCustomer)));
  document.querySelectorAll("[data-receivable-customer-account]").forEach((button) => button.addEventListener("click", () => openReceivableModal(button.dataset.receivableCustomerAccount)));
  document.querySelectorAll("[data-receivable-payment]").forEach((button) => button.addEventListener("click", () => openReceivablePaymentModal(button.dataset.receivablePayment)));
  document.querySelectorAll("[data-receivable-history]").forEach((button) => button.addEventListener("click", () => openReceivablePaymentHistory(button.dataset.receivableHistory)));
  document.querySelectorAll("[data-receivable-customer-history]").forEach((button) => button.addEventListener("click", () => openReceivableCustomerPaymentHistory(button.dataset.receivableCustomerHistory)));
  document.querySelectorAll("[data-receivable-whatsapp]").forEach((button) => button.addEventListener("click", () => openReceivableWhatsapp(button.dataset.receivableWhatsapp)));
  document.querySelectorAll("[data-cancel-receivable]").forEach((button) => button.addEventListener("click", () => cancelReceivable(button.dataset.cancelReceivable)));
  document.querySelectorAll("[data-remove-receivable-customer]").forEach((button) => button.addEventListener("click", () => removeReceivableCustomer(button.dataset.removeReceivableCustomer)));
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

function productTracksStock(product) {
  if (typeof product?.hasStockControl === "boolean") return product.hasStockControl;
  return product?.tracksStock !== false;
}

function productStockDetails(product) {
  const unit = String(product?.unit || "UN");
  if (!productTracksStock(product)) {
    return {
      label: "ESTOQUE ILIMITADO",
      badgeClass: "good",
      quantityLabel: "Sem limite",
      minimumLabel: "",
    };
  }

  const quantity = Number(product?.stockQuantity) || 0;
  const minimum = Number(product?.minStockThreshold) || 0;
  const level = productStockLevel(product);
  if (level === PRODUCT_STOCK_LEVEL.OUT) {
    return {
      label: "SEM ESTOQUE",
      badgeClass: "bad",
      quantityLabel: `0 ${unit}`,
      minimumLabel: `${minimum} ${unit}`,
    };
  }
  if (level === PRODUCT_STOCK_LEVEL.LOW) {
    return {
      label: "ESTOQUE BAIXO",
      badgeClass: "warn",
      quantityLabel: `${quantity} ${unit}`,
      minimumLabel: `${minimum} ${unit}`,
    };
  }
  return {
    label: "PRODUTO EM ESTOQUE",
    badgeClass: "good",
    quantityLabel: `${quantity} ${unit}`,
    minimumLabel: `${minimum} ${unit}`,
  };
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
  const existing = collectionName === collections.products ? findById(state.data.products, id) : null;
  await runAction(
    async () => {
      await deleteDoc(tenantDocument(collectionName, id));
      if (collectionName === collections.products) {
        await writeAuditLog({
          action: "PRODUCT_DELETED", entityType: "product", entityId: id,
          description: `Produto excluído: ${existing?.name || id}.`
        });
      }
    },
    "Registro excluido."
  );
}

async function addCart(productId) {
  const product = findById(state.data.products, productId);
  if (!product) return;
  const existing = state.cart.find((item) => Number(item.product.id) === Number(productId));
  if (existing) {
    if (productTracksStock(product) && existing.quantity + 1 > Number(product.stockQuantity || 0)) {
      await promptAddStockForProduct(product);
      return;
    }
    existing.quantity += 1;
  } else {
    if (productTracksStock(product) && Number(product.stockQuantity || 0) < 1) {
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
  if (productTracksStock(item.product) && nextQty > Number(item.product.stockQuantity || 0)) {
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
  if (productTracksStock(item.product) && nextQty > Number(item.product.stockQuantity || 0)) {
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
  "receivable-customer-new": () => openReceivableCustomerModal(),
  "receivable-new": () => openReceivableModal(),
  "product-new": () => openProductModal(),
  "category-new": () => openNameModal("Categoria", collections.categories, state.data.categories),
  "supplier-new": () => openSupplierModal(),
  "user-new": () => openUserModal(),
  "stock-adjust": () => openStockAdjustModal(),
  "open-register": () => openRegisterModal(),
  "close-register": () => closeRegister(),
  "entry-new": () => {
    if (!currentOpenRegister()) return toast("Abra o caixa antes de fazer uma venda.");
    openMovementModal("entry");
  },
  "exit-new": () => {
    if (!currentOpenRegister()) return toast("Abra o caixa antes de registrar uma saída.");
    openMovementModal("exit");
  },
  "cart-clear": () => clearCart(),
  "toggle-sidebar": () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    document.querySelector(".app-shell")?.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
    const toggle = document.querySelector(".sidebar-toggle");
    if (toggle) {
      const label = state.sidebarCollapsed ? "Expandir painel lateral" : "Recolher painel lateral";
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
      toggle.innerHTML = icon(state.sidebarCollapsed ? "keyboard_double_arrow_right" : "keyboard_double_arrow_left");
    }
  },
  "focus-content": () => document.querySelector(".main")?.focus(),
  "keyboard-help": () => showKeyboardHelp(),
  "toggle-notifications": () => {
    state.notificationsOpen = !state.notificationsOpen;
    renderApp();
    if (state.notificationsOpen) document.querySelector(".notification-close")?.focus();
  },
  "theme-toggle": () => toggleTheme(),
  "refresh-data": () => renderApp(),
  "export-inventory": () => exportInventoryCsv(),
  "export-backup": () => exportBackupJson(),
  "exit-company": () => exitCompany(),
  "clear-cash-history-filter": () => {
    state.filters.cashHistoryDate = "";
    renderApp();
  },
  logout: () => logout(),
  checkout: () => openCheckoutModal(),
};

function closeNotifications() {
  if (!state.notificationsOpen) return;
  state.notificationsOpen = false;
  renderApp();
  document.querySelector(".notification-trigger")?.focus();
}

function openAlertDestination(alertId) {
  const alert = currentInternalAlerts().find((item) => item.id === alertId);
  if (!alert) return closeNotifications();
  const destination = alertPresentation(alert);
  if (!canAccess(destination.target)) {
    state.notificationsOpen = false;
    renderApp();
    toast("Seu perfil não possui acesso a esta tela.");
    return;
  }
  if (destination.target === "inventory" && destination.filter) state.filters.inventoryStockLevel = destination.filter;
  if (destination.target === "receivables") state.filters.receivablesView = "debts";
  if (destination.target === "receivables" && destination.filter) state.filters.receivablesStatus = destination.filter;
  state.notificationsOpen = false;
  state.view = destination.target;
  state.search = "";
  window.location.hash = `/${destination.target}`;
  renderApp();
}

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
  let submitting = false;
  document.querySelector("#modalForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    const formElement = event.currentTarget;
    const submitButton = formElement.querySelector('button[type="submit"]');
    const closeButtons = [...document.querySelectorAll("[data-close-modal]")];
    formElement.dataset.submitting = "true";
    if (submitButton) submitButton.disabled = true;
    closeButtons.forEach((button) => { button.disabled = true; });
    try {
      const afterSave = await onSubmit(new FormData(formElement));
      state.firebaseError = "";
      delete formElement.dataset.submitting;
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
      submitting = false;
      delete formElement.dataset.submitting;
      if (submitButton) submitButton.disabled = false;
      closeButtons.forEach((button) => { button.disabled = false; });
    }
  });
}

function closeModal() {
  if (document.querySelector("#modalForm[data-submitting='true']")) return;
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

function receivableActorUid() {
  return String(auth.currentUser?.uid || state.user?.uid || state.user?.docId || "");
}

function receivableActorName() {
  return String(state.user?.username || "Usuario");
}

function requireReceivablesCreationAccess() {
  if (!accountsReceivableAccess().canCreate) {
    throw new Error("O adicional precisa estar ativo para cadastrar novos clientes ou contas.");
  }
}

function openReceivableCustomerModal(customerKey = "") {
  const customer = customerKey
    ? state.receivables.customers.find((item) => docKey(item) === String(customerKey))
    : null;
  try {
    requireReceivablesCreationAccess();
  } catch (error) {
    toast(error.message);
    return;
  }
  if (customerKey && !customer) return toast("Cliente nao encontrado.");

  const id = customer?.id || randomUuid();
  openModal(customer ? "Editar cliente" : "Novo cliente", `
    <div class="form-grid">
      <label class="field"><span>Nome *</span><span class="input-wrap">${icon("person")}<input name="name" value="${escapeHtml(customer?.name || "")}" maxlength="120" required /></span></label>
      ${input("phone", "Telefone", customer?.phone || "", "tel")}
      ${input("document", "CPF/CNPJ ou documento", customer?.document || "")}
      <label class="field form-grid-wide"><span>Observações</span><span class="input-wrap textarea-wrap"><textarea name="notes" rows="3" maxlength="500">${escapeHtml(customer?.notes || "")}</textarea></span></label>
    </div>
  `, async (form) => {
    requireReceivablesCreationAccess();
    const name = String(form.get("name") || "").trim();
    const phone = String(form.get("phone") || "").trim();
    const documentNumber = String(form.get("document") || "").trim();
    if (name.length < 2) throw new Error("O nome do cliente deve ter pelo menos 2 caracteres.");
    if (phone.length > 32) throw new Error("O telefone deve ter no máximo 32 caracteres.");
    if (documentNumber.length > 32) throw new Error("O documento deve ter no máximo 32 caracteres.");
    const now = Date.now();
    await setDoc(tenantDocument(receivablesCollections.customers, id), tenantPayload({
      id,
      name,
      phone,
      document: documentNumber,
      notes: String(form.get("notes") || "").trim(),
      isActive: customer?.isActive !== false,
      createdAt: Number(customer?.createdAt) || now,
      updatedAt: now,
      createdByUid: customer?.createdByUid || receivableActorUid(),
      updatedByUid: receivableActorUid(),
    }), { merge: true });
    await writeAuditLog({
      action: customer ? "CUSTOMER_UPDATED" : "CUSTOMER_CREATED",
      entityType: "customer", entityId: id,
      description: `Cliente ${customer ? "atualizado" : "criado"}: ${name}.`
    });
    toast("Cliente salvo.");
  });
}

async function removeReceivableCustomer(customerKey) {
  const customer = findReceivableCustomer(customerKey);
  if (!customer || customer.isActive === false) return toast("Cliente nao encontrado.");
  if (!accountsReceivableAccess().canCreate) return toast("O modulo nao permite remover clientes neste momento.");

  const customerId = String(customer.id || customer.docId || customerKey);
  const linkedAccounts = state.receivables.receivables.filter((receivable) =>
    String(receivable.customerId || "") === customerId
    && receivableDisplayStatus(receivable) !== "CANCELLED"
  );
  const pendingAccounts = linkedAccounts.filter((receivable) =>
    ["OPEN", "PARTIAL", "OVERDUE"].includes(receivableDisplayStatus(receivable))
  );
  const pendingBalanceCents = pendingAccounts.reduce(
    (total, receivable) => total + Math.max(0, Number(receivable.outstandingAmountCents) || 0),
    0,
  );
  const customerName = String(customer.name || "Cliente").trim();
  const form = await openFormDialog("Remover cliente", `
    <p><strong>Atenção:</strong> o cliente será removido da lista e não poderá receber novas contas.</p>
    ${pendingAccounts.length ? `<p class="muted">Existem ${pendingAccounts.length} conta(s) pendente(s), com saldo de <strong>${escapeHtml(money.format(pendingBalanceCents / 100))}</strong>. Elas e todo o histórico serão preservados.</p>` : `<p class="muted">As contas e os pagamentos anteriores serão preservados.</p>`}
    <label class="field"><span>Digite <strong>${escapeHtml(customerName)}</strong> para confirmar</span><span class="input-wrap"><input name="confirmationName" autocomplete="off" required /></span></label>
  `, "Remover cliente", "delete", "danger");
  if (!form) return;

  const normalizeName = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase("pt-BR");
  if (normalizeName(form.get("confirmationName")) !== normalizeName(customerName)) {
    toast("O nome informado nao confere. O cliente nao foi removido.");
    return;
  }

  await runAction(
    async () => {
      await updateDoc(tenantDocument(receivablesCollections.customers, docKey(customer, customerKey)), {
        isActive: false,
        updatedAt: Date.now(),
        updatedByUid: receivableActorUid(),
      });
      await writeAuditLog({
        action: "CUSTOMER_UPDATED", entityType: "customer", entityId: customerId,
        description: `Cliente removido da lista ativa: ${customerName}.`
      });
    },
    "Cliente removido.",
  );
}

function openReceivableModal(preselectedCustomerId = "") {
  try {
    requireReceivablesCreationAccess();
  } catch (error) {
    toast(error.message);
    return;
  }
  const customers = state.receivables.customers
    .filter((customer) => customer.isActive !== false)
    .sort((left, right) => String(left.name || "").trim().localeCompare(String(right.name || "").trim(), "pt-BR", { sensitivity: "base" }));
  if (!customers.length) {
    toast("Cadastre um cliente antes de criar uma conta.");
    openReceivableCustomerModal();
    return;
  }

  const id = randomUuid();
  const today = millisToLocalDateInput(Date.now());
  openModal("Nova conta manual", `
    <div class="form-grid">
      ${select("customerId", "Cliente *", customers.map((customer) => [customer.id || customer.docId, customer.name]), preselectedCustomerId)}
      <label class="field"><span>Valor da conta *</span><span class="input-wrap">${icon("payments")}<input name="amount" inputmode="decimal" placeholder="0,00" required /></span></label>
      <label class="field"><span>Vencimento *</span><span class="input-wrap">${icon("event")}<input name="dueDate" type="date" value="${today}" required /></span></label>
      <label class="field form-grid-wide"><span>Descrição *</span><span class="input-wrap"><input name="description" maxlength="180" placeholder="Ex.: Compra fiada" required /></span></label>
    </div>
  `, async (form) => {
    requireReceivablesCreationAccess();
    const customerId = String(form.get("customerId") || "");
    const customer = findReceivableCustomer(customerId);
    if (!customer || customer.isActive === false) throw new Error("Selecione um cliente ativo.");
    const description = String(form.get("description") || "").trim();
    if (!description) throw new Error("Informe uma descrição para a conta.");
    const originalAmountCents = parseMoneyToCents(form.get("amount"));
    if (!Number.isSafeInteger(originalAmountCents) || originalAmountCents <= 0) {
      throw new Error("Informe um valor válido maior que zero, por exemplo 1.234,56.");
    }
    const dueAt = localDateInputToMillis(form.get("dueDate"));
    if (!dueAt) throw new Error("Informe uma data de vencimento valida.");
    const now = Date.now();
    await setDoc(tenantDocument(receivablesCollections.receivables, id), tenantPayload({
      id,
      customerId: String(customer.id || customer.docId),
      customerName: String(customer.name || "Cliente"),
      description,
      originalAmountCents,
      outstandingAmountCents: originalAmountCents,
      createdAt: now,
      dueAt,
      status: "OPEN",
      lastPaymentId: "",
      lastPaymentAt: 0,
      createdByUid: receivableActorUid(),
      updatedAt: now,
      updatedByUid: receivableActorUid(),
    }));
    await writeAuditLog({
      action: "RECEIVABLE_CREATED", entityType: "receivable", entityId: id,
      description: `Conta lançada para ${customer.name}.`, amountCents: originalAmountCents
    });
    toast("Conta manual cadastrada.");
  });
}

function openReceivablePaymentModal(receivableKey) {
  const receivable = findReceivable(receivableKey);
  const access = accountsReceivableAccess();
  if (!access.canCollect) return toast("O modulo nao permite registrar pagamentos neste momento.");
  if (!receivable) return toast("Conta nao encontrada.");

  const receivableId = String(receivable.id || receivable.docId || "");
  if (pendingReceivablePayments.has(receivableId)) {
    return toast("Já existe um pagamento sendo processado para esta conta.");
  }

  const currentOutstanding = Math.max(0, Math.trunc(Number(receivable.outstandingAmountCents) || 0));
  if (!currentOutstanding || ["PAID", "CANCELLED"].includes(String(receivable.status || "").toUpperCase())) {
    return toast("Esta conta nao possui saldo para receber.");
  }

  openModal("Registrar pagamento", `
    <div class="receivable-payment-heading">
      <span>Saldo atual</span><strong>${money.format(currentOutstanding / 100)}</strong>
    </div>
    <div class="form-grid">
      <label class="field"><span>Valor recebido *</span><span class="input-wrap">${icon("payments")}<input name="amount" inputmode="decimal" value="${escapeHtml(formatMoneyCentsInput(currentOutstanding))}" required /></span></label>
      ${select("paymentMethod", "Forma de pagamento *", paymentOptions, "PIX")}
      <label class="field form-grid-wide"><span>Observações</span><span class="input-wrap textarea-wrap"><textarea name="notes" rows="3" maxlength="300"></textarea></span></label>
    </div>
  `, async (form) => {
    if (!accountsReceivableAccess().canCollect) throw new Error("O modulo nao permite registrar pagamentos neste momento.");
    if (pendingReceivablePayments.has(receivableId)) throw new Error("Esta conta já possui um pagamento em processamento.");
    const amountCents = parseMoneyToCents(form.get("amount"));
    const paymentMethod = normalizePaymentMethod(form.get("paymentMethod"));
    const customerId = String(receivable.customerId || "");
    const notes = String(form.get("notes") || "").trim();
    const createdByUid = receivableActorUid();
    if (!paymentOptions.some(([method]) => method === paymentMethod)) throw new Error("Selecione uma forma de pagamento valida.");
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error("Informe um valor válido, por exemplo 1.234,56.");
    }
    applyReceivablePayment(receivable, amountCents);

    const companyId = tenantId();
    const fingerprint = receivablePaymentFingerprint({
      companyId,
      receivableId,
      customerId,
      expectedOutstandingAmountCents: currentOutstanding,
      amountCents,
      paymentMethod,
      notes,
      createdByUid,
    });
    const operation = getOrCreateReceivablePaymentRetry(companyId, receivableId, fingerprint);
    const paymentId = operation.paymentId;
    let previousPaymentConfirmed = false;

    pendingReceivablePayments.set(receivableId, paymentId);
    try {
      const paymentReference = tenantDocument(receivablesCollections.payments, paymentId);
      const receivableReference = tenantDocument(receivablesCollections.receivables, docKey(receivable));
      await runTransaction(db, async (transaction) => {
        const paymentSnapshot = await transaction.get(paymentReference);
        if (paymentSnapshot.exists()) {
          const previous = paymentSnapshot.data();
          if (!matchesExistingPayment(previous, {
            receivableId: String(receivable.id || receivable.docId),
            customerId,
            amountCents,
            paymentMethod,
            notes,
            createdByUid,
          })) {
            previousPaymentConfirmed = true;
            return;
          }
          return;
        }

        const receivableSnapshot = await transaction.get(receivableReference);
        if (!receivableSnapshot.exists()) throw new Error("Conta nao encontrada no servidor.");
        const serverReceivable = receivableSnapshot.data();
        const next = applyReceivablePayment(serverReceivable, amountCents);
        const timestamp = Math.max(
          Date.now(),
          normalizeTimestamp(serverReceivable.createdAt),
          normalizeTimestamp(serverReceivable.lastPaymentAt),
          normalizeTimestamp(serverReceivable.updatedAt),
        );
        transaction.set(paymentReference, tenantPayload({
          id: paymentId,
          receivableId: String(serverReceivable.id || receivable.id || receivable.docId),
          customerId: String(serverReceivable.customerId || customerId),
          amountCents,
          paymentMethod,
          timestamp,
          notes,
          createdByUid,
        }));
        transaction.update(receivableReference, {
          outstandingAmountCents: next.outstandingAmountCents,
          status: next.status,
          lastPaymentId: paymentId,
          lastPaymentAt: timestamp,
          updatedAt: timestamp,
          updatedByUid: createdByUid,
        });
      });
      clearReceivablePaymentRetry(operation.scope, paymentId);
      if (!previousPaymentConfirmed) {
        await writeAuditLog({
          action: "PAYMENT_RECEIVED", entityType: "receivable_payment", entityId: paymentId,
          description: `Pagamento recebido de ${receivable.customerName || "cliente"}.`, amountCents
        });
      }
    } finally {
      if (pendingReceivablePayments.get(receivableId) === paymentId) {
        pendingReceivablePayments.delete(receivableId);
      }
    }
    toast(previousPaymentConfirmed
      ? "O pagamento anterior já estava confirmado. O saldo foi atualizado sem cobrar novamente."
      : "Pagamento registrado. Lembre-se de lançar a entrada no caixa, se necessário.");
  });
}

async function cancelReceivable(receivableKey) {
  const receivable = findReceivable(receivableKey);
  if (!receivable) return toast("Conta nao encontrada.");
  const status = receivableDisplayStatus(receivable);
  if (!["OPEN", "PARTIAL", "OVERDUE", "PAID", "CANCELLED"].includes(status)) {
    return toast("Esta conta não pode ser cancelada ou apagada.");
  }

  const receivableId = docKey(receivable, receivableKey);
  const alreadyCancelled = status === "CANCELLED";
  let deleteFromHistory = alreadyCancelled;

  if (alreadyCancelled) {
    const confirmed = await openConfirmModal(
      "Apagar lançamento",
      "Deseja apagar definitivamente esta conta e todos os pagamentos vinculados do histórico do cliente?",
      "Apagar do histórico"
    );
    if (!confirmed) return;
  } else {
    deleteFromHistory = await openChoiceModal(
      "Cancelar lançamento",
      "Deseja apagar esta conta e seus pagamentos do histórico? Se escolher NÃO, ela continuará visível como cancelada e poderá ser apagada depois.",
      "Não, manter cancelada",
      "Sim, apagar"
    );
  }

  const password = await requestCancellationPassword();
  if (!password) return;

  await runAction(async () => {
    const reference = tenantDocument(collections.receivables, receivableId);
    if (!alreadyCancelled) {
      await updateDoc(reference, {
        status: "CANCELLED",
        updatedAt: Date.now(),
        updatedByUid: receivableActorUid(),
      });
    }
    if (deleteFromHistory) {
      const paymentSnapshot = await getDocs(query(
        tenantCollection(collections.payments),
        where("receivableId", "==", receivableId)
      ));
      if (paymentSnapshot.size > 498) {
        throw new Error("Esta conta possui pagamentos demais para exclusão automática.");
      }
      const batch = writeBatch(db);
      paymentSnapshot.docs.forEach((paymentDocument) => batch.delete(paymentDocument.ref));
      batch.delete(reference);
      await batch.commit();
      await writeAuditLog({
        action: "RECEIVABLE_DELETED", entityType: "receivable", entityId: receivableId,
        description: `Conta apagada do histórico: ${receivable.description || "Conta manual"}.`,
        amountCents: receivable.originalAmountCents
      });
      return;
    }
    await writeAuditLog({
      action: "RECEIVABLE_CANCELLED", entityType: "receivable", entityId: receivableId,
      description: `Conta mantida como cancelada: ${receivable.description || "Conta manual"}.`,
      amountCents: receivable.originalAmountCents
    });
  }, deleteFromHistory ? "Lançamento apagado do histórico." : "Lançamento mantido como cancelado.");
}

function openReceivablePaymentHistory(receivableKey) {
  const receivable = findReceivable(receivableKey);
  if (!receivable) return toast("Conta nao encontrada.");
  const payments = state.receivables.payments
    .filter((payment) => String(payment.receivableId) === String(receivable.id || receivable.docId))
    .sort((left, right) => normalizeTimestamp(right.timestamp) - normalizeTimestamp(left.timestamp));
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop">
      <section class="modal receivable-history-modal">
        <header><div><h2>Histórico de pagamentos</h2><p class="muted">${escapeHtml(receivable.customerName || "Cliente")} — ${escapeHtml(receivable.description || "Conta manual")}</p></div><button class="icon-btn" type="button" data-close-modal>${icon("close")}</button></header>
        <div class="receivable-history-list">
          ${payments.map((payment) => `<article class="receivable-history-row">
            <div><strong>${money.format((Number(payment.amountCents) || 0) / 100)}</strong><span>${escapeHtml(paymentMethodLabel(payment.paymentMethod))}</span></div>
            <div><span>${escapeHtml(dateTime.format(new Date(normalizeTimestamp(payment.timestamp))))}</span>${payment.notes ? `<small>${escapeHtml(payment.notes)}</small>` : ""}</div>
          </article>`).join("") || `<p class="muted">Nenhum pagamento registrado para esta conta.</p>`}
        </div>
        <footer><button class="btn secondary" type="button" data-close-modal>Fechar</button></footer>
      </section>
    </div>
  `;
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
}

function openReceivableCustomerPaymentHistory(customerKey) {
  const customer = findReceivableCustomer(customerKey);
  if (!customer) return toast("Cliente nao encontrado.");
  const customerId = String(customer.id || customer.docId || "");
  const payments = receivablePaymentsForCustomer(state.receivables.payments, customerId);
  const accounts = state.receivables.receivables
    .filter((account) => String(account.customerId ?? account.customer_id ?? "") === customerId)
    .slice()
    .sort((left, right) => String(left.description || "Conta manual").trim().localeCompare(String(right.description || "Conta manual").trim(), "pt-BR", { sensitivity: "base", numeric: true }));
  const summary = receivablesSummary(accounts);
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop">
      <section class="modal receivable-history-modal receivable-customer-modal" role="dialog" aria-modal="true" aria-labelledby="customerHistoryTitle" tabindex="-1">
        <header><div class="customer-profile"><span class="customer-avatar" aria-hidden="true">${icon("person")}</span><div><span class="customer-eyebrow">Dívidas e histórico</span><h2 id="customerHistoryTitle">${escapeHtml(customer.name || "Cliente")}</h2>${customer.phone ? `<p class="muted">${escapeHtml(customer.phone)}</p>` : ""}</div></div><button class="icon-btn" type="button" data-close-modal aria-label="Fechar">${icon("close")}</button></header>
        <div class="receivable-customer-content">
        <div class="customer-summary">
          <div class="customer-summary-main"><span>${icon("account_balance_wallet")} Total a receber</span><strong>${money.format(summary.outstandingAmountCents / 100)}</strong><small>Saldo pendente do cliente</small></div>
          <div class="customer-summary-item"><span>Em atraso</span><strong class="${summary.overdueAmountCents > 0 ? "customer-overdue" : ""}">${money.format(summary.overdueAmountCents / 100)}</strong></div>
          <div class="customer-summary-item"><span>Total recebido</span><strong>${money.format(payments.reduce((total, payment) => total + (Number(payment.amountCents) || 0), 0) / 100)}</strong></div>
        </div>
        <div class="customer-section-heading"><h3>${icon("receipt_long")} Todas as dívidas</h3><span class="customer-count">${accounts.length}</span></div>
        <div class="receivable-customer-accounts">
          ${accounts.map((account) => `<article class="customer-debt-card">
            <div class="customer-debt-title"><strong>${escapeHtml(account.description || "Conta manual")}</strong>${receivableStatusBadge(receivableDisplayStatus(account))}</div>
            <p class="customer-debt-due">${icon("event")} Vencimento: ${escapeHtml(formatReceivableDueDate(account.dueAt))}</p>
            <dl class="customer-debt-values"><div><dt>Valor original</dt><dd>${money.format((Number(account.originalAmountCents) || 0) / 100)}</dd></div><div><dt>Recebido</dt><dd>${money.format(payments.filter((payment) => String(payment.receivableId) === String(account.id || account.docId)).reduce((total, payment) => total + (Number(payment.amountCents) || 0), 0) / 100)}</dd></div><div><dt>Saldo</dt><dd>${money.format((Number(account.outstandingAmountCents) || 0) / 100)}</dd></div></dl>
          </article>`).join("") || `<p class="customer-empty">${icon("receipt_long")} Nenhuma dívida registrada para este cliente.</p>`}
        </div>
        <div class="customer-section-heading"><h3>${icon("history")} Histórico individual de pagamentos</h3><span class="customer-count">${payments.length}</span></div>
        <div class="receivable-history-list">
          ${payments.map((payment) => {
    const receivable = findReceivable(payment.receivableId);
    const accountDescription = receivable?.description || "Conta não identificada";
    return `<article class="receivable-history-row">
              <div><strong>${money.format((Number(payment.amountCents) || 0) / 100)}</strong><span>${escapeHtml(paymentMethodLabel(payment.paymentMethod))}</span><small>Dívida: ${escapeHtml(accountDescription)}</small></div>
              <div><span>${escapeHtml(dateTime.format(new Date(normalizeTimestamp(payment.timestamp))))}</span>${payment.notes ? `<small>${escapeHtml(payment.notes)}</small>` : ""}</div>
            </article>`;
  }).join("") || `<p class="customer-empty">${icon("payments")} Nenhum pagamento registrado para este cliente.</p>`}
        </div>
        </div>
        <footer><button class="btn secondary" type="button" data-close-modal>Fechar</button></footer>
      </section>
    </div>
  `;
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  const modal = document.querySelector(".receivable-customer-modal");
  modal.focus();
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
    if (event.key === "Tab") {
      const buttons = modal.querySelectorAll("button");
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
}

function whatsappPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function openReceivableWhatsapp(receivableKey) {
  const receivable = findReceivable(receivableKey);
  if (!receivable) return toast("Conta nao encontrada.");
  const customer = findReceivableCustomer(receivable.customerId);
  const phone = whatsappPhone(customer?.phone);
  if (!phone) return toast("Cadastre o telefone do cliente antes de enviar a mensagem.");
  const firstName = String(customer?.name || receivable.customerName || "cliente").trim().split(/\s+/)[0];
  const message = `Olá, ${firstName}. Lembrete da conta "${String(receivable.description || "Conta manual").trim()}" com saldo de ${money.format((Number(receivable.outstandingAmountCents) || 0) / 100)} e vencimento em ${formatReceivableDueDate(receivable.dueAt)}. Em caso de dúvida, entre em contato com ${state.company?.name || "nossa empresa"}.`;
  const opened = window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
  else toast("O navegador bloqueou a abertura do WhatsApp.");
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
      ${select("hasStockControl", "Controlar estoque?", [["true", "Sim, controlar quantidade"], ["false", "Não, estoque infinito"]], String(productTracksStock(product)))}
      ${input("stockQuantity", "Estoque", product?.stockQuantity || 0, "number")}
      ${input("minStockThreshold", "Estoque minimo", product?.minStockThreshold || 5, "number")}
      ${input("unit", "Unidade", product?.unit || "UN")}
    </div>
  `, async (form) => {
    const hasStockControl = form.get("hasStockControl") !== "false";
    const payload = {
      id,
      name: form.get("name"),
      barcode: form.get("barcode") || null,
      categoryId: form.get("categoryId") ? Number(form.get("categoryId")) : null,
      supplierId: form.get("supplierId") ? Number(form.get("supplierId")) : null,
      costPrice: parseDecimal(form.get("costPrice")),
      sellingPrice: parseDecimal(form.get("sellingPrice")),
      hasStockControl,
      tracksStock: hasStockControl,
      stockQuantity: hasStockControl ? parseDecimal(form.get("stockQuantity")) : 0,
      minStockThreshold: hasStockControl ? (parseDecimal(form.get("minStockThreshold")) || 5) : 0,
      unit: form.get("unit") || "UN",
    };
    await setDoc(tenantDocument(collections.products, id), tenantPayload(payload));
    await writeAuditLog({
      action: isEditing ? "PRODUCT_UPDATED" : "PRODUCT_CREATED",
      entityType: "product", entityId: id,
      description: `Produto ${isEditing ? "atualizado" : "criado"}: ${payload.name}.`
    });
    toast("Produto salvo.");
  });
  const stockControl = document.querySelector('#modalRoot [name="hasStockControl"]');
  const syncStockFields = () => {
    const enabled = stockControl?.value !== "false";
    ["stockQuantity", "minStockThreshold"].forEach((name) => {
      const field = document.querySelector(`#modalRoot [name="${name}"]`);
      if (field) {
        field.disabled = !enabled;
        field.closest("label").style.display = enabled ? "" : "none";
      }
    });
  };
  stockControl?.addEventListener("change", syncStockFields);
  syncStockFields();
}

function openNameModal(title, collectionName, items, item = null) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  const id = item?.id || nextId(items);
  openModal(item ? `Editar ${title}` : `Nova ${title}`, input("name", "Nome", item?.name || ""), async (form) => {
    await setDoc(tenantDocument(collectionName, id), tenantPayload({ id, name: form.get("name") }));
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
    await setDoc(tenantDocument(collections.suppliers, id), tenantPayload({ id, name: form.get("name"), contact: form.get("contact") || null, email: form.get("email") || null }));
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
    const usernameNormalized = username.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (!item && state.data.users.some((user) => String(user.usernameNormalized || user.username || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === usernameNormalized)) {
      throw new Error("Este nome de usuário já existe nesta empresa.");
    }
    let authEmail = item?.authEmail || "";
    const password = String(form.get("password") || "");
    if (!item && !isAllowedPassword(password)) throw new Error("Informe uma senha com pelo menos 6 caracteres, ou use a senha padrao admin.");
    let userDocId = item ? docKey(item, id) : "";
    if (!item) {
      const secondaryApp = initializeApp(firebaseConfig, `create-user-${Date.now()}`);
      try {
        for (let attempt = 0; attempt < 3 && !userDocId; attempt += 1) {
          authEmail = `tenant-${(await sha256Hex(`${tenantId()}:${usernameNormalized}:${randomToken()}`)).slice(0, 40)}@users.goregister.app`;
          try {
            const credential = await createUserWithEmailAndPassword(getAuth(secondaryApp), authEmail, password);
            userDocId = credential.user.uid;
          } catch (error) {
            if (error?.code !== "auth/email-already-in-use" || attempt === 2) throw error;
          }
        }
      } finally {
        await signOut(getAuth(secondaryApp)).catch(() => { });
        await deleteApp(secondaryApp);
      }
    }
    await setDoc(tenantDocument(collections.users, userDocId), tenantPayload({
      id,
      username,
      email: item?.email || null,
      authEmail,
      usernameNormalized,
      role,
      isActive: form.get("isActive") === "true",
      createdAt: item?.createdAt || Date.now(),
    }));
    const aliasId = `${tenantId()}__${usernameNormalized}`;
    await setDoc(doc(db, "login_aliases", aliasId), tenantPayload({ uid: userDocId, authEmail, email: authEmail, username }));
    await writeAuditLog({
      action: item ? "USER_UPDATED" : "USER_CREATED", entityType: "user", entityId: userDocId,
      description: `Usuário ${item ? "atualizado" : "criado"}: ${username} (${role}).`
    });
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
    async () => {
      await updateDoc(tenantDocument(collections.users, docKey(user, userKey)), { isActive: user.isActive === false });
      await writeAuditLog({
        action: "USER_UPDATED", entityType: "user", entityId: docKey(user, userKey),
        description: `Usuário ${user.isActive === false ? "ativado" : "inativado"}: ${user.username}.`
      });
    },
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
    async () => {
      await deleteDoc(tenantDocument(collections.users, docKey(user, userKey)));
      await writeAuditLog({
        action: "USER_DELETED", entityType: "user", entityId: docKey(user, userKey),
        description: `Usuário excluído: ${user.username}.`
      });
    },
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
      title: "Relatório de Vendas - Diário",
      filename: "relatorio_vendas_diario.pdf",
    };
  }
  if (period === "specificDate") {
    const selectedDate = state.filters.reportsDate || new Date().toISOString().slice(0, 10);
    const label = formatDateInputLabel(selectedDate) || "Data especifica";
    return {
      startTime: bounds[0],
      endTime: bounds[1],
      title: `Relatório de Vendas - ${label}`,
      filename: `relatorio_vendas_${selectedDate}.pdf`,
    };
  }
  if (period === "weekly") {
    return {
      startTime: bounds[0],
      endTime: bounds[1],
      title: "Relatório de Vendas - Semanal",
      filename: "relatorio_vendas_semanal.pdf",
    };
  }

  const monthIndex = Number(state.filters.reportsMonth ?? document.querySelector("#reportMonth")?.value ?? now.getMonth());
  const year = now.getFullYear();
  const month = monthNames()[monthIndex];
  return {
    startTime: bounds[0],
    endTime: bounds[1],
    title: `Relatório de Vendas - ${month} ${year}`,
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

async function exportSalesReport(period) {
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
  if (!await loadOfficialCompanyProfile()) {
    toast("Não foi possível carregar os dados empresariais. Verifique a conexão e as regras do Firebase.");
    return;
  }
  // O perfil privado e usado apenas em memoria e nunca e salvo no cache da empresa.
  // Em empresas migradas, somente campos basicos do root complementam o documento canonico.
  const rootCompany = state.company || {};
  const baseCompany = state.companyProfile?.__officialProfile
    ? {
      name: rootCompany.name,
      identifier: rootCompany.identifier,
      identifierNormalized: rootCompany.identifierNormalized,
      taxIdentifier: rootCompany.taxIdentifier,
      taxIdentifierNormalized: rootCompany.taxIdentifierNormalized,
      address: rootCompany.address,
      phone: rootCompany.phone,
    }
    : rootCompany;
  const { __officialProfile, ...officialProfile } = state.companyProfile || {};
  const reportCompany = {
    ...baseCompany,
    ...officialProfile,
  };
  const pdf = createSalesReportPdf(
    report.title,
    `Data de exportação: ${dateTime.format(new Date())}`,
    rows,
    paymentTotals,
    reportCompany
  );
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
  const headers = ["ID", "Produto", "Codigo de barras", "Categoria", "Fornecedor", "Preco de custo", "Preco de venda", "Controla estoque", "Estoque", "Estoque minimo", "Unidade"];
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
        productTracksStock(product) ? "Sim" : "Não",
        productTracksStock(product) ? (Number(product.stockQuantity) || 0) : "∞",
        productTracksStock(product) ? (Number(product.minStockThreshold) || 0) : "-",
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
  if (!state.receivablesEntitlementLoaded) {
    toast("Aguarde a verificação do módulo de Contas a Receber antes de exportar o backup.");
    return;
  }
  if (state.receivables.errors.size > 0) {
    toast("O backup não foi gerado porque houve uma falha ao verificar os dados de Contas a Receber.");
    return;
  }
  if (state.receivablesEntitlement && !receivablesDataReady()) {
    toast("O backup não foi gerado porque os dados de Contas a Receber ainda não estão completos.");
    return;
  }
  const backup = {
    app: "GO REGISTER",
    schemaVersion: 3,
    companyId: tenantId(),
    companyName: state.company?.name || "Empresa",
    exportedAt: Date.now(),
    collections: {
      products: backupDocuments(state.data.products),
      sales: backupDocuments(state.data.sales),
      categories: backupDocuments(state.data.categories),
      suppliers: backupDocuments(state.data.suppliers),
      cash_registers: backupDocuments(state.data.registers.filter((register) => String(register.docId || register.id) !== "active_register")),
      financial_entries: backupDocuments(state.data.entries),
      financial_exits: backupDocuments(state.data.exits),
      stock_movements: backupDocuments(state.data.stockMovements),
      ...(receivablesDataReady() && accountsReceivableAccess().visible ? {
        customers: backupDocuments(state.receivables.customers),
        receivables: backupDocuments(state.receivables.receivables),
        receivable_payments: backupDocuments(state.receivables.payments),
      } : {}),
    },
  };
  downloadBlob(JSON.stringify(backup, null, 2), `backup_go_register_${dateStamp()}.json`, "application/json");
  toast("Backup exportado.");
}

function backupDocuments(items) {
  return items.map((item) => {
    const id = item.docId ?? item.id;
    if (id === undefined || id === null || String(id).trim() === "") {
      throw new Error("Um registro sem identificador impediu a criação do backup.");
    }
    return { id: String(id), data: item };
  });
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function plainPdfText(value) {
  const winAnsiCharacters = new Map([
    ["€", 0x80], ["‚", 0x82], ["ƒ", 0x83], ["„", 0x84], ["…", 0x85], ["†", 0x86], ["‡", 0x87],
    ["ˆ", 0x88], ["‰", 0x89], ["Š", 0x8a], ["‹", 0x8b], ["Œ", 0x8c], ["Ž", 0x8e],
    ["‘", 0x91], ["’", 0x92], ["“", 0x93], ["”", 0x94], ["•", 0x95], ["–", 0x96], ["—", 0x97],
    ["˜", 0x98], ["™", 0x99], ["š", 0x9a], ["›", 0x9b], ["œ", 0x9c], ["ž", 0x9e], ["Ÿ", 0x9f],
  ]);
  let output = "";
  for (const character of String(value ?? "").normalize("NFC")) {
    const codePoint = character.codePointAt(0);
    if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) {
      output += character;
      continue;
    }
    if (winAnsiCharacters.has(character)) {
      output += String.fromCharCode(winAnsiCharacters.get(character));
      continue;
    }
    const fallback = character.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    output += /^[\x20-\x7e]$/.test(fallback) ? fallback : "?";
  }
  return output;
}

function normalizePdfText(value) {
  return plainPdfText(value).replace(/[\\()]/g, "\\$&");
}

function wrapPdfText(value, size) {
  const words = plainPdfText(value).split(/\s+/).filter(Boolean);
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

function companyFieldValue(company, keys) {
  for (const key of keys) {
    const value = company?.[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function companyDocumentLabel(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 14) return "CNPJ";
  if (digits.length === 11) return "CPF";
  return "CPF/CNPJ/Identificador";
}

function companyTaxIdentifier(company) {
  const explicit = companyFieldValue(company, ["taxIdentifier", "taxIdentifierNormalized", "cnpj", "cpf", "taxId", "document"]);
  if (explicit) return explicit;
  const legacy = companyFieldValue(company, ["identifier", "identifierNormalized"]);
  const digits = legacy.replace(/\D/g, "");
  return [11, 14].includes(digits.length) ? legacy : "";
}

function formatCompanyDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (isoDate) return `${isoDate[3]}/${isoDate[2]}/${isoDate[1]}`;
  const timestamp = normalizeTimestamp(value);
  if (!timestamp) return text;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? text : new Intl.DateTimeFormat("pt-BR").format(date);
}

function companyReportFields(company) {
  const fields = [];
  const seen = new Set();
  const add = (label, keys, formatter = (value) => value) => {
    const rawValue = companyFieldValue(company, keys);
    if (!rawValue) return;
    const value = String(formatter(rawValue) || "").trim();
    if (!value) return;
    const duplicateKey = value.toLocaleLowerCase("pt-BR");
    if (seen.has(duplicateKey)) return;
    seen.add(duplicateKey);
    fields.push({ label, value });
  };

  add("Nome da empresa", ["name", "nome", "companyName"]);
  add("Razão social", ["legalName", "corporateName", "razaoSocial", "razao_social"]);
  add("Nome fantasia", ["tradeName", "fantasyName", "nomeFantasia", "nome_fantasia"]);
  add("Unidade/Filial", ["unitName", "branchName", "storeName", "nomeUnidade", "nome_unidade", "filial"]);

  const identifier = companyTaxIdentifier(company);
  if (identifier) {
    const keys = companyFieldValue(company, ["taxIdentifier", "taxIdentifierNormalized", "cnpj", "cpf", "taxId", "document"])
      ? ["taxIdentifier", "taxIdentifierNormalized", "cnpj", "cpf", "taxId", "document"]
      : ["identifier", "identifierNormalized"];
    add(companyDocumentLabel(identifier), keys, formatCompanyIdentifier);
  }

  add("Inscrição estadual", ["stateRegistration", "inscricaoEstadual", "inscricao_estadual"]);
  add("Inscrição municipal", ["municipalRegistration", "inscricaoMunicipal", "inscricao_municipal"]);
  add("CNAE", ["cnae", "primaryCnae", "mainCnae", "cnaePrincipal", "cnae_principal", "activityCode"]);
  add("Regime tributário", ["taxRegime", "taxationRegime", "regimeTributario", "regime_tributario"]);
  add("Data de abertura", ["openingDate", "foundationDate", "foundedAt", "dataAbertura", "data_abertura"], formatCompanyDate);
  add("Endereço", ["address", "endereco"]);
  add("Número", ["addressNumber", "number", "numero"]);
  add("Complemento", ["addressComplement", "complement", "complemento"]);
  add("Bairro", ["district", "neighborhood", "bairro"]);
  add("Cidade", ["city", "cidade"]);
  add("Estado/UF", ["state", "uf", "estado"]);
  add("CEP", ["postalCode", "zipCode", "cep"]);
  add("Telefone", ["phone", "telephone", "telefone"]);
  add("Celular", ["mobile", "mobilePhone", "celular"]);
  add("E-mail", ["email", "companyEmail", "contactEmail"]);
  add("Site", ["website", "site", "url"]);
  add("Responsável legal", ["responsibleName", "legalRepresentative", "representativeName", "nomeResponsavel", "responsavelLegal", "responsavel_legal"]);
  add("Cargo do responsável", ["responsibleRole", "representativeRole", "responsiblePosition", "cargoResponsavel", "cargo_responsavel"]);
  const institutionalNotes = companyFieldValue(company, ["institutionalNotes", "businessNotes", "observacoesInstitucionais", "observacoes_institucionais"]);
  if (institutionalNotes) {
    const summarizedNotes = institutionalNotes.length > 480
      ? `${institutionalNotes.slice(0, 477).trimEnd()}...`
      : institutionalNotes;
    fields.push({ label: "Observações institucionais", value: summarizedNotes });
  }

  // Logo, redes sociais, chave Pix, mensagem de recibo e politica de troca sao dados operacionais.
  // Eles permanecem fora deste relatorio financeiro, destinado a bancos.

  return fields;
}

function createSalesReportPdf(title, generatedAt, rows, paymentTotals, company = {}) {
  const width = 595;
  const height = 842;
  const pages = [];
  const totalText = money.format(paymentTotals.total);
  const companyFields = companyReportFields(company);
  const companyName = companyFieldValue(company, ["name", "nome", "companyName"]) || "Empresa não informada";
  const companyIdentifier = companyTaxIdentifier(company);
  const compactCompany = companyIdentifier
    ? `${companyName} - ${companyDocumentLabel(companyIdentifier)}: ${formatCompanyIdentifier(companyIdentifier)}`
    : companyName;
  let lines = [];
  let y = 802;

  const startCompanyContinuationPage = () => {
    pages.push(lines.join("\n"));
    lines = [];
    y = 802;
    lines.push(pdfTextLine(40, y, 18, title, true));
    y -= 27;
    lines.push(pdfTextLine(40, y, 11, "Relatório consolidado de vendas"));
    y -= 25;
    lines.push(pdfTextLine(40, y, 10, "DADOS DA EMPRESA (CONTINUAÇÃO)", true));
    y -= 18;
  };

  const addReportIdentity = (includeAllCompanyFields) => {
    lines.push(pdfTextLine(40, y, 18, title, true));
    y -= 27;
    lines.push(pdfTextLine(40, y, 11, "Relatório consolidado de vendas"));
    y -= 25;

    if (includeAllCompanyFields) {
      lines.push(pdfTextLine(40, y, 10, "DADOS DA EMPRESA", true));
      y -= 18;
      if (!companyFields.length) {
        lines.push(pdfTextLine(40, y, 9, "Informações cadastrais não informadas."));
        y -= 15;
      } else {
        companyFields.forEach(({ label, value }) => {
          const fieldLines = wrapPdfText(`${label}: ${value}`, 88);
          if (y - fieldLines.length * 13 < 177) startCompanyContinuationPage();
          fieldLines.forEach((fieldLine) => {
            // Reserva espaco para data, resumo financeiro e cabecalho da tabela.
            if (y < 190) startCompanyContinuationPage();
            lines.push(pdfTextLine(40, y, 9, fieldLine));
            y -= 13;
          });
        });
      }
      lines.push(`40 ${y + 3} m 555 ${y + 3} l S`);
      y -= 10;
    } else {
      wrapPdfText(compactCompany, 88).forEach((companyLine) => {
        lines.push(pdfTextLine(40, y, 9, companyLine, true));
        y -= 13;
      });
    }

    lines.push(pdfTextLine(40, y, 9, generatedAt));
    y -= 28;
  };

  const addFinancialSummary = () => {
    lines.push(pdfTextLine(40, y, 10, `Total de vendas: ${totalText}`, true));
    lines.push(pdfTextLine(225, y, 10, `Venda manual: ${money.format(paymentTotals.manual)}`, true));
    lines.push(pdfTextLine(410, y, 10, `Venda estoque: ${money.format(paymentTotals.stock)}`, true));
    y -= 20;
    lines.push(pdfTextLine(40, y, 10, `Pix: ${money.format(paymentTotals.pix)}`, true));
    lines.push(pdfTextLine(225, y, 10, `Dinheiro: ${money.format(paymentTotals.cash)}`, true));
    lines.push(pdfTextLine(410, y, 10, `Cartão: ${money.format(paymentTotals.card)}`, true));
    y -= 40;
  };

  const addHeader = () => {
    lines.push(pdfTextLine(40, y, 9, "Data/Hora", true));
    lines.push(pdfTextLine(116, y, 9, "Tipo de venda", true));
    lines.push(pdfTextLine(205, y, 9, "Descrição", true));
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
    addReportIdentity(false);
    addHeader();
  };

  addReportIdentity(true);
  addFinancialSummary();
  addHeader();
  if (!rows.length) {
    lines.push(pdfTextLine(40, y, 10, "Nenhum movimento encontrado neste período."));
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

  const pageCount = pages.length;
  const footerCompanyName = companyName.length > 68 ? `${companyName.slice(0, 65).trimEnd()}...` : companyName;
  const numberedPages = pages.map((content, index) => [
    content,
    "40 42 m 555 42 l S",
    pdfTextLine(40, 26, 8, footerCompanyName),
    pdfTextLine(490, 26, 8, `Página ${index + 1} de ${pageCount}`),
  ].join("\n"));
  return buildPdf(numberedPages, width, height);
}

function pdfBytes(value) {
  const text = String(value ?? "");
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function concatenatePdfBytes(chunks, totalLength) {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });
  return output;
}

function buildPdf(pageContents, width, height) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageContents.map((_, index) => `${5 + index * 2} 0 R`).join(" ")}] /Count ${pageContents.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  pageContents.forEach((content, index) => {
    const pageId = 5 + index * 2;
    const contentId = pageId + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${pdfBytes(content).length} >>\nstream\n${content}\nendstream`);
  });

  const chunks = [];
  let byteLength = 0;
  const append = (value) => {
    const chunk = pdfBytes(value);
    chunks.push(chunk);
    byteLength += chunk.length;
  };
  append("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(byteLength);
    append(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });
  const xrefOffset = byteLength;
  append(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach((offset) => {
    append(`${String(offset).padStart(10, "0")} 00000 n \n`);
  });
  append(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return new Blob([concatenatePdfBytes(chunks, byteLength)], { type: "application/pdf" });
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
  const alreadyOpen = currentOpenRegister();
  if (alreadyOpen) {
    toast("Já existe um caixa aberto nesta empresa.");
    return;
  }

  openModal("Abrir Caixa", input("initialBalance", "Saldo inicial", 0, "number"), async (form) => {
    const existingBeforeTransaction = currentOpenRegister();
    const controlReference = tenantDocument(collections.registers, ACTIVE_REGISTER_DOCUMENT);

    const activeRegister = await runTransaction(db, async (transaction) => {
      const controlSnapshot = await transaction.get(controlReference);
      const currentControl = controlSnapshot.exists()
        ? { ...controlSnapshot.data(), docId: controlSnapshot.id }
        : null;

      if (currentControl?.isOpen === true) return currentControl;

      if (!controlSnapshot.exists() && existingBeforeTransaction?.isOpen === true) {
        const normalizedExisting = tenantPayload(existingBeforeTransaction);
        transaction.set(controlReference, normalizedExisting);
        return existingBeforeTransaction;
      }

      const id = Date.now();
      const register = {
        id,
        openingTimestamp: id,
        closingTimestamp: null,
        initialBalance: parseDecimal(form.get("initialBalance")),
        closingBalance: null,
        userId: Number(state.user.id) || 0,
        isOpen: true,
      };
      const payload = tenantPayload(register);

      transaction.set(tenantDocument(collections.registers, id), payload);
      transaction.set(controlReference, payload);
      return { ...register, empresa_id: tenantId(), companyId: tenantId(), docId: String(id) };
    });

    await closeOlderOpenRegisters(activeRegister);
    await writeAuditLog({
      action: "CASH_OPENED", entityType: "cash_register", entityId: activeRegister.id,
      description: "Caixa aberto.", amountCents: Math.round((Number(activeRegister.initialBalance) || 0) * 100)
    });
    toast("Caixa aberto.");
  });
}

async function closeRegister() {
  const open = currentOpenRegister();
  if (!open) return;

  const form = await openFormDialog(
    "Fechar Caixa",
    input("closingBalance", "Saldo final do caixa", open.initialBalance || 0, "number"),
    "Fechar caixa",
    "lock",
    "danger"
  );
  if (!form) return;

  const closingBalance = parseDecimal(form.get("closingBalance"));
  await runAction(async () => {
    const controlReference = tenantDocument(collections.registers, ACTIVE_REGISTER_DOCUMENT);

    await runTransaction(db, async (transaction) => {
      const controlSnapshot = await transaction.get(controlReference);
      let cloudActive = controlSnapshot.exists()
        ? { ...controlSnapshot.data(), docId: controlSnapshot.id }
        : null;

      // Migração segura para caixas criados antes do documento de controle existir.
      if (cloudActive?.isOpen !== true && !controlSnapshot.exists()) {
        const legacyReference = tenantDocument(
          collections.registers,
          open.docId || tenantDocId(open.id)
        );
        const legacySnapshot = await transaction.get(legacyReference);
        cloudActive = legacySnapshot.exists()
          ? { ...legacySnapshot.data(), docId: legacySnapshot.id }
          : null;
      }

      if (cloudActive?.isOpen !== true) {
        throw new Error("Este caixa já foi fechado em outro dispositivo.");
      }
      if (Number(cloudActive.id) !== Number(open.id)) {
        throw new Error("O caixa ativo mudou em outro dispositivo. Atualize a tela antes de fechar.");
      }

      const closed = tenantPayload({
        ...cloudActive,
        closingTimestamp: Date.now(),
        closingBalance,
        isOpen: false,
      });

      transaction.set(tenantDocument(collections.registers, cloudActive.id), closed);
      transaction.set(controlReference, closed);
    });
    await writeAuditLog({
      action: "CASH_CLOSED", entityType: "cash_register", entityId: open.id,
      description: "Caixa fechado.", amountCents: Math.round(closingBalance * 100)
    });
  }, "Caixa fechado.");
}

function openMovementModal(kind) {
  const isEntry = kind === "entry";
  if (!currentOpenRegister()) {
    toast(isEntry ? "Abra o caixa antes de fazer uma venda." : "Abra o caixa antes de registrar uma saída.");
    return;
  }
  openModal(isEntry ? "Nova Venda Manual" : "Nova Saida", `
    ${input("description", "Descricao")}
    ${input("amount", "Valor", 0, "number")}
    ${select("paymentMethod", "Pagamento", paymentOptions, "CASH")}
    ${input("category", "Categoria")}
  `, async (form) => {
    const list = isEntry ? state.data.entries : state.data.exits;
    const collectionName = isEntry ? collections.entries : collections.exits;
    const open = currentOpenRegister();
    if (!open) throw new Error(isEntry
      ? "O caixa foi fechado. Abra o caixa antes de fazer uma venda."
      : "O caixa foi fechado. Abra o caixa antes de registrar uma saída.");
    const id = nextId(list);
    const description = String(form.get("description") || "").trim();
    const amount = parseDecimal(form.get("amount"));
    await setDoc(tenantDocument(collectionName, id), tenantPayload({
      id,
      timestamp: Date.now(),
      description,
      amount,
      paymentMethod: form.get("paymentMethod"),
      category: form.get("category") || null,
      transactionType: isEntry ? "MANUAL_SALE" : "EXIT",
      cashRegisterId: Number(open.id) || 0,
      isCancelled: false,
    }));
    await writeAuditLog({
      action: isEntry ? "MANUAL_ENTRY_CREATED" : "MANUAL_EXIT_CREATED",
      entityType: isEntry ? "financial_entry" : "financial_exit", entityId: id,
      description: `${isEntry ? "Entrada" : "Saída"} manual: ${description || "Sem descrição"}.`,
      amountCents: Math.round(amount * 100)
    });
    toast(isEntry ? "Venda manual salva." : "Saida salva.");
    return isEntry ? undefined : () => promptCreateProductFromManualMovement(description, "exit");
  });
}

function openStockAdjustModal(selectedProduct = null) {
  if (!isAdmin()) return toast("Acesso restrito ao administrador.");
  if (selectedProduct && !productTracksStock(selectedProduct)) return toast("Este produto possui estoque ilimitado e não precisa de ajuste.");
  const stockProducts = state.data.products.filter(productTracksStock);
  if (!stockProducts.length) return toast("Nenhum produto com controle de estoque cadastrado.");
  openModal("Ajustar Estoque", `
    ${select("productId", "Produto", stockProducts.map((item) => [item.id, `${item.name} (${item.stockQuantity} ${item.unit || "UN"})`]), selectedProduct?.id || "")}
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
    await writeAuditLog({
      action: movementQty >= 0 ? "STOCK_ADDED" : "STOCK_REMOVED",
      entityType: "product", entityId: product.id,
      description: `${movementQty >= 0 ? "Entrada" : "Saída"} de ${Math.abs(movementQty)} unidade(s) em ${product.name}.`
    });
  });
}

async function openCheckoutModal() {
  if (checkoutInProgress) return toast("A venda ja esta sendo finalizada.");
  if (!currentOpenRegister()) return toast("Abra o caixa antes de finalizar a venda.");
  if (!state.cart.length) return toast("Adicione produtos ao carrinho.");

  const methodForm = await openFormDialog(
    "Forma de Pagamento",
    select("paymentMethod", "Pagamento", paymentOptions, "CASH"),
    "CONTINUAR",
    "arrow_forward"
  );
  if (!methodForm) return;

  const primaryMethod = normalizePaymentMethod(methodForm.get("paymentMethod"));
  const hasMultiplePayments = await openChoiceModal(
    "Pagamento da compra",
    "Esta Compra Possui mais de uma forma de pagamento?",
    "NAO",
    "SIM"
  );

  if (hasMultiplePayments) {
    openSplitPaymentModal(primaryMethod);
    return;
  }

  const { finalCents } = cartTotals();
  try {
    const result = await checkout([{ method: primaryMethod, amountCents: finalCents }]);
    await showCompletedCheckout(result);
  } catch (error) {
    handleCheckoutError(error);
  }
}

function splitPaymentValidation(firstMethod, firstCents, secondMethod, secondCents, totalCents) {
  if (firstCents == null || secondCents == null || firstCents <= 0 || secondCents <= 0) {
    return "Informe um valor maior que zero nos dois pagamentos.";
  }
  if (normalizePaymentMethod(firstMethod) === normalizePaymentMethod(secondMethod)) {
    return "Selecione duas formas de pagamento diferentes.";
  }
  const informedCents = firstCents + secondCents;
  if (informedCents < totalCents) {
    return `Faltam ${money.format((totalCents - informedCents) / 100)} para completar o total.`;
  }
  if (informedCents > totalCents) {
    return `O valor informado excede o total em ${money.format((informedCents - totalCents) / 100)}.`;
  }
  return "";
}

function openSplitPaymentModal(primaryMethod) {
  const { finalCents } = cartTotals();
  if (finalCents <= 0) return toast("O total da venda deve ser maior que zero.");
  const normalizedPrimary = normalizePaymentMethod(primaryMethod);
  const secondaryDefault = paymentOptions.find(([method]) => method !== normalizedPrimary)?.[0] || "PIX";
  const modalRoot = document.querySelector("#modalRoot");

  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal split-payment-modal" role="dialog" aria-modal="true" aria-labelledby="splitPaymentTitle">
        <header>
          <h2 id="splitPaymentTitle">Dividir pagamento</h2>
          <button class="icon-btn" type="button" data-split-cancel aria-label="Fechar">${icon("close")}</button>
        </header>
        <form id="splitPaymentForm" novalidate>
          <div class="split-payment-total">
            <span>Total da compra</span>
            <strong>${money.format(finalCents / 100)}</strong>
          </div>
          <div class="split-payment-grid">
            <fieldset class="split-payment-card">
              <legend>Pagamento 1</legend>
              ${input("firstAmount", "Valor", "", "number")}
              ${select("firstMethod", "Forma de pagamento", paymentOptions, normalizedPrimary)}
            </fieldset>
            <fieldset class="split-payment-card">
              <legend>Pagamento 2</legend>
              ${input("secondAmount", "Valor", "", "number")}
              ${select("secondMethod", "Forma de pagamento", paymentOptions, secondaryDefault)}
            </fieldset>
          </div>
          <div class="split-payment-summary" aria-live="polite">
            <span>Informado <strong data-split-informed>${money.format(0)}</strong></span>
            <span data-split-balance>Restante <strong>${money.format(finalCents / 100)}</strong></span>
          </div>
          <p class="split-payment-message" data-split-message>Informe os dois valores para continuar.</p>
          <footer>
            <button class="btn secondary" type="button" data-split-cancel>Cancelar</button>
            <button class="btn" type="submit" data-split-submit disabled>${icon("check")} CONFIRMAR VENDA</button>
          </footer>
        </form>
      </section>
    </div>
  `;

  const form = modalRoot.querySelector("#splitPaymentForm");
  const firstAmount = form.elements.firstAmount;
  const secondAmount = form.elements.secondAmount;
  const firstMethod = form.elements.firstMethod;
  const secondMethod = form.elements.secondMethod;
  const submitButton = modalRoot.querySelector("[data-split-submit]");
  const messageNode = modalRoot.querySelector("[data-split-message]");
  const informedNode = modalRoot.querySelector("[data-split-informed]");
  const balanceNode = modalRoot.querySelector("[data-split-balance]");
  const cancelButtons = [...modalRoot.querySelectorAll("[data-split-cancel]")];
  let secondAmountWasEdited = false;
  let submitting = false;

  const readValues = () => ({
    firstCents: parseMoneyCents(firstAmount.value),
    secondCents: parseMoneyCents(secondAmount.value),
    firstPaymentMethod: normalizePaymentMethod(firstMethod.value),
    secondPaymentMethod: normalizePaymentMethod(secondMethod.value),
  });

  const updateSummary = () => {
    const values = readValues();
    const informedCents = Math.max(0, values.firstCents || 0) + Math.max(0, values.secondCents || 0);
    const differenceCents = finalCents - informedCents;
    const validationMessage = splitPaymentValidation(
      values.firstPaymentMethod,
      values.firstCents,
      values.secondPaymentMethod,
      values.secondCents,
      finalCents
    );
    informedNode.textContent = money.format(informedCents / 100);
    balanceNode.innerHTML = differenceCents >= 0
      ? `Restante <strong>${money.format(differenceCents / 100)}</strong>`
      : `Excedente <strong>${money.format(Math.abs(differenceCents) / 100)}</strong>`;
    balanceNode.classList.toggle("is-ok", !validationMessage);
    balanceNode.classList.toggle("is-error", Boolean(validationMessage));
    messageNode.textContent = validationMessage || "Valores conferidos. A venda pode ser finalizada.";
    messageNode.classList.toggle("is-ok", !validationMessage);
    submitButton.disabled = submitting || Boolean(validationMessage);
    return { ...values, validationMessage };
  };

  firstAmount.addEventListener("input", () => {
    const firstCents = parseMoneyCents(firstAmount.value);
    if (!secondAmountWasEdited) {
      secondAmount.value = firstCents != null && firstCents > 0 && firstCents < finalCents
        ? formatMoneyCentsInput(finalCents - firstCents)
        : "";
    }
    updateSummary();
  });
  secondAmount.addEventListener("input", () => {
    secondAmountWasEdited = true;
    updateSummary();
  });
  firstMethod.addEventListener("change", updateSummary);
  secondMethod.addEventListener("change", updateSummary);
  cancelButtons.forEach((button) => button.addEventListener("click", () => {
    if (!submitting) closeModal();
  }));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    const values = updateSummary();
    if (values.validationMessage) return;

    submitting = true;
    [...form.elements].forEach((element) => { element.disabled = true; });
    cancelButtons.forEach((button) => { button.disabled = true; });
    submitButton.innerHTML = `${icon("hourglass_top")} FINALIZANDO...`;
    try {
      const result = await checkout([
        { method: values.firstPaymentMethod, amountCents: values.firstCents },
        { method: values.secondPaymentMethod, amountCents: values.secondCents },
      ]);
      await showCompletedCheckout(result);
    } catch (error) {
      handleCheckoutError(error, false);
      submitting = false;
      [...form.elements].forEach((element) => { element.disabled = false; });
      cancelButtons.forEach((button) => { button.disabled = false; });
      submitButton.innerHTML = `${icon("check")} CONFIRMAR VENDA`;
      updateSummary();
      messageNode.textContent = error.message || "Falha ao finalizar a venda.";
      messageNode.classList.remove("is-ok");
    }
  });

  updateSummary();
  firstAmount.focus();
}

function formatCompanyIdentifier(value) {
  const original = String(value || "").trim();
  const digits = original.replace(/\D/g, "");
  if (digits.length === 14) {
    return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  }
  if (digits.length === 11) {
    return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  }
  return original;
}

function formatReceiptQuantity(value) {
  const quantity = Number(value) || 0;
  return quantity.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

function buildSaleReceiptText(result) {
  const { sale, receiptItems, payments } = result;
  const company = state.company || {};
  const { socialMedia = "", receiptMessage = "", exchangePolicy = "" } = state.receiptSettings || {};
  const identifier = formatCompanyIdentifier(companyTaxIdentifier(company));
  const lines = [
    company.name || "GO REGISTER",
    identifier ? `CPF/CNPJ: ${identifier}` : "",
    company.address || "",
    company.phone ? `Telefone: ${company.phone}` : "",
    socialMedia ? `Redes sociais: ${socialMedia}` : "",
    "",
    "COMPROVANTE DE VENDA",
    ...(sale.isCancelled ? ["VENDA CANCELADA — SEM VALIDADE"] : []),
    formatReceiptDateTime(sale.timestamp),
    "",
    ...receiptItems.map((item) => `${formatReceiptQuantity(item.quantity)}x ${item.name} - ${money.format(item.subtotalCents / 100)}`),
    "",
    "Pagamentos:",
    ...payments.map((part) => `${paymentMethodLabel(part.method)}: ${money.format(part.amountCents / 100)}`),
    `SUBTOTAL: ${money.format(receiptSubtotalCents(sale, receiptItems) / 100)}`,
    sale.discount > 0 ? `DESCONTO: - ${money.format(sale.discount)}` : "",
    `TOTAL: ${money.format(sale.finalAmount)}`,
    receiptMessage ? `\n${receiptMessage}` : "",
    exchangePolicy ? `Política de troca: ${exchangePolicy}` : "",
  ];
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n").trim();
}

async function shareSaleReceipt(result) {
  const text = buildSaleReceiptText(result);
  try {
    if (navigator.share) {
      await navigator.share({ title: "Comprovante de venda", text });
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast("Comprovante copiado.");
      return;
    }
    throw new Error("Compartilhamento indisponivel neste navegador.");
  } catch (error) {
    if (error?.name !== "AbortError") toast(error.message || "Nao foi possivel compartilhar o comprovante.");
  }
}

async function waitForReceiptLogo() {
  const logo = document.querySelector("#saleReceipt .receipt-logo");
  if (!logo || logo.complete) return;
  await new Promise((resolve) => {
    const timeoutId = window.setTimeout(resolve, 5000);
    const finish = () => {
      window.clearTimeout(timeoutId);
      resolve();
    };
    logo.addEventListener("load", finish, { once: true });
    logo.addEventListener("error", finish, { once: true });
  });
}

async function printSaleReceipt() {
  await waitForReceiptLogo();
  const finishPrinting = () => document.body.classList.remove("receipt-printing");
  document.body.classList.add("receipt-printing");
  window.addEventListener("afterprint", finishPrinting, { once: true });
  window.print();
  window.setTimeout(finishPrinting, 1000);
}

function openTransactionOptions(kind, id) {
  const transaction = allTransactions().find((item) => item.kind === kind && String(item.refId) === String(id));
  if (!transaction) return toast("Transação não encontrada. Atualize o extrato.");
  const root = document.querySelector("#modalRoot");
  root.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="transactionOptionsTitle">
    <header><h2 id="transactionOptionsTitle">Opções da transação</h2><button type="button" class="icon-btn" data-dismiss-options aria-label="Fechar">${icon("close")}</button></header>
    ${kind === "sale" ? `<button class="btn full" type="button" data-reopen-receipt>${icon("receipt_long")} Ver recibo / Imprimir</button>` : ""}
    ${!transaction.isCancelled ? `<button class="btn secondary full" type="button" data-cancel-option>${icon("cancel")} Cancelar lançamento</button>` : ""}
  </section></div>`;
  const close = () => { root.innerHTML = ""; };
  root.querySelector("[data-dismiss-options]").onclick = close;
  root.querySelector(".modal-backdrop").onclick = (event) => { if (event.target === event.currentTarget) close(); };
  root.querySelector(".modal").onkeydown = (event) => { if (event.key === "Escape") close(); };
  root.querySelector("[data-cancel-option]")?.addEventListener("click", () => { close(); cancelTransaction(kind, id); });
  root.querySelector("[data-reopen-receipt]")?.addEventListener("click", () => {
    const record = state.data.sales.find((item) => String(docKey(item, saleData(item).id)) === String(id));
    if (!record) { close(); return toast("Venda não encontrada."); }
    const saved = saleData(record);
    openSaleReceipt({
      sale: { ...saved, timestamp: saleTimestamp(record), finalAmount: saleAmount(record), isCancelled: saleIsCancelled(record) },
      receiptItems: saleItems(record).map((item) => {
        const productId = item.productId ?? item.product_id;
        const product = state.data.products.find((entry) => String(entry.id) === String(productId));
        return {
          name: item.productName || item.name || product?.name || `Produto #${productId}`,
          quantity: Number(item.quantity) || 0,
          unitPriceCents: Math.round(Number(item.unitPrice ?? item.unit_price ?? 0) * 100),
          subtotalCents: Math.round(Number(item.subtotal ?? Number(item.unitPrice ?? 0) * Number(item.quantity ?? 0)) * 100),
        };
      }),
      payments: salePaymentParts(record).map((part) => ({ method: part.method, amountCents: Math.round(part.amount * 100) })),
    });
  });
  root.querySelector("button")?.focus();
}

function openSaleReceipt(result) {
  const { sale, receiptItems, payments } = result;
  const company = state.company || {};
  const { socialMedia = "", receiptMessage = "", exchangePolicy = "" } = state.receiptSettings || {};
  const logoUrl = safeReceiptLogoUrl({
    logoUrl: state.receiptSettings?.logoUrl
      || state.companyProfile?.logoUrl
      || company.logoUrl
      || company.logoURL
      || company.logo_url,
  });
  const identifier = formatCompanyIdentifier(companyTaxIdentifier(company));
  const date = new Date(sale.timestamp);
  const receiptNumber = String(sale.id ?? "").padStart(6, "0");
  const operator = sale.userId ? state.data.users.find((user) => String(user.id) === String(sale.userId)) : null;
  const operatorName = operator?.username || (sale.userId ? `#${sale.userId}` : "Não informado");
  const subtotalCents = receiptSubtotalCents(sale, receiptItems);
  const modalRoot = document.querySelector("#modalRoot");
  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal receipt-modal" role="dialog" aria-modal="true" aria-labelledby="saleReceiptTitle">
        <header>
          <div><span class="receipt-success">${icon(sale.isCancelled ? "cancel" : "check_circle")} ${sale.isCancelled ? "VENDA CANCELADA" : "VENDA FINALIZADA!"}</span><h2 id="saleReceiptTitle">Comprovante de Venda</h2></div>
          <button class="icon-btn" type="button" data-close-receipt aria-label="Fechar">${icon("close")}</button>
        </header>
        <div class="receipt-paper" id="saleReceipt">
          ${sale.isCancelled ? `<strong>VENDA CANCELADA — SEM VALIDADE</strong>` : ""}
          <div class="receipt-brand">
            ${logoUrl ? `<img class="receipt-logo" src="${escapeHtml(logoUrl)}" alt="Logo de ${escapeHtml(company.name || "empresa")}" referrerpolicy="no-referrer" decoding="sync" fetchpriority="high">` : ""}
            <div class="receipt-business"><strong>${escapeHtml(company.name || "GO REGISTER")}</strong>
            ${identifier ? `<span>CPF/CNPJ: ${escapeHtml(identifier)}</span>` : ""}
            ${company.address ? `<span>${escapeHtml(company.address)}</span>` : ""}
            ${company.phone ? `<span>Telefone: ${escapeHtml(company.phone)}</span>` : ""}
            ${socialMedia ? `<span>Redes sociais: ${escapeHtml(socialMedia)}</span>` : ""}</div>
          </div>
          <div class="receipt-heading"><strong>COMPROVANTE DE VENDA</strong><span>NÃO É DOCUMENTO FISCAL</span></div>
          <div class="receipt-meta"><span><b>DATA:</b> ${escapeHtml(date.toLocaleDateString("pt-BR"))}</span><span><b>Nº:</b> ${escapeHtml(receiptNumber)}</span><span><b>HORA:</b> ${escapeHtml(date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }))}</span><span><b>OPERADOR:</b> ${escapeHtml(operatorName)}</span></div>
          <div class="receipt-items">
            <table class="receipt-table"><thead><tr><th>Item</th><th>Qtd</th><th>Vlr. unit.</th><th>Vlr. total</th></tr></thead><tbody>
            ${receiptItems.map((item) => `
              <tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(formatReceiptQuantity(item.quantity))}</td><td>${escapeHtml(money.format(item.unitPriceCents / 100))}</td><td>${escapeHtml(money.format(item.subtotalCents / 100))}</td></tr>
            `).join("")}</tbody></table>
          </div>
          <div class="receipt-payments">
            <strong class="receipt-section-label">Pagamentos</strong>
            ${payments.map((part) => `<div class="receipt-line"><span>${escapeHtml(paymentMethodLabel(part.method))}</span><strong>${escapeHtml(money.format(part.amountCents / 100))}</strong></div>`).join("")}
          </div>
          <div class="receipt-summary"><div class="receipt-line"><span>SUBTOTAL</span><strong>${escapeHtml(money.format(subtotalCents / 100))}</strong></div>
          ${sale.discount > 0 ? `<div class="receipt-line"><span>DESCONTO</span><strong>- ${escapeHtml(money.format(sale.discount))}</strong></div>` : ""}
          <div class="receipt-total"><span>TOTAL</span><strong>${escapeHtml(money.format(sale.finalAmount))}</strong></div></div>
          <div class="receipt-thanks"><strong>${sale.isCancelled ? "VENDA CANCELADA" : "OBRIGADO PELA SUA COMPRA!"}</strong><span>${escapeHtml(receiptMessage || (sale.isCancelled ? "SEM VALIDADE" : "VOLTE SEMPRE!"))}</span></div>
          <div class="receipt-qr">${receiptQrSvg(company.id, sale)}<span>Nº: ${escapeHtml(receiptNumber)} | ${escapeHtml(formatReceiptDateTime(sale.timestamp))}</span><span>Apresente este código em nossos canais de atendimento.</span></div>
          ${exchangePolicy ? `
            <div class="receipt-footer">
              ${exchangePolicy ? `<span><b>Política de troca:</b> ${escapeHtml(exchangePolicy)}</span>` : ""}
            </div>
          ` : ""}
        </div>
        <footer class="receipt-actions">
          <button class="btn secondary" type="button" data-print-receipt>${icon("print")} Imprimir</button>
          <button class="btn secondary" type="button" data-share-receipt>${icon("share")} Compartilhar</button>
          <button class="btn" type="button" data-close-receipt>Fechar</button>
        </footer>
      </section>
    </div>
  `;
  const closeReceipt = () => {
    closeModal();
    renderApp();
  };
  modalRoot.querySelectorAll("[data-close-receipt]").forEach((button) => button.addEventListener("click", closeReceipt));
  const receiptLogo = modalRoot.querySelector(".receipt-logo");
  if (receiptLogo?.complete && !receiptLogo.naturalWidth) receiptLogo.remove();
  else receiptLogo?.addEventListener("error", (event) => {
    console.warn("Não foi possível carregar o logotipo configurado para o recibo.", event.currentTarget.src);
    event.currentTarget.remove();
  }, { once: true });
  modalRoot.querySelector("[data-print-receipt]").addEventListener("click", printSaleReceipt);
  modalRoot.querySelector("[data-share-receipt]").addEventListener("click", () => shareSaleReceipt(result));
}

function handleCheckoutError(error, showToast = true) {
  const message = error?.message || "Falha ao finalizar a venda.";
  if (/firebase|firestore|permission|network|offline/i.test(message)) state.firebaseError = message;
  if (showToast) toast(message);
}

async function showCompletedCheckout(result) {
  state.firebaseError = "";
  await loadReceiptSettings();
  renderApp();
  openSaleReceipt(result);
  toast("Venda finalizada.");
}

async function cancelTransaction(kind, id) {
  if (!(await requestCancellationAuthorization())) return;
  await runAction(async () => {
    if (kind === "sale") {
      const record = state.data.sales.find((item) => String(docKey(item, saleData(item).id)) === String(id) || String(saleData(item).id ?? "") === String(id));
      if (!record) throw new Error("Venda nao encontrada.");
      await updateDoc(tenantDocument(collections.sales, docKey(record, id)), { "sale.isCancelled": true, isCancelled: true });
      await Promise.all(saleItems(record).map(async (item) => {
        if (item.tracksStock === false) return;
        const productId = item.productId ?? item.product_id;
        const product = findById(state.data.products, productId);
        if (!product) return;
        const restored = (Number(product.stockQuantity) || 0) + (Number(item.quantity) || 0);
        await updateProductStock(product.id, restored);
        await saveStockMovement(product.id, Number(item.quantity) || 0, "ENTRY", "Cancelamento de venda");
      }));
      await writeAuditLog({
        action: "SALE_CANCELLED", entityType: "sale", entityId: id,
        description: "Venda cancelada e estoque devolvido.",
        amountCents: Math.round((Number(saleData(record).finalAmount) || 0) * 100)
      });
    }
    if (kind === "entry") {
      const record = state.data.entries.find((item) => String(docKey(item, item.id)) === String(id) || String(item.id ?? "") === String(id));
      if (!record) throw new Error("Entrada nao encontrada.");
      await updateDoc(tenantDocument(collections.entries, docKey(record, id)), { isCancelled: true });
      await writeAuditLog({
        action: "MANUAL_ENTRY_CANCELLED", entityType: "financial_entry", entityId: id,
        description: `Entrada manual cancelada: ${record.description || "Sem descrição"}.`,
        amountCents: Math.round((Number(record.amount) || 0) * 100)
      });
    }
    if (kind === "exit") {
      const record = state.data.exits.find((item) => String(docKey(item, item.id)) === String(id) || String(item.id ?? "") === String(id));
      if (!record) throw new Error("Saida nao encontrada.");
      await updateDoc(tenantDocument(collections.exits, docKey(record, id)), { isCancelled: true });
      await writeAuditLog({
        action: "MANUAL_EXIT_CANCELLED", entityType: "financial_exit", entityId: id,
        description: `Saída manual cancelada: ${record.description || "Sem descrição"}.`,
        amountCents: Math.round((Number(record.amount) || 0) * 100)
      });
    }
  }, "Transacao cancelada.");
}

async function checkout(paymentParts) {
  if (checkoutInProgress) throw new Error("A venda ja esta sendo finalizada.");
  checkoutInProgress = true;
  const cartSnapshot = state.cart.map((item) => ({
    product: { ...item.product },
    quantity: Number(item.quantity) || 0,
  }));

  try {
    const open = currentOpenRegister();
    if (!open) throw new Error("O caixa foi fechado. Abra o caixa antes de finalizar a venda.");
    if (!cartSnapshot.length) throw new Error("O carrinho esta vazio.");

    const { totalCents, discountCents, finalCents } = cartTotals(cartSnapshot);
    const payments = normalizeCheckoutPayments(paymentParts, finalCents);
    const id = nextId(state.data.sales.map((item) => saleData(item)));
    const sale = {
      id,
      timestamp: Date.now(),
      totalAmount: totalCents / 100,
      discount: discountCents / 100,
      finalAmount: finalCents / 100,
      paymentMethod: payments[0].method,
      secondaryPaymentMethod: payments[1]?.method || null,
      secondaryPaymentAmount: payments[1] ? payments[1].amountCents / 100 : 0,
      userId: Number(state.user.id) || 0,
      cashRegisterId: Number(open.id) || 0,
      isCancelled: false,
    };
    const items = cartSnapshot.map((item, index) => ({
      id: id * 1000 + index + 1,
      saleId: id,
      productId: Number(item.product.id),
      quantity: item.quantity,
      tracksStock: productTracksStock(item.product),
      unitPrice: Math.round((Number(item.product.sellingPrice) || 0) * 100) / 100,
      subtotal: Math.round((Number(item.product.sellingPrice) || 0) * item.quantity * 100) / 100,
    }));
    const receiptItems = cartSnapshot.map((item) => ({
      name: item.product.name || "Produto",
      quantity: item.quantity,
      unitPriceCents: Math.round((Number(item.product.sellingPrice) || 0) * 100),
      subtotalCents: Math.round((Number(item.product.sellingPrice) || 0) * item.quantity * 100),
    }));

    await setDoc(tenantDocument(collections.sales, id), tenantPayload({ sale: { ...sale, empresa_id: tenantId() }, items }));
    await Promise.all(cartSnapshot.filter((item) => productTracksStock(item.product)).map((item) => {
      const updatedStock = Math.max(0, (Number(item.product.stockQuantity) || 0) - item.quantity);
      return Promise.all([
        updateProductStock(item.product.id, updatedStock),
        saveStockMovement(item.product.id, -item.quantity, "EXIT", "Venda"),
      ]);
    }));
    await writeAuditLog({
      action: "SALE_CREATED", entityType: "sale", entityId: id,
      description: `Venda concluída com ${items.reduce((total, item) => total + item.quantity, 0)} item(ns).`,
      amountCents: finalCents
    });

    state.cart = [];
    state.discount = 0;
    return { sale, items, receiptItems, payments };
  } finally {
    checkoutInProgress = false;
  }
}

async function updateProductStock(productId, stockQuantity) {
  const product = findById(state.data.products, productId);
  const productKey = docKey(product, productId);
  if (!productKey) throw new Error("Produto nao encontrado para atualizar o estoque.");
  await updateDoc(tenantDocument(collections.products, productKey), { stockQuantity });
  state.data.products = state.data.products.map((item) => Number(item.id) === Number(productId) ? { ...item, stockQuantity } : item);
}

async function saveStockMovement(productId, quantity, type, reason) {
  const id = nextId(state.data.stockMovements);
  await setDoc(tenantDocument(collections.stockMovements, id), tenantPayload({
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
      const selectedCompany = cachedCompany();
      if (!selectedCompany?.id) throw new Error("Selecione a empresa novamente.");
      state.company = selectedCompany;
      const profileSnapshot = await getDoc(tenantDocument(collections.users, firebaseUser.uid));
      if (!profileSnapshot.exists()) throw new Error("Usuário sem acesso ativo nesta empresa.");
      const storedProfile = profileSnapshot.data();
      if (storedProfile.isActive === false) throw new Error("Usuário sem acesso ativo.");
      const profileCompanyId = storedProfile.companyId || storedProfile.empresa_id;
      if (profileCompanyId && selectedCompany.id !== profileCompanyId) {
        throw new Error("Este usuário não pertence à empresa selecionada.");
      }
      const companySnapshot = await getDoc(doc(db, "companies", selectedCompany.id));
      if (!companySnapshot.exists() || companySnapshot.data().isActive === false) throw new Error("Empresa inexistente ou desativada.");
      state.company = companyFromSnapshot(companySnapshot);
      persistCompany(state.company);
      state.user = safeSessionUser({
        ...storedProfile,
        companyId: selectedCompany.id,
        docId: profileSnapshot.id,
        uid: firebaseUser.uid,
      });
      state.authStage = "user";
      state.loading = true;
      renderApp();
      subscribe();
      const authenticatedCompanyId = tenantId();
      const authenticatedUserKey = sessionUserKey(state.user);
      const protectedLoaders = [loadReceiptSettings()];
      if (isPrivilegedRole(state.user.role)) protectedLoaders.push(loadOfficialCompanyProfile());
      else state.companyProfile = null;
      await Promise.all(protectedLoaders);
      if (!state.user || tenantId() !== authenticatedCompanyId) return;
      if (sessionUserKey(state.user) !== authenticatedUserKey) return;
      if (state.user) renderApp();
    } catch (error) {
      await signOut(auth);
      renderUserLogin(userLoginErrorMessage(error));
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

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.notificationsOpen) closeNotifications();
});

function showKeyboardHelp() {
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop"><section class="modal">
      <header><h2>Navegação pelo teclado</h2><button class="icon-btn" type="button" data-close-modal aria-label="Fechar">${icon("close")}</button></header>
      <dl class="keyboard-help">
        <dt>Tab / Shift + Tab</dt><dd>Avançar ou voltar entre os controles.</dd>
        <dt>Enter / Espaço</dt><dd>Acionar o botão selecionado. Enter também envia formulários.</dd>
        <dt>↑ / ↓ no menu</dt><dd>Percorrer as abas. Enter abre a aba selecionada.</dd>
        <dt>Home / End no menu</dt><dd>Ir para a primeira ou última aba.</dd>
        <dt>Alt + M</dt><dd>Ir para o menu lateral.</dd>
        <dt>Alt + ←</dt><dd>Recolher a barra lateral.</dd>
        <dt>Alt + →</dt><dd>Expandir a barra lateral.</dd>
        <dt>Alt + B</dt><dd>Ir para a busca da tela atual.</dd>
        <dt>Esc</dt><dd>Fechar o diálogo ou as notificações.</dd>
        <dt>F1</dt><dd>Abrir esta ajuda.</dd>
      </dl>
      <footer><button class="btn secondary" type="button" data-close-modal>Fechar</button></footer>
    </section></div>`;
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
}

installKeyboardSupport({ showHelp: showKeyboardHelp });
init();

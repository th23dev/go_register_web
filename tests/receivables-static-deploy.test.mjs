import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("pagina publica entrega o modulo e invalida caches antigos", async () => {
  const [index, app, workflow, firebaseJson, packageJson, firebaseWorkflow, localServer] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "app.js"), "utf8"),
    readFile(path.join(root, ".github", "workflows", "pages.yml"), "utf8"),
    readFile(path.join(root, "firebase.json"), "utf8"),
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, ".github", "workflows", "firebase-deploy.yml"), "utf8"),
    readFile(path.join(root, "scripts", "serve.js"), "utf8"),
  ]);
  assert.match(index, /styles\.css\?v=site-ui-release-v3/);
  assert.match(index, /app\.js\?v=receipt-reopen-v1/);
  assert.match(index, /script-src 'self'/);
  assert.match(index, /connect-src[^;]+https:\/\/\*\.cloudfunctions\.net/);
  assert.match(app, /\.\/receivables-core\.mjs\?v=partial-payment-filter-v2/);
  assert.match(app, /\.\/stock-order-core\.mjs\?v=pos-availability-order-v1/);
  assert.match(workflow, /cp index\.html app\.js receivables-core\.mjs styles\.css _site\//);
  assert.match(workflow, /cp cash-register-core\.mjs stock-order-core\.mjs _site\//);
  assert.match(workflow, /cp admin\/index\.html admin\/admin\.js admin\/android-update-core\.mjs admin\/admin\.css admin\/notifications\.css _site\/admin\//);
  assert.doesNotMatch(workflow, /cp -R admin/);
  assert.match(workflow, /npm run test:receivables/);
  assert.ok(JSON.parse(firebaseJson).hosting.ignore.includes("**/tests/**"));
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(scripts.test, "npm run test:functions && npm run test:receivables");
  assert.equal(scripts["test:functions"], "node --test functions/tests/*.test.js");
  assert.equal(scripts["test:receivables"], "node --test tests/*.test.mjs admin/tests/*.test.cjs");
  assert.equal(scripts["test:emulator"], "node --test --test-concurrency=1 tests/firestore.rules.test.js");
  assert.equal(scripts["emulators:test"], "firebase emulators:exec --only firestore \"npm run test:emulator\"");
  assert.match(firebaseWorkflow, /run: npm test/);
  assert.match(firebaseWorkflow, /run: npm run emulators:test/);
  assert.match(localServer, /"\.mjs": "text\/javascript; charset=utf-8"/);
});

test("login usa o vinculo atual e traduz erros de autenticacao", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");
  const start = app.indexOf('function renderUserLogin(error = "")');
  const end = app.indexOf("function isAllowedPassword", start);
  const loginSource = app.slice(start, end);

  assert.match(loginSource, /aliasSnapshot\.data\(\)\.email \|\| aliasSnapshot\.data\(\)\.authEmail/);
  assert.match(loginSource, /renderUserLogin\(userLoginErrorMessage\(loginError\)\)/);
  assert.match(loginSource, /auth\/invalid-credential/);
  assert.match(loginSource, /error\?\.code === "permission-denied"/);
});

test("tema branco preserva o classico e adapta a barra lateral", async () => {
  const [app, styles] = await Promise.all([
    readFile(path.join(root, "app.js"), "utf8"),
    readFile(path.join(root, "styles.css"), "utf8"),
  ]);

  assert.match(app, /\["classic", "Clássico"\]/);
  assert.match(app, /\["white", "Branco"\]/);
  assert.match(styles, /body\[data-theme="classic"\],\s*body\[data-theme="white"\]/);
  assert.match(styles, /body\[data-theme="white"\]\s*{[^}]*--sidebar-bg:\s*#ffffff/s);
  assert.match(styles, /\.sidebar\s*{[^}]*background:\s*var\(--sidebar-bg\)/s);
  assert.match(styles, /body\.dark\s*{[^}]*--sidebar-bg:/s);
});

test("menu usa os icones corretos para vendas e caixa", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");

  assert.match(app, /\["pos", "Vendas", "payments", "all"\]/);
  assert.match(app, /\["cash", "Caixa", "point_of_sale", "all"\]/);
});

test("baixo estoque usa o mesmo limite de rolagem do extrato recente", async () => {
  const [app, styles] = await Promise.all([
    readFile(path.join(root, "app.js"), "utf8"),
    readFile(path.join(root, "styles.css"), "utf8"),
  ]);

  assert.match(app, /transactions transactions-scroll transactions-scroll--low-stock/);
  assert.match(styles, /\.transactions-scroll--recent,\s*\.transactions-scroll--low-stock\s*{\s*max-height:\s*430px;/s);
});

test("login acompanha o tema sem faixa rigida nem autofill amarelo", async () => {
  const styles = await readFile(path.join(root, "styles.css"), "utf8");

  assert.match(styles, /\.login-shell\s*{[^}]*var\(--background\)/s);
  assert.doesNotMatch(styles, /\.login-shell\s*{[^}]*background:\s*#07152c/s);
  assert.doesNotMatch(styles, /\.login-shell\s*{[^}]*gradient\(/s);
  assert.match(styles, /\.login-shell::before\s*{\s*content:\s*none;/s);
  assert.match(styles, /\.login-card\s*{[^}]*box-shadow:\s*0 16px 48px/s);
  assert.match(styles, /\.login-card input:-webkit-autofill[\s\S]*-webkit-text-fill-color:\s*var\(--text\)/);
  assert.match(styles, /\.login-card input:-webkit-autofill[\s\S]*color-mix\(in srgb, var\(--surface\)/);
});

test("fluxo de contas a receber nao exibe avisos explicativos redundantes", async () => {
  const [app, styles] = await Promise.all([
    readFile(path.join(root, "app.js"), "utf8"),
    readFile(path.join(root, "styles.css"), "utf8"),
  ]);
  const start = app.indexOf("function renderReceivables()");
  const end = app.indexOf("function openProductModal", start);
  const receivablesSource = app.slice(start, end);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.doesNotMatch(receivablesSource, /Controle manual de d[ií]vidas|Esta conta controla somente a d[ií]vida|Este pagamento reduz a d[ií]vida/);
  assert.doesNotMatch(app, /receivables-scope-notice/);
  assert.doesNotMatch(styles, /receivables-scope-notice/);
});

test("nenhuma tela exibe caixas de aviso embutidas", async () => {
  const [app, styles, admin, adminStyles] = await Promise.all([
    readFile(path.join(root, "app.js"), "utf8"),
    readFile(path.join(root, "styles.css"), "utf8"),
    readFile(path.join(root, "admin", "admin.js"), "utf8"),
    readFile(path.join(root, "admin", "admin.css"), "utf8"),
  ]);

  assert.doesNotMatch(app, /class="[^"]*\bnotice\b/);
  assert.doesNotMatch(styles, /\.notice\b|\.error-notice\b|\.receivables-plan-notice\b/);
  assert.doesNotMatch(admin, /class="[^"]*\bnotice\b|addon-notice|addon-private-note/);
  assert.doesNotMatch(adminStyles, /addon-notice|addon-private-note/);
});

test("cada cliente possui acesso ao seu historico individual de pagamentos", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");
  const historyStart = app.indexOf("function openReceivableCustomerPaymentHistory");
  const historyEnd = app.indexOf("function whatsappPhone", historyStart);
  const historySource = app.slice(historyStart, historyEnd);

  assert.match(app, /data-receivable-customer-history=[\s\S]*Histórico<\/button>/);
  assert.match(app, /openReceivableCustomerPaymentHistory\(button\.dataset\.receivableCustomerHistory\)/);
  assert.match(historySource, /receivablePaymentsForCustomer\(state\.receivables\.payments, customerId\)/);
  assert.match(historySource, /Dívida:/);
});

test("clientes podem ser removidos sem apagar o historico", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("async function removeReceivableCustomer");
  const end = app.indexOf("function openReceivableModal", start);
  const removalSource = app.slice(start, end);

  assert.match(app, /data-remove-receivable-customer=/);
  assert.match(app, /removeReceivableCustomer\(button\.dataset\.removeReceivableCustomer\)/);
  assert.match(removalSource, /pendingAccounts\.length/);
  assert.match(removalSource, /name="confirmationName"/);
  assert.match(removalSource, /normalizeName\(form\.get\("confirmationName"\)\) !== normalizeName\(customerName\)/);
  assert.match(removalSource, /isActive: false/);
  assert.doesNotMatch(removalSource, /deleteDoc/);
});

test("lancamento pode ser cancelado ou apagado sem depender do Blaze", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("async function cancelReceivable(receivableKey)");
  const end = app.indexOf("function openReceivablePaymentHistory", start);
  const cancellationSource = app.slice(start, end);

  assert.match(app, /data-cancel-receivable=/);
  assert.match(app, /\["CANCELLED", "Canceladas"\]/);
  assert.match(cancellationSource, /requestCancellationPassword\(\)/);
  assert.match(cancellationSource, /openChoiceModal\(/);
  assert.match(cancellationSource, /writeBatch\(db\)/);
  assert.match(cancellationSource, /paymentSnapshot\.docs\.forEach/);
  assert.match(cancellationSource, /batch\.delete\(reference\)/);
  assert.match(cancellationSource, /status: "CANCELLED"/);
  assert.match(cancellationSource, /updateDoc\(reference/);
  assert.match(cancellationSource, /alreadyCancelled/);
  assert.match(cancellationSource, /"PAID", "CANCELLED"/);
  assert.doesNotMatch(app, /cancelReceivableCallable/);
});

test("todos os filtros agrupam as dividas por cliente em ordem alfabetica", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("function renderReceivables()");
  const end = app.indexOf("function reportSales(bounds)", start);
  const pageSource = app.slice(start, end);

  assert.match(pageSource, /const accounts = groupReceivablesByCustomer\(matchingAccounts\);/);
});

test("backup operacional inclui o modulo sem dados de cobranca do plano", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("function exportBackupJson()");
  const end = app.indexOf("function dateStamp()", start);
  const backupSource = app.slice(start, end);
  assert.match(backupSource, /schemaVersion: 3/);
  assert.match(backupSource, /companyId: tenantId\(\)/);
  assert.match(backupSource, /customers: backupDocuments\(state\.receivables\.customers\)/);
  assert.match(backupSource, /receivables: backupDocuments\(state\.receivables\.receivables\)/);
  assert.match(backupSource, /receivable_payments: backupDocuments\(state\.receivables\.payments\)/);
  assert.doesNotMatch(backupSource, /billing|planPrice|monthlyPrice|subscriptionPrice|passwordHash|sessionToken/i);
});

test("fluxo de recebimento nao grava entrada financeira nem venda", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("function openReceivablePaymentModal");
  const end = app.indexOf("function openReceivablePaymentHistory", start);
  const paymentSource = app.slice(start, end);
  assert.match(paymentSource, /runTransaction/);
  assert.match(paymentSource, /receivable_payments|receivablesCollections\.payments/);
  assert.match(paymentSource, /pendingReceivablePayments\.has\(receivableId\)/);
  assert.match(paymentSource, /getOrCreateReceivablePaymentRetry\(companyId, receivableId, fingerprint\)/);
  assert.match(paymentSource, /clearReceivablePaymentRetry\(operation\.scope, paymentId\)/);
  assert.match(app, /O navegador bloqueou o armazenamento seguro da tentativa/);
  assert.match(paymentSource, /const timestamp = Math\.max\(/);
  assert.doesNotMatch(paymentSource, /financial_entries|collections\.entries|collections\.sales/);
});

test("backup aguarda entitlement e snapshots completos", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("function exportBackupJson()");
  const end = app.indexOf("function dateStamp()", start);
  const backupSource = app.slice(start, end);
  assert.match(backupSource, /!state\.receivablesEntitlementLoaded/);
  assert.match(backupSource, /!receivablesDataReady\(\)/);
  assert.match(backupSource, /state\.receivables\.errors\.size > 0/);
  assert.match(
    backupSource,
    /if \(state\.receivables\.errors\.size > 0\)[\s\S]*if \(state\.receivablesEntitlement && !receivablesDataReady\(\)\)/,
  );
});

test("modal bloqueia fechamento enquanto o envio esta em andamento", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("function openModal(");
  const end = app.indexOf("function openFormDialog", start);
  const modalSource = app.slice(start, end);
  const afterSubmitAwait = modalSource.slice(modalSource.indexOf("await onSubmit"));
  assert.match(modalSource, /const formElement = event\.currentTarget/);
  assert.match(modalSource, /new FormData\(formElement\)/);
  assert.doesNotMatch(afterSubmitAwait, /event\.currentTarget/);
  assert.match(modalSource, /dataset\.submitting = "true"/);
  assert.match(modalSource, /closeButtons\.forEach\(\(button\) => \{ button\.disabled = true; \}\)/);
  assert.match(modalSource, /#modalForm\[data-submitting='true'\]/);
});

test("pagina de contas nao exibe o aviso permanente de controle manual", async () => {
  const app = await readFile(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("function renderReceivables()");
  const end = app.indexOf("function reportSales", start);
  const receivablesPageSource = app.slice(start, end);
  assert.doesNotMatch(receivablesPageSource, /Controle manual de dívidas/);
  assert.doesNotMatch(receivablesPageSource, /registre também uma Entrada Manual/);
});

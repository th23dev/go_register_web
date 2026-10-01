const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "admin.js"), "utf8");
function recoveryHarness(data, exists = true) {
  const writes = [];
  const context = {
    db: {}, auth: { currentUser: { uid: "platform-admin" } },
    doc: (_db, collection, id) => ({ collection, id }),
    deleteField: () => "DELETE_FIELD", serverTimestamp: () => "SERVER_TIME",
    runTransaction: async (_db, callback) => callback({
      get: async () => ({ exists: () => exists, data: () => data }),
      update: (ref, payload) => writes.push({ ref, payload })
    })
  };
  const declarations = [
    source.match(/const storedMillis=.*?;\r?\n/)[0],
    source.match(/const companyDeletionLeaseMillis=.*?;\r?\n/)[0],
    source.match(/function companyDeletionCanStart.*?\}\r?\n/)[0],
    source.slice(source.indexOf("async function recoverCompanyDataDeletion"), source.indexOf("async function verifyPlatformAdministrator"))
  ].join("\n");
  vm.runInNewContext(`${declarations}\nthis.recover=recoverCompanyDataDeletion;`, context);
  return { recover: context.recover, writes };
}

test("recupera empresa ativa com limpeza antiga que falhou", async () => {
  const harness = recoveryHarness({ isActive: true, dataDeletionInProgress: true,
    dataDeletionStartedAt: Date.now() - 3600000, dataDeletionFailedAt: Date.now() - 3500000 });
  await harness.recover({ id: "company", isActive: true });
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].payload.isActive, true);
  assert.equal(harness.writes[0].payload.dataDeletionInProgress, "DELETE_FIELD");
  assert.equal(harness.writes[0].ref.collection, "companies");
  assert.equal(harness.writes[0].payload.dataDeletionRecoveredBy, "platform-admin");
});

test("leitura atual impede liberar limpeza recente mesmo com cache antigo", async () => {
  const harness = recoveryHarness({ isActive: false, dataDeletionInProgress: true,
    dataDeletionStartedAt: Date.now() - 60000 });
  await assert.rejects(harness.recover({ id: "company", dataDeletionFailedAt: 1 }), /limpeza em andamento/);
  assert.equal(harness.writes.length, 0);
});

test("empresa sem trava e empresa inexistente não são alteradas", async () => {
  const unlocked = recoveryHarness({ isActive: true, dataDeletionInProgress: false });
  await assert.rejects(unlocked.recover({ id: "company" }), /não possui uma trava/);
  const missing = recoveryHarness({}, false);
  await assert.rejects(missing.recover({ id: "company" }), /não encontrada/);
  assert.equal(unlocked.writes.length + missing.writes.length, 0);
});

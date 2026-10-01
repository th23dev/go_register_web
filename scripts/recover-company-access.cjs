// Recupera somente uma trava de limpeza que falhou em uma empresa já ativa.
const { getGlobalDefaultAccount, getAccessToken } = require("firebase-tools/lib/auth");

async function main() {
  const [companyId, ...options] = process.argv.slice(2);
  if (!companyId || !/^[A-Za-z0-9_-]+$/.test(companyId)) throw new Error("Informe o ID exato da empresa.");
  const account = getGlobalDefaultAccount();
  if (!account) throw new Error("Faça login na CLI do Firebase primeiro.");
  const token = await getAccessToken(account.tokens.refresh_token, ["https://www.googleapis.com/auth/cloud-platform"]);
  const headers = { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" };
  const url = `https://firestore.googleapis.com/v1/projects/goregister-7394b/databases/(default)/documents/companies/${companyId}`;
  const mask = ["name", "isActive", "dataDeletionInProgress", "dataDeletionStartedAt", "dataDeletionFailedAt"];
  const readUrl = `${url}?${mask.map(key => `mask.fieldPaths=${key}`).join("&")}`;
  const response = await fetch(readUrl, { headers });
  if (!response.ok) throw new Error(`Falha ao consultar empresa: HTTP ${response.status}`);
  const document = await response.json();
  const fields = document.fields || {};
  if (fields.isActive?.booleanValue !== true || fields.dataDeletionInProgress?.booleanValue !== true) {
    throw new Error("A empresa deve estar ativa e possuir uma trava de limpeza pendente.");
  }
  const startedAt = Date.parse(fields.dataDeletionStartedAt?.timestampValue);
  const failedAt = Date.parse(fields.dataDeletionFailedAt?.timestampValue);
  if (!Number.isFinite(startedAt) || !Number.isFinite(failedAt) || failedAt < startedAt || startedAt > Date.now() - 30 * 60 * 1000) {
    throw new Error("Não há evidência de uma limpeza antiga que falhou. Recuperação interrompida.");
  }
  console.log(JSON.stringify({ companyId, name: fields.name?.stringValue, updateTime: document.updateTime, startedAt: new Date(startedAt).toISOString(), failedAt: new Date(failedAt).toISOString(), apply: options.includes("--apply") }));
  if (!options.includes("--apply")) return;
  const recoveryFields = {
    dataDeletionInProgress: { booleanValue: false },
    dataDeletionRecoveredAt: { timestampValue: new Date().toISOString() },
    dataDeletionRecoveryReason: { stringValue: "Recuperação de acesso: empresa ativa com limpeza antiga que falhou." }
  };
  const query = new URLSearchParams({ "currentDocument.updateTime": document.updateTime });
  for (const key of Object.keys(recoveryFields)) query.append("updateMask.fieldPaths", key);
  const updated = await fetch(`${url}?${query}`, { method: "PATCH", headers, body: JSON.stringify({ fields: recoveryFields }) });
  if (!updated.ok) throw new Error(`Falha na recuperação: HTTP ${updated.status}. Nenhuma nova tentativa automática.`);
  const verified = await fetch(readUrl, { headers });
  if (!verified.ok) throw new Error(`Falha na verificação: HTTP ${verified.status}`);
  const result = await verified.json();
  if (result.fields?.isActive?.booleanValue !== true || result.fields?.dataDeletionInProgress?.booleanValue !== false) {
    throw new Error("A recuperação não foi confirmada.");
  }
  console.log("Acesso recuperado; dados operacionais e histórico da falha preservados.");
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

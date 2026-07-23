const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { createHash, randomBytes } = require("node:crypto");

initializeApp();

const tenantCollections = ["products", "sales", "categories", "suppliers", "cash_registers", "financial_entries", "financial_exits", "stock_movements", "settings"];

async function requirePlatformAdministrator(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Faça login como administrador da plataforma.");
  const administratorSnapshot = await getFirestore().doc(`platform_admins/${request.auth.uid}`).get();
  if (!administratorSnapshot.exists || administratorSnapshot.data().isActive === false) {
    throw new HttpsError("permission-denied", "Esta conta não possui autorização administrativa.");
  }
}

async function requireCompany(companyId) {
  const cleanCompanyId = String(companyId || "").trim();
  if (!cleanCompanyId) throw new HttpsError("invalid-argument", "Empresa inválida.");
  const companySnapshot = await getFirestore().doc(`companies/${cleanCompanyId}`).get();
  if (!companySnapshot.exists) throw new HttpsError("not-found", "Empresa não encontrada.");
  return cleanCompanyId;
}

exports.updateCompanyUserPassword = onCall({ region: "southamerica-east1" }, async (request) => {
  await requirePlatformAdministrator(request);
  const database = getFirestore();
  const uid = String(request.data?.uid || "").trim();
  const password = String(request.data?.password || "");
  if (!uid) throw new HttpsError("invalid-argument", "Usuário inválido.");
  if (password.length < 6 || password.length > 128) {
    throw new HttpsError("invalid-argument", "A senha deve ter entre 6 e 128 caracteres.");
  }

  const companyId = String(request.data?.companyId || "").trim();
  if (!companyId) throw new HttpsError("invalid-argument", "Empresa inválida.");
  const userReference = database.doc(`companies/${companyId}/users/${uid}`);
  const userSnapshot = await userReference.get();
  if (!userSnapshot.exists || !userSnapshot.data().empresa_id) {
    throw new HttpsError("not-found", "Usuário de empresa não encontrado.");
  }

  await getAuth().updateUser(uid, { password });
  await userReference.update({
    passwordUpdatedAt: FieldValue.serverTimestamp(),
    passwordUpdatedBy: request.auth.uid,
    updatedAt: FieldValue.serverTimestamp()
  });

  return { success: true };
});

exports.resetCompanyCancellationPassword = onCall({ region: "southamerica-east1" }, async (request) => {
  await requirePlatformAdministrator(request);
  const companyId = await requireCompany(request.data?.companyId);
  const password = String(request.data?.password || "");
  if (password.length < 6 || password.length > 128) throw new HttpsError("invalid-argument", "A senha deve ter entre 6 e 128 caracteres.");
  const salt = randomBytes(24).toString("hex");
  const hash = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  await getFirestore().doc(`companies/${companyId}/settings/cancellation`).set({id:"cancellation",empresa_id:companyId,passwordHash:`sha256$${salt}$${hash}`,updatedAt:Date.now(),updatedByPlatformAdmin:request.auth.uid},{merge:true});
  return { success: true };
});

exports.clearCompanyData = onCall({ region: "southamerica-east1", timeoutSeconds: 540 }, async (request) => {
  await requirePlatformAdministrator(request);
  const companyId = await requireCompany(request.data?.companyId);
  if (request.data?.confirmation !== companyId) throw new HttpsError("invalid-argument", "Confirmação de exclusão inválida.");
  const database = getFirestore();
  const writer = database.bulkWriter();
  let deletedDocuments = 0;
  for (const collectionName of tenantCollections) {
    const snapshot = await database.collection(`companies/${companyId}/${collectionName}`).get();
    snapshot.docs.forEach((documentSnapshot) => { writer.delete(documentSnapshot.ref); deletedDocuments += 1; });
  }
  await writer.close();
  await database.doc(`companies/${companyId}`).set({dataClearedAt:FieldValue.serverTimestamp(),dataClearedBy:request.auth.uid,updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return { success: true, deletedDocuments };
});

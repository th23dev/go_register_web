import qrcode from "./assets/vendor/qrcode.mjs";

export function receiptSubtotalCents(sale, items = []) {
  const saved = Number(sale.totalAmount);
  if (sale.totalAmount != null && Number.isFinite(saved) && (saved > 0 || Number(sale.finalAmount) === 0)) {
    return Math.round(saved * 100);
  }
  if (items.length) return items.reduce((sum, item) => sum + Number(item.subtotalCents || 0), 0);
  return Math.round(Number(sale.finalAmount || 0) * 100) + Math.round(Number(sale.discount || 0) * 100);
}

export function receiptQrPayload(companyId, sale) {
  return `GO_REGISTER|v1|company=${encodeURIComponent(companyId || "")}|sale=${sale.id}|time=${sale.timestamp}|total=${Math.round(Number(sale.finalAmount || 0) * 100)}|cancelled=${sale.isCancelled === true}`;
}

export function receiptQrSvg(companyId, sale) {
  const code = qrcode(0, "M");
  code.addData(receiptQrPayload(companyId, sale), "Byte");
  code.make();
  return code.createSvgTag({ scalable: true, margin: 8, cellSize: 2 })
    .replace("<svg ", '<svg class="receipt-qr-code" role="img" aria-label="QR Code de identificação da venda" ');
}

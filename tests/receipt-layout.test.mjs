import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { receiptSubtotalCents, receiptQrPayload, receiptQrSvg } from "../receipt-core.mjs";

test("subtotal usa valor salvo e recupera vendas antigas sem subtotal", () => {
  assert.equal(receiptSubtotalCents({ totalAmount: 200, finalAmount: 178.6, discount: 21.4 }), 20000);
  assert.equal(receiptSubtotalCents({ finalAmount: 178.6, discount: 21.4 }), 20000);
  assert.equal(receiptSubtotalCents({ finalAmount: 15 }, [{ subtotalCents: 1500 }]), 1500);
});

test("QR identifica venda e cancelamento sem incluir dados pessoais", () => {
  const sale = { id: 123, timestamp: 1000, finalAmount: 178.6 };
  assert.equal(receiptQrPayload("company", sale), "GO_REGISTER|v1|company=company|sale=123|time=1000|total=17860|cancelled=false");
  assert.match(receiptQrPayload("company", { ...sale, isCancelled: true }), /cancelled=true$/);
  const svg = receiptQrSvg("company", sale);
  assert.match(svg, /<svg/);
  assert.match(svg, /<path/);
});

test("recibo e compartilhamento usam pagamentos, subtotal, desconto e total nessa ordem", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const root = { innerHTML: "", querySelector: selector => selector === ".receipt-logo" ? null : { addEventListener() {} }, querySelectorAll: () => [] };
  const result = { sale: { id: 123, timestamp: 1000, totalAmount: 200, discount: 21.4, finalAmount: 178.6 }, receiptItems: [{ name: "Produto <teste>", quantity: 20, unitPriceCents: 1000, subtotalCents: 20000 }], payments: [{ method: "CASH", amountCents: 12330 }, { method: "DEBIT_CARD", amountCents: 5530 }] };
  const context = vm.createContext({
    state: { company: { id: "company", name: "Loja" }, data: { users: [] }, receiptSettings: {} },
    document: { querySelector: () => root }, receiptSubtotalCents, receiptQrSvg,
    money: new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }),
    safeReceiptLogoUrl: () => "", companyTaxIdentifier: () => "", formatCompanyIdentifier: value => value,
    formatReceiptDateTime: () => "01/10/2026 H 11:46", formatReceiptQuantity: String,
    paymentMethodLabel: value => value, icon: () => "", printSaleReceipt() {},
    escapeHtml: value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;"), result
  });
  vm.runInContext(source.slice(source.indexOf("function buildSaleReceiptText("), source.indexOf("async function shareSaleReceipt(")), context);
  vm.runInContext(source.slice(source.indexOf("function openSaleReceipt("), source.indexOf("function handleCheckoutError(")), context);
  vm.runInContext("openSaleReceipt(result)", context);
  assert.match(root.innerHTML, /Produto &lt;teste&gt;/);
  assert.match(root.innerHTML, /class="receipt-table"/);
  assert.match(root.innerHTML, /000123/);
  for (const output of [root.innerHTML, vm.runInContext("buildSaleReceiptText(result)", context)]) {
    assert.ok(output.indexOf("Pagamentos") < output.indexOf("SUBTOTAL"));
    assert.ok(output.indexOf("SUBTOTAL") < output.indexOf("DESCONTO"));
    assert.match(output, /178,60/);
  }
});

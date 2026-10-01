import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('reabre venda salva preservando valores, pagamentos e produto removido', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const handlers = {};
  const root = {
    innerHTML: '',
    querySelector(selector) {
      return { addEventListener: (_, handler) => { handlers[selector] = handler; }, focus() {} };
    },
  };
  let receipt;
  const sale = { id: 42, timestamp: 1000, totalAmount: 50, discount: 2, finalAmount: 48 };
  const record = { docId: 'sale-42', sale, items: [{ productId: 9, quantity: 2, unitPrice: 25, subtotal: 50 }] };
  const context = vm.createContext({
    allTransactions: () => [{ kind: 'sale', refId: 'sale-42', isCancelled: true }],
    state: { data: { sales: [record], products: [] } },
    document: { querySelector: () => root }, icon: () => '',
    saleData: item => item.sale, docKey: item => item.docId,
    saleItems: item => item.items, saleTimestamp: () => 1000,
    saleAmount: () => 48, saleIsCancelled: () => true,
    salePaymentParts: () => [{ method: 'PIX', amount: 28 }, { method: 'CASH', amount: 20 }],
    openSaleReceipt: result => { receipt = result; },
    toast: message => assert.fail(message),
  });
  vm.runInContext(source.slice(source.indexOf('function openTransactionOptions('), source.indexOf('function openSaleReceipt(')), context);
  vm.runInContext("openTransactionOptions('sale', 'sale-42')", context);
  handlers['[data-reopen-receipt]']();
  assert.equal(receipt.sale.finalAmount, 48);
  assert.equal(receipt.sale.discount, 2);
  assert.equal(receipt.sale.isCancelled, true);
  assert.equal(receipt.receiptItems[0].name, 'Produto #9');
  assert.equal(receipt.receiptItems[0].subtotalCents, 5000);
  assert.equal(receipt.payments[0].amountCents, 2800);
  assert.equal(receipt.payments[1].amountCents, 2000);
  assert.ok(!root.innerHTML.includes('data-cancel-option'));
});

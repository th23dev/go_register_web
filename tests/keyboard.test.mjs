import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberFocus, installKeyboardSupport } from '../keyboard.mjs';

test('restaura campo e selecao depois que a tela e reconstruida', () => {
  const originalDocument = globalThis.document;
  const old = { hasAttribute: (name) => name === 'id', getAttribute: () => 'search', selectionStart: 2, selectionEnd: 4 };
  let focused = false;
  let selection;
  const replacement = { getAttribute: () => 'search', focus: () => { focused = true; }, setSelectionRange: (...range) => { selection = range; } };
  globalThis.document = { activeElement: old };
  try {
    const restore = rememberFocus({ contains: () => true, querySelectorAll: () => [replacement] });
    restore();
    assert.equal(focused, true);
    assert.deepEqual(selection, [2, 4]);
  } finally { globalThis.document = originalDocument; }
});

test('setas navegam no menu e Escape cancela pelo controle do dialogo', () => {
  const originalDocument = globalThis.document;
  const originalObserver = globalThis.MutationObserver;
  const listeners = {};
  let modal = null;
  let cancelled = 0;
  let collapsed = false;
  let toggleCount = 0;
  const shell = {
    classList: { contains: () => collapsed },
    querySelector: () => ({ click: () => { collapsed = !collapsed; toggleCount++; } }),
  };
  const buttons = Array.from({ length: 3 }, () => ({
    tabIndex: 0, getClientRects: () => [1], closest: () => null,
    focus() { globalThis.document.activeElement = this; },
  }));
  const nav = { querySelectorAll: () => buttons };
  globalThis.document = {
    activeElement: buttons[0],
    addEventListener: (type, listener) => { listeners[type] = listener; },
    getElementById: () => ({}),
    querySelector: (selector) => selector === '.app-shell' ? shell : modal,
  };
  globalThis.MutationObserver = class { observe() {} };
  const press = (key, altKey = false) => {
    const event = { key, altKey, target: { closest: () => nav }, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
    listeners.keydown(event);
    return event;
  };
  try {
    installKeyboardSupport({ showHelp() {} });
    press('ArrowUp');
    assert.equal(document.activeElement, buttons[2]);
    press('Home');
    assert.equal(document.activeElement, buttons[0]);
    press('ArrowDown');
    assert.equal(document.activeElement, buttons[1]);
    assert.equal(press('ArrowLeft', true).prevented, true);
    assert.equal(collapsed, true);
    press('ArrowLeft', true);
    assert.equal(toggleCount, 1);
    assert.equal(press('ArrowRight', true).prevented, true);
    assert.equal(collapsed, false);
    press('ArrowRight', true);
    assert.equal(toggleCount, 2);
    modal = { querySelector: () => ({ click: () => { cancelled++; } }) };
    press('ArrowLeft', true);
    assert.equal(toggleCount, 2);
    assert.equal(press('Escape').prevented, true);
    assert.equal(cancelled, 1);
  } finally {
    globalThis.document = originalDocument;
    globalThis.MutationObserver = originalObserver;
  }
});

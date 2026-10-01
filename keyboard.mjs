const focusableSelector = 'button, a[href], input, select, textarea, [tabindex]';

function focusable(container) {
  return [...container.querySelectorAll(focusableSelector)].filter((element) =>
    !element.disabled && element.tabIndex >= 0 && element.getClientRects().length && !element.closest('[inert]'));
}

export function rememberFocus(container) {
  const element = document.activeElement;
  if (!container.contains(element)) return () => {};
  const attributes = ['id', 'data-view', 'data-action', 'name', 'data-receivables-view'];
  const attribute = attributes.find((name) => element.hasAttribute(name));
  if (!attribute) return () => {};
  const value = element.getAttribute(attribute);
  const start = element.selectionStart;
  const end = element.selectionEnd;
  return () => {
    const replacement = [...container.querySelectorAll(`[${attribute}]`)]
      .find((candidate) => candidate.getAttribute(attribute) === value);
    replacement?.focus({ preventScroll: true });
    if (replacement && typeof start === 'number' && typeof replacement.setSelectionRange === 'function') {
      replacement.setSelectionRange(start, end);
    }
  };
}

export function installKeyboardSupport({ showHelp }) {
  let dialog = null;
  let returnFocus = null;
  let lastFocus = document.activeElement;
  document.addEventListener('focusin', (event) => { lastFocus = event.target; });
  const observer = new MutationObserver(() => {
    const next = document.querySelector('#modalRoot .modal');
    if (next === dialog) return;
    const previous = dialog;
    dialog = next;
    const shell = document.querySelector('.app-shell');
    if (shell) shell.inert = Boolean(next);
    if (next) {
      if (!previous) returnFocus = lastFocus;
      next.setAttribute('role', 'dialog');
      next.setAttribute('aria-modal', 'true');
      next.tabIndex = -1;
      if (!next.hasAttribute('aria-labelledby')) {
        const heading = next.querySelector('h2');
        if (heading) {
          heading.id ||= 'keyboardDialogTitle';
          next.setAttribute('aria-labelledby', heading.id);
        }
      }
      next.querySelectorAll('header button').forEach((button) => {
        if (!button.hasAttribute('aria-label') && button.querySelector('.material-symbols-rounded')) button.setAttribute('aria-label', 'Fechar');
      });
      if (!next.contains(document.activeElement)) {
        const controls = focusable(next);
        const field = controls.find((element) => element.matches('input, select, textarea'));
        (field || controls[0] || next).focus();
      }
    } else if (previous) {
      if (returnFocus?.isConnected) returnFocus.focus();
      else document.querySelector('.main')?.focus();
      returnFocus = null;
    }
  });
  observer.observe(document.getElementById('app'), { childList: true, subtree: true });

  document.addEventListener('keydown', (event) => {
    if (event.isComposing || event.defaultPrevented) return;
    const modal = document.querySelector('#modalRoot .modal');
    if (modal) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        modal.querySelector('[data-close-modal], [data-dialog-cancel], [data-choice-cancel], [data-split-cancel], [data-close-receipt]')?.click();
      } else if (event.key === 'Tab') {
        const controls = focusable(modal);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !modal.contains(document.activeElement) || (event.shiftKey && [first, modal].includes(document.activeElement)) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last || modal : first || modal).focus();
        }
      }
      return;
    }
    if (event.key === 'F1' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      if (document.querySelector('#modalRoot')) showHelp();
      return;
    }
    const nav = event.target.closest?.('.sidebar .nav');
    if (nav && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const buttons = focusable(nav);
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault();
      buttons[next]?.focus();
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === 'arrowleft' || key === 'arrowright') {
        const shell = document.querySelector('.app-shell');
        const toggle = shell?.querySelector('.sidebar-toggle');
        if (toggle) {
          event.preventDefault();
          const shouldCollapse = key === 'arrowleft';
          if (shell.classList.contains('sidebar-collapsed') !== shouldCollapse) toggle.click();
        }
      } else if (key === 'm') {
        event.preventDefault();
        document.querySelector('.sidebar .nav button')?.focus();
      } else if (key === 'b') {
        const search = document.querySelector('.main input[type="search"], #posSearch, #inventorySearch, #genericSearch, #receivablesSearch, #receivablesCustomerSearch, #auditSearch');
        if (search) { event.preventDefault(); search.focus(); }
      }
    }
  }, true);
}

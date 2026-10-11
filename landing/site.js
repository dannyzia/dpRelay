/**
 * dP Relay landing — the only script on the site.
 *
 * The site contract is build-free static HTML/CSS; the build prompt permits
 * tiny vanilla JS for exactly two things: code language tabs and copy buttons.
 * Nothing here renders content — every tab panel and copy target already
 * exists in the HTML, so the page is fully readable with JS disabled (panels
 * fall back to all-visible via the `.is-active` class present in the markup).
 */
(function () {
  'use strict';

  /** Switch a code-tabs group to the clicked language. */
  function initTabs(root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('.tab[data-tab]'));
    var panels = Array.prototype.slice.call(root.querySelectorAll('[data-panel]'));
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var id = tab.getAttribute('data-tab');
        tabs.forEach(function (t) {
          t.setAttribute('aria-selected', String(t === tab));
        });
        panels.forEach(function (panel) {
          panel.classList.toggle('is-active', panel.getAttribute('data-panel') === id);
        });
      });
    });
  }

  /** Copy the visible panel's text, with a brief "Copied" confirmation. */
  function initCopy(root) {
    var buttons = Array.prototype.slice.call(root.querySelectorAll('.copy-btn[data-copy]'));
    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        var active = root.querySelector('[data-panel].is-active');
        if (!active || typeof navigator.clipboard === 'undefined') return;
        navigator.clipboard.writeText(active.textContent).then(function () {
          button.setAttribute('data-copied', 'true');
          button.textContent = 'Copied';
          window.setTimeout(function () {
            button.removeAttribute('data-copied');
            button.textContent = 'Copy';
          }, 1600);
        });
      });
    });
  }

  function boot() {
    var groups = document.querySelectorAll('.code-tabs');
    Array.prototype.forEach.call(groups, function (group) {
      initTabs(group);
      initCopy(group);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

(() => {
  const gallery = document.querySelector('#screenshotGallery');
  if (!gallery) return;
  const tablist = gallery.querySelector('[data-screenshot-tabs]');
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
  if (!tabs.length || panels.some(panel => !panel)) return;

  function select(index, focus = false) {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
    });
    if (focus) tabs[index].focus({ preventScroll: true });
  }

  tabs.forEach((tab, index) => {
    panels[index].setAttribute('role', 'tabpanel');
    panels[index].setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(next, true);
    });
  });

  const mobile = window.matchMedia('(max-width: 760px)');
  const updateOrientation = () => tablist.setAttribute('aria-orientation', mobile.matches ? 'horizontal' : 'vertical');
  mobile.addEventListener('change', updateOrientation);
  updateOrientation();
  select(Math.max(0, tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true')));
  gallery.classList.add('is-interactive');
  tablist.hidden = false;
})();

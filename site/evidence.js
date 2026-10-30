(() => {
  const dialog = document.querySelector('#evaluationDetail');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  const evaluations = {
    coordination: {
      group: 'Parallel development · Evaluation',
      title: 'Can coordination keep main healthy?',
      summary: 'Five scenarios, three repetitions each, with and without coordination.',
      template: '#coordinationEvaluation'
    },
    rules: {
      group: 'Business rule checks · Evaluation',
      title: 'Do explicit rules improve the first attempt?',
      summary: 'One input-validation ticket from a 15-ticket comparison.',
      template: '#rulesEvaluation'
    }
  };
  const body = dialog.querySelector('#evaluationDetailBody');
  const closeButton = dialog.querySelector('.diagram-close');
  let trigger = null;
  let pointerStartedOutside = false;

  for (const link of document.querySelectorAll('[data-evaluation]')) {
    const evaluation = evaluations[link.dataset.evaluation];
    if (!evaluation) continue;
    link.setAttribute('aria-haspopup', 'dialog');
    link.setAttribute('aria-controls', dialog.id);
    link.setAttribute('aria-expanded', 'false');
    link.addEventListener('click', event => {
      // Modified clicks and browsers without dialog support retain the full-study link.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      trigger = link;
      dialog.querySelector('#evaluationDetailGroup').textContent = evaluation.group;
      dialog.querySelector('#evaluationDetailTitle').textContent = evaluation.title;
      dialog.querySelector('#evaluationDetailSummary').textContent = evaluation.summary;
      body.replaceChildren(document.querySelector(evaluation.template).content.cloneNode(true));
      link.setAttribute('aria-expanded', 'true');
      link.closest('tr').classList.add('is-selected');
      document.body.classList.add('evaluation-detail-open');
      dialog.showModal();
      body.scrollTop = 0;
      closeButton.focus({ preventScroll: true });
    });
  }

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not([disabled]), a[href], summary, [tabindex="0"]')]
      .filter(element => element.getClientRects().length > 0 && (!element.closest('details:not([open])') || element.tagName === 'SUMMARY'));
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('evaluation-detail-open');
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      trigger.closest('tr').classList.remove('is-selected');
      trigger.focus({ preventScroll: true });
    }
    trigger = null;
    pointerStartedOutside = false;
  });
  function outsideDialog(event) {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }
  dialog.addEventListener('pointerdown', event => { pointerStartedOutside = event.target === dialog && outsideDialog(event); });
  dialog.addEventListener('pointerup', event => {
    if (pointerStartedOutside && event.target === dialog && outsideDialog(event)) dialog.close();
    pointerStartedOutside = false;
  });
  dialog.addEventListener('pointercancel', () => { pointerStartedOutside = false; });
})();

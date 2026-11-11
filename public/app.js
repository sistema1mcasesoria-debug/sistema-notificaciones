const URGENT_PATTERN =
  /coactiva|orden\s+de\s+pago|resoluci[oó]n|esquela|requerimiento|multa|inductiva|embargo|fiscalizaci[oó]n/i;

const state = {
  dashboard: null,
  pollTimer: null,
  wasRunning: false,
  pendingDeleteClient: null,
  activeDetailNotificationId: null,
};

// Elementos principales
const btnCheckAll = document.getElementById('btn-check-all');
const btnOpenAddClient = document.getElementById('btn-open-add-client');
const btnEmptyAddClient = document.getElementById('btn-empty-add-client');
const btnClientsAdd = document.getElementById('btn-clients-add');
const btnClientsEmptyAdd = document.getElementById('btn-clients-empty-add');
const btnAckAll = document.getElementById('btn-ack-all');

const monitorPill = document.getElementById('monitor-pill');
const monitorPillText = document.getElementById('monitor-pill-text');
const loadingBanner = document.getElementById('loading-banner');
const loadingBannerDetail = document.getElementById('loading-banner-detail');

const kpiUnread = document.getElementById('kpi-unread');
const kpiUnreadMeta = document.getElementById('kpi-unread-meta');
const cardUnread = document.getElementById('card-unread');
const kpiClients = document.getElementById('kpi-clients');
const kpiClientsMeta = document.getElementById('kpi-clients-meta');
const kpiErrors = document.getElementById('kpi-errors');
const kpiErrorsMeta = document.getElementById('kpi-errors-meta');
const cardErrors = document.getElementById('card-errors');
const kpiLastCheck = document.getElementById('kpi-last-check');

const tabBadgeUnread = document.getElementById('tab-badge-unread');
const tabBadgeClients = document.getElementById('tab-badge-clients');

const filterForm = document.getElementById('filter-form');
const filterQuery = document.getElementById('filter-query');
const filterClient = document.getElementById('filter-client');
const filterMailbox = document.getElementById('filter-mailbox');
const filterOnlyNew = document.getElementById('filter-only-new');

const notificationsTbody = document.getElementById('notifications-tbody');
const inboxEmpty = document.getElementById('inbox-empty');
const clientsTbody = document.getElementById('clients-tbody');
const clientsEmpty = document.getElementById('clients-empty');
const runsTbody = document.getElementById('runs-tbody');
const runsEmpty = document.getElementById('runs-empty');

const clientDialog = document.getElementById('client-dialog');
const clientDialogTitle = document.getElementById('client-dialog-title');
const clientForm = document.getElementById('client-form');
const btnCloseClientDialog = document.getElementById('btn-close-client-dialog');
const btnCancelClient = document.getElementById('btn-cancel-client');
const btnSaveClient = document.getElementById('btn-save-client');
const modeRucRadio = document.getElementById('mode-ruc');
const modeDniRadio = document.getElementById('mode-dni');
const clientLabelInput = document.getElementById('client-label');
const clientDocLabel = document.getElementById('client-doc-label');
const docHint = document.getElementById('doc-hint');
const docErrorText = document.getElementById('doc-error-text');
const clientDocInput = document.getElementById('client-doc');
const solUserGroup = document.getElementById('sol-user-group');
const clientUserInput = document.getElementById('client-user');
const clientPasswordInput = document.getElementById('client-password');
const toggleSolPasswordBtn = document.getElementById('toggle-sol-password');
const clientFormServerError = document.getElementById('client-form-server-error');

const detailDialog = document.getElementById('detail-dialog');
const detailBody = document.getElementById('detail-body');
const btnCloseDetailDialog = document.getElementById('btn-close-detail-dialog');
const btnDetailAck = document.getElementById('btn-detail-ack');

const confirmDeleteDialog = document.getElementById('confirm-delete-dialog');
const confirmDeleteDesc = document.getElementById('confirm-delete-desc');

const toastEl = document.getElementById('toast');
let toastTimer = null;

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.toggle('is-error', isError);
  toastEl.hidden = false;
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 4500);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function createEyeIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle>';
  return svg;
}

function createCheckIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
  return svg;
}

function formatLocalTimestamp(raw) {
  if (!raw) return 'Nunca';
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return raw;

  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Error HTTP ${response.status}`);
  }
  return data;
}

// =========================================================
// LIGHT DISMISS FALLBACK PARA <dialog closedby="any">
// =========================================================
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const isOutsideDialog = (event, dialog) => {
    const r = dialog.getBoundingClientRect();
    return (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    );
  };

  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = isOutsideDialog(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutsideDialog(e, dialog)) {
        dialog.close();
      }
    });
  }
}

// =========================================================
// PESTAÑAS ACCESIBLES (ROVING TABINDEX + FLECHAS)
// =========================================================
function initTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));

  const activateTab = (selectedTab, focusTab = false) => {
    for (const tab of tabs) {
      const isSelected = tab === selectedTab;
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
    }
    for (const panel of panels) {
      const isMatch = panel.id === selectedTab.dataset.panel;
      panel.hidden = !isMatch;
    }
    if (focusTab) selectedTab.focus();
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (e) => {
      let nextIndex = null;
      if (e.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') nextIndex = 0;
      else if (e.key === 'End') nextIndex = tabs.length - 1;

      if (nextIndex !== null) {
        e.preventDefault();
        activateTab(tabs[nextIndex], true);
      }
    });
  });
}

// =========================================================
// VALIDACIÓN DE FORMULARIO POST-INTERACCIÓN Y ARIA SYNC
// =========================================================
function initFormAccessibility(form) {
  const announcer = document.createElement('div');
  announcer.setAttribute('aria-live', 'polite');
  announcer.classList.add('visually-hidden');
  document.body.append(announcer);

  let announceTimer = null;
  let announcedField = null;
  const flagged = new WeakSet();
  const announced = new WeakSet();
  const dirtyState = new WeakMap();
  const supportsUserInvalid = CSS.supports('selector(:user-invalid)');

  const linkError = (input, shown) => {
    const errorId = input.dataset.error;
    if (!errorId) return;
    const ids = (input.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter((id) => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
    else input.removeAttribute('aria-describedby');
  };

  const announceError = (input) => {
    const errorEl = document.getElementById(input.dataset.error || '');
    if (!errorEl) return;
    const labelText = input.labels?.[0]?.textContent?.replace('*', '').trim() || '';
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announcedField = input;
    announceTimer = setTimeout(() => {
      announcer.textContent = labelText
        ? `${labelText}: ${errorEl.textContent.trim()}`
        : errorEl.textContent.trim();
    }, 450);
  };

  const syncAria = (input, announce = false) => {
    if (!input.matches?.('input, select, textarea')) return;

    const isInvalid = supportsUserInvalid
      ? input.matches(':user-invalid')
      : input.classList.contains('user-invalid-fallback');

    if (isInvalid) {
      if (announce && !announced.has(input)) {
        announceError(input);
        announced.add(input);
      }
      input.setAttribute('aria-invalid', 'true');
      linkError(input, true);
      flagged.add(input);
    } else if (flagged.has(input) || input.getAttribute('aria-invalid') !== 'true') {
      input.setAttribute('aria-invalid', 'false');
      linkError(input, false);
      flagged.delete(input);
      announced.delete(input);
      if (announcedField === input) {
        clearTimeout(announceTimer);
        announcer.textContent = '';
      }
    }
  };

  const updateFallback = (input) => {
    if (supportsUserInvalid || !input.checkValidity) return;
    const valid = input.validity.valid;
    input.classList.toggle('user-invalid-fallback', !valid);
    input.classList.toggle('user-valid-fallback', valid);
  };

  form.querySelectorAll('input, select, textarea').forEach((node) => syncAria(node));

  form.addEventListener(
    'blur',
    (e) => {
      const target = e.target;
      if (!target.matches?.('input, select, textarea')) return;
      if (!supportsUserInvalid) {
        const st = dirtyState.get(target) || { hasInteracted: false, hasBlurred: false };
        st.hasBlurred = true;
        dirtyState.set(target, st);
        if (st.hasInteracted) updateFallback(target);
      }
      syncAria(target, true);
    },
    true,
  );

  form.addEventListener('input', (e) => {
    const target = e.target;
    if (!target.matches?.('input, select, textarea')) return;
    target.setCustomValidity('');
    if (!supportsUserInvalid) {
      const st = dirtyState.get(target) || { hasInteracted: false, hasBlurred: false };
      st.hasInteracted = true;
      dirtyState.set(target, st);
      if (st.hasBlurred) updateFallback(target);
    }
    if (target.hasAttribute('aria-invalid')) syncAria(target, false);
  });

  form.addEventListener(
    'invalid',
    (e) => {
      const target = e.target;
      if (!supportsUserInvalid) {
        dirtyState.set(target, { hasInteracted: true, hasBlurred: true });
        updateFallback(target);
      }
      announced.add(target);
      syncAria(target, false);
    },
    true,
  );

  form.addEventListener(
    'reset',
    () => {
      setTimeout(() => {
        for (const control of form.elements) {
          dirtyState.delete(control);
          control.classList.remove('user-invalid-fallback', 'user-valid-fallback');
          if (control.matches?.('input, select, textarea')) {
            control.setCustomValidity('');
            syncAria(control, false);
          }
        }
      });
    },
    true,
  );

  return {
    syncAll: () => {
      for (const control of form.elements) {
        if (control.matches?.('input, select, textarea')) {
          if (!supportsUserInvalid) {
            dirtyState.set(control, { hasInteracted: true, hasBlurred: true });
            updateFallback(control);
          }
          syncAria(control, false);
        }
      }
    },
  };
}

// =========================================================
// RENDERIZADO DEL DASHBOARD
// =========================================================
function renderMonitorStatus(monitorState) {
  const running = Boolean(monitorState?.isRunning);
  monitorPill.classList.toggle('is-running', running);
  loadingBanner.hidden = !running;
  btnCheckAll.disabled = running;
  btnCheckAll.textContent = running ? 'Cargando...' : 'Revisar todos ahora';
  btnAckAll.disabled = running;

  if (running) {
    const prog = monitorState.progress;
    if (prog) {
      monitorPillText.textContent = `Cargando (${prog.index}/${prog.total})...`;
      loadingBannerDetail.textContent = `Procesando en segundo plano [${prog.index}/${prog.total}] ${prog.label}...`;
    } else {
      monitorPillText.textContent = 'Cargando...';
      loadingBannerDetail.textContent =
        'Conectando con el navegador oculto en segundo plano e iniciando sesión en SUNAT...';
    }
  } else {
    monitorPillText.textContent = 'En espera';
    btnAckAll.textContent = 'Marcar todas como leídas en SUNAT';
  }
}

function renderStats(stats) {
  kpiUnread.textContent = String(stats.unreadAlerts);
  kpiUnreadMeta.textContent =
    stats.unreadAlerts > 0
      ? 'Notificaciones pendientes de atención'
      : 'Sin notificaciones pendientes';
  cardUnread.classList.toggle('has-alerts', stats.unreadAlerts > 0);

  kpiClients.textContent = String(stats.totalClients);
  kpiClientsMeta.textContent = `${stats.activeClients} activo(s) para monitoreo`;

  kpiErrors.textContent = String(stats.errorClients);
  kpiErrorsMeta.textContent =
    stats.errorClients > 0
      ? 'Revisa Clave SOL o Captcha'
      : 'Todos los accesos correctos';
  cardErrors.classList.toggle('has-errors', stats.errorClients > 0);

  kpiLastCheck.textContent = formatLocalTimestamp(stats.lastCheckedAt);

  tabBadgeUnread.textContent = String(stats.unreadAlerts);
  tabBadgeUnread.hidden = stats.unreadAlerts === 0;
  tabBadgeClients.textContent = String(stats.totalClients);
  btnAckAll.hidden = stats.unreadAlerts === 0;
}

function populateClientFilterSelect(clients) {
  const current = filterClient.value;
  filterClient.replaceChildren(el('option', '', 'Todos los clientes'));
  filterClient.firstElementChild.value = '';

  for (const client of clients) {
    const opt = el('option', '', `${client.label} (${client.docNumber})`);
    opt.value = String(client.id);
    filterClient.append(opt);
  }

  if (clients.some((c) => String(c.id) === current)) {
    filterClient.value = current;
  }
}

function createStatusBadge(status) {
  if (!status) return el('span', 'badge badge-neutral', 'Pendiente');
  if (status === 'OK') return el('span', 'badge badge-ok', 'OK');
  if (status === 'AUTH_ERROR') return el('span', 'badge badge-error', 'Clave incorrecta');
  if (status === 'CAPTCHA') return el('span', 'badge badge-warn', 'Captcha');
  if (status === 'SESSION_ACTIVE') return el('span', 'badge badge-urgent', 'Sesión en otra máquina');
  return el('span', 'badge badge-error', 'Error');
}

function createMailboxBadge(mailboxSource) {
  if (mailboxSource === 'MENSAJES') {
    return el('span', 'badge badge-mailbox-messages', 'Buzón Mensajes');
  }
  return el('span', 'badge badge-mailbox-notifications', 'Buzón Notificaciones');
}

function renderNotifications(notifications) {
  notificationsTbody.replaceChildren();
  const hasRows = notifications.length > 0;
  inboxEmpty.hidden = hasRows;
  document.getElementById('notifications-table').closest('.table-wrapper').hidden = !hasRows;

  if (!hasRows) return;

  for (const item of notifications) {
    const tr = document.createElement('tr');
    if (item.isNewAlert) tr.classList.add('is-new-row');

    // Col 1: TH Cliente / RUC
    const th = document.createElement('th');
    th.scope = 'row';
    th.append(el('span', 'cell-primary', item.clientLabel));
    th.append(el('span', 'cell-secondary', `Doc: ${item.docNumber}`));

    // Col 2: Estado
    const tdStatus = document.createElement('td');
    const isReviewedOrRead = !item.isNewAlert || item.readStatusSunat === 'Leído';
    if (!isReviewedOrRead) {
      tdStatus.append(el('span', 'badge badge-new', 'Nueva'));
    } else {
      tdStatus.append(
        item.readStatusSunat === 'Leído'
          ? el('span', 'badge badge-ok', 'Leída')
          : el('span', 'badge badge-neutral', 'Revisada'),
      );
    }
    if (URGENT_PATTERN.test(item.subject)) {
      tdStatus.append(el('span', 'badge badge-urgent', 'Importante'));
    }

    // Col 3: Buzón de origen (Buzón Notificaciones vs Buzón Mensajes)
    const tdMailbox = document.createElement('td');
    tdMailbox.append(createMailboxBadge(item.mailboxSource));

    // Col 4: Fecha SUNAT
    const tdDate = document.createElement('td');
    tdDate.append(el('span', 'cell-primary', item.publishedAt || 'Sin fecha'));
    tdDate.append(
      el('span', 'cell-secondary', `Detectada: ${formatLocalTimestamp(item.firstSeenAt)}`),
    );

    // Col 5: Asunto / Remitente
    const tdSubject = document.createElement('td');
    tdSubject.append(el('span', 'cell-primary', item.subject));
    const subParts = [item.sender, item.notificationType, item.readStatusSunat].filter(Boolean);
    if (item.attachmentPath) {
      subParts.push('📎 Adjunto listo');
    }
    if (subParts.length > 0) {
      tdSubject.append(el('span', 'cell-secondary', subParts.join(' • ')));
    }

    // Col 6: Código
    const tdCode = document.createElement('td');
    tdCode.textContent = item.sunatCode || '—';

    // Col 7: Acciones (Iconos: ojito para ver detalle, check SOLO si está pendiente de revisión)
    const tdActions = document.createElement('td');
    const actionsWrap = el('div', 'row-actions');

    const btnDetail = el('button', 'btn-action-icon');
    btnDetail.type = 'button';
    btnDetail.setAttribute('aria-label', `Ver detalle de notificación: ${item.subject}`);
    btnDetail.setAttribute('title', 'Ver detalle');
    btnDetail.append(createEyeIcon());
    btnDetail.addEventListener('click', () => openNotificationDetail(item));
    actionsWrap.append(btnDetail);

    // Si ya está revisado o figura como leída en SUNAT, NO debe aparecer el check
    if (!isReviewedOrRead) {
      const btnCheck = el('button', 'btn-action-icon btn-action-check');
      btnCheck.type = 'button';
      btnCheck.setAttribute('aria-label', `Marcar como leída en SUNAT: ${item.subject}`);
      btnCheck.setAttribute('title', 'Marcar como leída en SUNAT');
      btnCheck.append(createCheckIcon());
      btnCheck.addEventListener('click', () => markNotificationAsReadInSunat(item, btnCheck, tr, tdStatus));
      actionsWrap.append(btnCheck);
    }

    tdActions.append(actionsWrap);
    tr.append(th, tdStatus, tdMailbox, tdDate, tdSubject, tdCode, tdActions);
    notificationsTbody.append(tr);
  }
}

function renderClients(clients, isRunning) {
  clientsTbody.replaceChildren();
  const hasRows = clients.length > 0;
  clientsEmpty.hidden = hasRows;
  document.getElementById('clients-table').closest('.table-wrapper').hidden = !hasRows;

  if (!hasRows) return;

  for (const client of clients) {
    const tr = document.createElement('tr');

    const th = document.createElement('th');
    th.scope = 'row';
    th.append(el('span', 'cell-primary', client.label));
    th.append(el('span', 'cell-secondary', 'Credencial cifrada AES-256'));

    const tdDoc = document.createElement('td');
    tdDoc.append(el('span', 'cell-primary', `${client.loginMode}: ${client.docNumber}`));

    const tdUser = document.createElement('td');
    tdUser.textContent = client.solUserMasked || '—';

    const tdActive = document.createElement('td');
    tdActive.append(
      client.active
        ? el('span', 'badge badge-ok', 'Activo')
        : el('span', 'badge badge-neutral', 'Pausado'),
    );

    const tdStatus = document.createElement('td');
    tdStatus.append(createStatusBadge(client.lastStatus));
    if (client.lastCheckedAt) {
      tdStatus.append(el('span', 'cell-secondary', formatLocalTimestamp(client.lastCheckedAt)));
    }
    if (client.lastError) {
      tdStatus.append(el('span', 'cell-secondary', client.lastError));
    }

    const tdUnread = document.createElement('td');
    tdUnread.append(
      client.unreadAlertsCount > 0
        ? el('span', 'badge badge-new', `${client.unreadAlertsCount} nueva(s)`)
        : el('span', 'cell-secondary', '0'),
    );

    const tdActions = document.createElement('td');
    const actionsWrap = el('div', 'row-actions');

    const btnCheckOne = el('button', 'btn btn-primary btn-sm', 'Revisar');
    btnCheckOne.type = 'button';
    btnCheckOne.disabled = isRunning;
    btnCheckOne.addEventListener('click', () => triggerCheck(client.id));

    const btnEditKey = el('button', 'btn btn-secondary btn-sm', 'Actualizar clave');
    btnEditKey.type = 'button';
    btnEditKey.addEventListener('click', () => openClientModal(client));

    const btnToggle = el(
      'button',
      'btn btn-secondary btn-sm',
      client.active ? 'Pausar' : 'Activar',
    );
    btnToggle.type = 'button';
    btnToggle.addEventListener('click', () => toggleClient(client.id));

    const btnDelete = el('button', 'btn btn-ghost btn-sm', 'Eliminar');
    btnDelete.type = 'button';
    btnDelete.addEventListener('click', () => requestDeleteClient(client));

    actionsWrap.append(btnCheckOne, btnEditKey, btnToggle, btnDelete);
    tdActions.append(actionsWrap);

    tr.append(th, tdDoc, tdUser, tdActive, tdStatus, tdUnread, tdActions);
    clientsTbody.append(tr);
  }
}

function renderRuns(runs) {
  runsTbody.replaceChildren();
  const hasRows = runs.length > 0;
  runsEmpty.hidden = hasRows;
  document.getElementById('runs-table').closest('.table-wrapper').hidden = !hasRows;

  if (!hasRows) return;

  for (const run of runs) {
    const tr = document.createElement('tr');

    const th = document.createElement('th');
    th.scope = 'row';
    th.append(el('span', 'cell-primary', run.clientLabel));
    th.append(el('span', 'cell-secondary', run.docNumber));

    const tdDate = document.createElement('td');
    tdDate.textContent = formatLocalTimestamp(run.startedAt);

    const tdStatus = document.createElement('td');
    tdStatus.append(createStatusBadge(run.status));

    const tdTotal = document.createElement('td');
    tdTotal.textContent = String(run.totalFound);

    const tdNew = document.createElement('td');
    tdNew.textContent = String(run.newFound);

    const tdError = document.createElement('td');
    tdError.textContent = run.errorMessage || 'Revisión completada sin errores';

    tr.append(th, tdDate, tdStatus, tdTotal, tdNew, tdError);
    runsTbody.append(tr);
  }
}

// =========================================================
// CARGA DE DATOS Y POLLING EN VIVO
// =========================================================
async function loadDashboard() {
  const params = new URLSearchParams();
  if (filterQuery.value.trim()) params.set('q', filterQuery.value.trim());
  if (filterClient.value) params.set('clientId', filterClient.value);
  if (filterMailbox.value) params.set('mailboxSource', filterMailbox.value);
  if (filterOnlyNew.checked) params.set('onlyNew', 'true');

  const data = await apiJson(`/api/dashboard?${params.toString()}`);
  state.dashboard = data;

  renderMonitorStatus(data.monitorState);
  renderStats(data.stats);
  populateClientFilterSelect(data.clients);
  renderNotifications(data.notifications);
  renderClients(data.clients, Boolean(data.monitorState?.isRunning));
  renderRuns(data.runs);

  if (data.monitorState?.isRunning && !state.pollTimer) {
    startStatusPolling();
  }
}

function startStatusPolling() {
  if (state.pollTimer) return;
  state.wasRunning = true;

  state.pollTimer = setInterval(async () => {
    try {
      const data = await apiJson('/api/status');
      renderMonitorStatus(data.monitorState);
      renderStats(data.stats);

      if (!data.monitorState.isRunning && state.wasRunning) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        state.wasRunning = false;
        await loadDashboard();

        const summary = data.monitorState.lastSummary;
        if (data.monitorState.lastRunError) {
          showToast(`Error en revisión: ${data.monitorState.lastRunError}`, true);
        } else if (summary) {
          showToast(
            `Revisión finalizada: ${summary.clientsOk} OK, ${summary.clientsFailed} con error, ${summary.newNotificationsTotal} alerta(s) nueva(s).`,
          );
        }
      }
    } catch {
      // Silenciar fallo transitorio durante polling
    }
  }, 800);
}

// =========================================================
// ACCIONES DE USUARIO
// =========================================================
async function triggerCheck(clientId) {
  loadingBanner.hidden = false;
  loadingBannerDetail.textContent = clientId
    ? 'Iniciando navegador oculto en segundo plano para el cliente seleccionado...'
    : 'Iniciando navegador oculto en segundo plano para revisar todos los buzones...';
  monitorPill.classList.add('is-running');
  monitorPillText.textContent = 'Cargando...';
  btnCheckAll.disabled = true;
  btnCheckAll.textContent = 'Cargando...';
  if (state.dashboard?.clients) {
    renderClients(state.dashboard.clients, true);
  }

  try {
    const payload = clientId ? { clientId } : {};
    const res = await apiJson('/api/check', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    showToast(res.message);
    renderMonitorStatus(res.monitorState);
    if (state.dashboard?.clients) {
      renderClients(state.dashboard.clients, true);
    }
    startStatusPolling();
  } catch (err) {
    showToast(err.message, true);
    try {
      const currentStatus = await apiJson('/api/status');
      renderMonitorStatus(currentStatus.monitorState);
      if (currentStatus.monitorState?.isRunning) {
        startStatusPolling();
      } else if (state.dashboard?.clients) {
        renderClients(state.dashboard.clients, false);
      }
    } catch {
      renderMonitorStatus({ isRunning: false });
      if (state.dashboard?.clients) {
        renderClients(state.dashboard.clients, false);
      }
    }
  }
}

async function markNotificationAsReadInSunat(item, buttonEl = null, rowEl = null, tdStatusEl = null) {
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.classList.add('is-loading');
  }

  loadingBanner.hidden = false;
  loadingBannerDetail.textContent = `Iniciando navegador oculto para marcar como leída en SUNAT: "${item.subject || 'notificación'}"...`;
  monitorPill.classList.add('is-running');
  monitorPillText.textContent = 'Marcando en SUNAT...';

  try {
    const res = await apiJson(`/api/notifications/${item.id}/mark-read-sunat`, {
      method: 'POST',
      body: '{}',
    });

    item.isNewAlert = false;
    item.readStatusSunat = 'Leído';

    // Actualizar badge inmediatamente
    if (tdStatusEl) {
      tdStatusEl.replaceChildren(el('span', 'badge badge-ok', 'Leída'));
      if (URGENT_PATTERN.test(item.subject)) {
        tdStatusEl.append(el('span', 'badge badge-urgent', 'Importante'));
      }
    }

    // Quitar el botón check para que no vuelva a aparecer
    if (buttonEl) {
      buttonEl.remove();
    }

    showToast(res.message || 'Notificación marcada como leída en SUNAT.');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, true);
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.classList.remove('is-loading');
    }
  } finally {
    loadingBanner.hidden = true;
    monitorPill.classList.remove('is-running');
    monitorPillText.textContent = 'En espera';
  }
}

async function acknowledgeNotification(id) {
  try {
    await apiJson(`/api/notifications/${id}/ack`, { method: 'POST', body: '{}' });
    showToast('Notificación marcada como revisada.');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function acknowledgeAll() {
  const clientId = filterClient.value ? Number.parseInt(filterClient.value, 10) : undefined;
  btnAckAll.disabled = true;
  btnAckAll.textContent = 'Marcando en SUNAT...';

  loadingBanner.hidden = false;
  loadingBannerDetail.textContent =
    'Iniciando navegador oculto para marcar todas las notificaciones pendientes como leídas en SUNAT...';
  monitorPill.classList.add('is-running');
  monitorPillText.textContent = 'Marcando en SUNAT...';

  try {
    const res = await apiJson('/api/notifications/ack-all', {
      method: 'POST',
      body: JSON.stringify(clientId ? { clientId } : {}),
    });
    showToast(res.message || 'Marcado masivo en SUNAT iniciado.');
    if (res.monitorState) {
      renderMonitorStatus(res.monitorState);
    }
    startStatusPolling();
  } catch (err) {
    showToast(err.message, true);
    loadingBanner.hidden = true;
    monitorPill.classList.remove('is-running');
    monitorPillText.textContent = 'En espera';
    btnAckAll.disabled = false;
    btnAckAll.textContent = 'Marcar todas como leídas en SUNAT';
  }
}

async function toggleClient(id) {
  try {
    const res = await apiJson(`/api/clients/${id}/toggle`, { method: 'POST', body: '{}' });
    showToast(res.active ? 'Cliente activado para monitoreo.' : 'Cliente pausado.');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, true);
  }
}

function requestDeleteClient(client) {
  state.pendingDeleteClient = client;
  confirmDeleteDesc.textContent = `Se eliminará "${client.label}" (${client.loginMode}: ${client.docNumber}) y todo su historial de notificaciones guardadas.`;
  confirmDeleteDialog.showModal();
}

confirmDeleteDialog.addEventListener('close', async () => {
  const action = confirmDeleteDialog.returnValue;
  confirmDeleteDialog.returnValue = '';

  const client = state.pendingDeleteClient;
  state.pendingDeleteClient = null;

  if (action !== 'delete' || !client) return;

  try {
    await apiJson(`/api/clients/${client.id}`, { method: 'DELETE' });
    showToast(`Cliente "${client.label}" eliminado.`);
    await loadDashboard();
  } catch (err) {
    showToast(err.message, true);
  }
});

// =========================================================
// MODAL DETALLE DE NOTIFICACIÓN
// =========================================================
function openNotificationDetail(item) {
  state.activeDetailNotificationId = item.id;
  detailBody.replaceChildren();

  const fields = [
    ['Cliente', `${item.clientLabel} (${item.docNumber})`],
    ['Buzón de origen', item.mailboxSource === 'MENSAJES' ? 'Buzón Mensajes' : 'Buzón Notificaciones'],
    ['Fecha SUNAT', item.publishedAt || 'Sin fecha'],
    ['Código / Referencia', item.sunatCode || '—'],
    ['Tipo / Categoría', item.notificationType || '—'],
    ['Asunto', item.subject],
    ['Remitente / Dependencia', item.sender || '—'],
    ['Estado en SUNAT', item.readStatusSunat || '—'],
    ['Detectada por el monitor', formatLocalTimestamp(item.firstSeenAt)],
  ];

  for (const [label, val] of fields) {
    const box = el('div', 'detail-item');
    box.append(el('span', 'detail-item-label', label));
    box.append(el('span', 'detail-item-value', val));
    detailBody.append(box);
  }

  const rawEntries = Object.entries(item.rawRow || {});
  if (rawEntries.length > 0) {
    const box = el('div', 'detail-item');
    box.append(el('span', 'detail-item-label', 'Columnas extraídas del portal'));
    for (const [col, val] of rawEntries) {
      box.append(el('span', 'detail-item-value', `${col}: ${val}`));
    }
    detailBody.append(box);
  }

  // Archivo Adjunto / Constancia SUNAT
  const attachBox = el('div', 'detail-item detail-item-attachment');
  attachBox.append(el('span', 'detail-item-label', 'Archivo Adjunto / Constancia SUNAT'));

  if (item.attachmentPath) {
    const attachWrap = el('div', 'attach-actions');
    const btnView = el('a', 'btn btn-primary btn-sm', `📄 Abrir / Descargar (${item.attachmentName || 'PDF'})`);
    btnView.href = `/api/notifications/${item.id}/attachment`;
    btnView.target = '_blank';
    btnView.rel = 'noopener noreferrer';
    attachWrap.append(btnView);
    attachBox.append(attachWrap);
  } else {
    const attachWrap = el('div', 'attach-actions');
    const btnDownload = el('button', 'btn btn-secondary btn-sm', '📥 Descargar Adjunto de SUNAT (PDF)');
    btnDownload.type = 'button';
    btnDownload.addEventListener('click', async () => {
      btnDownload.disabled = true;
      btnDownload.textContent = '⏳ Extrayendo adjunto de SUNAT en segundo plano...';
      try {
        const res = await apiJson(`/api/notifications/${item.id}/download-attachment`, {
          method: 'POST',
          body: '{}',
        });
        showToast(res.message || 'Adjunto descargado correctamente.');
        item.attachmentPath = res.url;
        item.attachmentName = res.filename;
        openNotificationDetail(item);
        await loadDashboard();
      } catch (err) {
        showToast(err.message, true);
        btnDownload.disabled = false;
        btnDownload.textContent = '📥 Descargar Adjunto de SUNAT (PDF)';
      }
    });
    attachWrap.append(btnDownload);
    attachBox.append(attachWrap);
  }
  detailBody.append(attachBox);

  btnDetailAck.hidden = !item.isNewAlert && item.readStatusSunat === 'Leído';
  detailDialog.showModal();
}

btnCloseDetailDialog.addEventListener('click', () => detailDialog.close());
btnDetailAck.addEventListener('click', async () => {
  if (!state.activeDetailNotificationId) return;
  const notif = state.dashboard?.notifications?.find(
    (n) => n.id === state.activeDetailNotificationId,
  );
  detailDialog.close();
  if (notif) {
    await markNotificationAsReadInSunat(notif);
  } else {
    await acknowledgeNotification(state.activeDetailNotificationId);
  }
});

// =========================================================
// MODAL ALTA / ACTUALIZACIÓN DE CLIENTE
// =========================================================
const clientFormValidator = initFormAccessibility(clientForm);

function syncLoginModeFields() {
  const isRuc = modeRucRadio.checked;
  if (isRuc) {
    clientDocLabel.textContent = 'Número de RUC ';
    const star = el('span', '', '*');
    star.setAttribute('aria-hidden', 'true');
    clientDocLabel.append(star);

    docHint.textContent = 'Exactamente 11 dígitos numéricos.';
    docErrorText.textContent = 'El RUC debe tener exactamente 11 dígitos numéricos.';
    clientDocInput.pattern = '\\d{11}';
    clientDocInput.maxLength = 11;

    solUserGroup.hidden = false;
    clientUserInput.required = true;
  } else {
    clientDocLabel.textContent = 'Número de DNI ';
    const star = el('span', '', '*');
    star.setAttribute('aria-hidden', 'true');
    clientDocLabel.append(star);

    docHint.textContent = 'Exactamente 8 dígitos numéricos.';
    docErrorText.textContent = 'El DNI debe tener exactamente 8 dígitos numéricos.';
    clientDocInput.pattern = '\\d{8}';
    clientDocInput.maxLength = 8;

    solUserGroup.hidden = true;
    clientUserInput.required = false;
    clientUserInput.value = '';
  }
}

modeRucRadio.addEventListener('change', syncLoginModeFields);
modeDniRadio.addEventListener('change', syncLoginModeFields);

toggleSolPasswordBtn.addEventListener('click', () => {
  const show = clientPasswordInput.type === 'password';
  clientPasswordInput.type = show ? 'text' : 'password';
  toggleSolPasswordBtn.setAttribute('aria-pressed', String(show));
  toggleSolPasswordBtn.textContent = show ? 'Ocultar' : 'Mostrar';
});

function openClientModal(existingClient = null) {
  clientForm.reset();
  clientFormServerError.hidden = true;
  clientFormServerError.textContent = '';
  clientPasswordInput.type = 'password';
  toggleSolPasswordBtn.setAttribute('aria-pressed', 'false');
  toggleSolPasswordBtn.textContent = 'Mostrar';

  if (existingClient) {
    clientDialogTitle.textContent = `Actualizar credenciales: ${existingClient.label}`;
    modeRucRadio.checked = existingClient.loginMode === 'RUC';
    modeDniRadio.checked = existingClient.loginMode === 'DNI';
    syncLoginModeFields();
    clientLabelInput.value = existingClient.label;
    clientDocInput.value = existingClient.docNumber;
    clientDialog.showModal();
    (existingClient.loginMode === 'RUC' ? clientUserInput : clientPasswordInput).focus();
  } else {
    clientDialogTitle.textContent = 'Registrar cliente SUNAT';
    modeRucRadio.checked = true;
    syncLoginModeFields();
    clientDialog.showModal();
    clientLabelInput.focus();
  }
}

btnOpenAddClient.addEventListener('click', () => openClientModal());
btnEmptyAddClient.addEventListener('click', () => openClientModal());
btnClientsAdd.addEventListener('click', () => openClientModal());
btnClientsEmptyAdd.addEventListener('click', () => openClientModal());
btnCloseClientDialog.addEventListener('click', () => clientDialog.close());
btnCancelClient.addEventListener('click', () => clientDialog.close());

clientForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clientFormServerError.hidden = true;

  if (!clientForm.checkValidity()) {
    clientFormValidator.syncAll();
    const firstInvalid = clientForm.querySelector(':invalid');
    firstInvalid?.focus();
    return;
  }

  btnSaveClient.disabled = true;
  btnSaveClient.textContent = 'Guardando...';

  try {
    const payload = {
      label: clientLabelInput.value.trim(),
      loginMode: modeDniRadio.checked ? 'DNI' : 'RUC',
      docNumber: clientDocInput.value.trim(),
      solUser: modeRucRadio.checked ? clientUserInput.value.trim().toUpperCase() : '',
      solPassword: clientPasswordInput.value,
    };

    const res = await apiJson('/api/clients', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    clientDialog.close();
    showToast(res.message);
    await loadDashboard();
  } catch (err) {
    clientFormServerError.textContent = err.message;
    clientFormServerError.hidden = false;
  } finally {
    btnSaveClient.disabled = false;
    btnSaveClient.textContent = 'Guardar cliente cifrado';
  }
});

// =========================================================
// EVENTOS GLOBALES
// =========================================================
btnCheckAll.addEventListener('click', () => triggerCheck());
btnAckAll.addEventListener('click', acknowledgeAll);

filterForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void loadDashboard();
});

filterMailbox.addEventListener('change', () => {
  void loadDashboard();
});

initTabs();
syncLoginModeFields();
loadDashboard().catch((err) => {
  showToast(`No se pudo cargar el panel: ${err.message}`, true);
});

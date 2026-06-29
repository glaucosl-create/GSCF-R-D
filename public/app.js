const state = {
  user: null,
  cards: [],
  transactions: [],
  categories: [],
  invoices: [],
  adminUsers: [],
  salesOrders: [],
  invoiceDraft: null
};

const $ = (id) => document.getElementById(id);
const money = (value) => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().toISOString().slice(0, 7);
let invoiceProgressTimer = null;
let selectedDashboardMonth = currentMonth();
let selectedTransactionMonth = 'all';
let selectedTransactionCategory = 'all';
let transactionPage = 1;
const TRANSACTION_PAGE_SIZE = 15;
const THEME_KEY = 'cfdr-theme';
const APP_SESSION_KEY = 'cfdr-active-session';

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: 'no-store',
    headers: options.body instanceof FormData ? options.headers : { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Erro na operacao.');
  return data;
}

async function runAction(action) {
  try {
    return await action();
  } catch (error) {
    toast(error.message);
    return null;
  }
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2600);
}

function applyTheme(theme) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  localStorage.setItem(THEME_KEY, selected);
  $('themeSelect').value = selected;
}

function setInvoiceProcessing(active, message = 'Enviando o PDF para leitura local.') {
  const panel = $('invoiceProgress');
  const button = $('invoiceReadBtn');
  const form = $('invoiceForm');
  panel.classList.toggle('hidden', !active);
  button.disabled = active;
  form.classList.toggle('is-processing', active);
  Array.from(form.elements).forEach(element => {
    if (element !== button) element.disabled = active;
  });

  if (!active) {
    clearInterval(invoiceProgressTimer);
    invoiceProgressTimer = null;
    button.textContent = 'Ler PDF';
    $('invoiceProgressElapsed').textContent = '0s';
    return;
  }

  const startedAt = Date.now();
  button.textContent = 'Lendo...';
  $('invoiceProgressTitle').textContent = 'Lendo fatura';
  $('invoiceProgressText').textContent = message;
  $('invoiceProgressElapsed').textContent = '0s';
  clearInterval(invoiceProgressTimer);
  invoiceProgressTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $('invoiceProgressElapsed').textContent = `${seconds}s`;
    if (seconds >= 8) $('invoiceProgressText').textContent = 'Extraindo texto da fatura. Se o PDF for imagem, o OCR pode levar ate 1 minuto.';
    if (seconds >= 25) $('invoiceProgressText').textContent = 'OCR em andamento. A pagina esta sendo lida localmente, aguarde a revisao dos itens.';
  }, 1000);
}

function showAuth() {
  $('authView').classList.remove('hidden');
  $('appView').classList.remove('hidden');
  $('appView').classList.add('locked');
  document.querySelectorAll('.admin-only').forEach(element => element.classList.add('hidden'));
}

function showApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('appView').classList.remove('locked');
  $('userEmail').textContent = state.user.email;
  document.querySelectorAll('.admin-only').forEach(element => element.classList.toggle('hidden', state.user.role !== 'admin'));
}

async function boot() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
  $('txDate').value = today();
  $('invoiceMonth').value = currentMonth();
  updateTransactionInstallmentHint();
  if (!sessionStorage.getItem(APP_SESSION_KEY)) {
    await fetch('/api/auth/logout', { method: 'POST', cache: 'no-store', keepalive: true }).catch(() => {});
    showAuth();
    return;
  }
  try {
    state.user = await api('/api/me');
    sessionStorage.setItem(APP_SESSION_KEY, '1');
    showApp();
    await refreshAll();
  } catch {
    sessionStorage.removeItem(APP_SESSION_KEY);
    showAuth();
  }
}

async function logout(message = 'Sessao encerrada.') {
  await runAction(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    sessionStorage.removeItem(APP_SESSION_KEY);
    state.user = null;
    showAuth();
    toast(message);
  });
}

async function refreshAll() {
  const [cards, transactions, categories, invoices, dashboard] = await Promise.all([
    api('/api/cards'),
    api('/api/transactions'),
    api('/api/categories'),
    api('/api/invoices'),
    api(`/api/dashboard?month=${encodeURIComponent(selectedDashboardMonth)}`)
  ]);
  state.cards = cards;
  state.transactions = transactions;
  state.categories = categories;
  state.invoices = invoices;
  renderCardOptions();
  renderCategories();
  renderCategoryManager();
  renderTransactions();
  renderCards();
  renderInvoices();
  renderDashboard(dashboard);
  if (state.user?.role === 'admin') await refreshAdmin();
  updateLastRefresh();
}

async function refreshAdmin() {
  const [users, sales] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/sales')
  ]);
  state.adminUsers = users;
  state.salesOrders = sales;
  renderAdmin();
}

function updateLastRefresh() {
  const now = new Date();
  $('lastRefreshText').textContent = `Atualizado as ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

async function refreshFromButton() {
  const button = $('refreshBtn');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Atualizando...';
  await runAction(async () => {
    await refreshAll();
    toast('Dashboard atualizado.');
  });
  button.disabled = false;
  button.textContent = originalText;
}

function renderCardOptions() {
  const options = ['<option value="">Sem cartao</option>'].concat(state.cards.map(card => `<option value="${card.id}">${escapeHtml(card.name)}</option>`)).join('');
  $('txCard').innerHTML = options;
  $('invoiceCard').innerHTML = state.cards.length
    ? state.cards.map(card => `<option value="${card.id}">${escapeHtml(card.name)}</option>`).join('')
    : '<option value="">Cadastre um cartao</option>';
}

function renderCategories(selectedValue = $('txCategory')?.value || '') {
  const type = $('txType')?.value || 'expense';
  const categories = state.categories.filter(category => category.type === type);
  const current = selectedValue;
  const options = categories.map(category => category.name);
  if (current && !options.includes(current)) options.push(current);
  $('txCategory').innerHTML = options.length
    ? options.map(name => `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('')
    : '<option value="">Cadastre uma categoria</option>';
  if (current && options.includes(current)) $('txCategory').value = current;
}

function updateTransactionInstallmentHint() {
  const installments = Number($('txInstallments')?.value || 1);
  $('txAmount').placeholder = installments > 1 ? 'Valor da parcela' : 'Valor';
  $('txAmount').title = installments > 1 ? 'Informe o valor de cada parcela mensal.' : '';
}

function expenseCategoryOptions(selected) {
  const names = state.categories
    .filter(category => category.type === 'expense')
    .map(category => category.name);
  if (selected && !names.includes(selected)) names.push(selected);
  return names.map(name => `<option value="${escapeAttr(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

function renderCategoryManager() {
  const renderList = (type) => {
    const rows = state.categories.filter(category => category.type === type);
    return rows.length ? rows.map(category => `
      <article class="card compact-card">
        <div>
          <strong>${escapeHtml(category.name)}</strong>
          <p>${type === 'income' ? 'Receita' : 'Despesa'}</p>
        </div>
        <div class="actions">
          <button class="secondary" data-edit-category="${category.id}">Editar</button>
          <button class="danger" data-del-category="${category.id}">Excluir</button>
        </div>
      </article>
    `).join('') : '<p class="empty">Nenhuma categoria cadastrada.</p>';
  };
  $('expenseCategoriesList').innerHTML = renderList('expense');
  $('incomeCategoriesList').innerHTML = renderList('income');
}

function renderDashboard(data) {
  selectedDashboardMonth = data.selectedMonth || selectedDashboardMonth;
  renderDashboardMonthOptions(data.months, selectedDashboardMonth);
  $('incomeMetric').textContent = money(data.incomeMonth);
  $('expenseMetric').textContent = money(data.expenseMonth);
  $('balanceMetric').textContent = money(data.balanceMonth);
  renderBars('categoryBars', data.categories, 'name', 'amount');
  renderBars('forecastBars', data.forecast, 'month', 'forecast_card', true);
  renderMonthBars(data.months);
}

function renderDashboardMonthOptions(months, selectedMonth) {
  const knownMonths = months.map(row => row.month);
  if (!knownMonths.includes(selectedMonth)) knownMonths.push(selectedMonth);
  knownMonths.sort((a, b) => b.localeCompare(a));
  $('dashboardMonth').innerHTML = knownMonths.map(month => `<option value="${month}" ${month === selectedMonth ? 'selected' : ''}>${month}</option>`).join('');
}

function renderBars(target, rows, labelKey, valueKey, alt = false) {
  const max = Math.max(1, ...rows.map(row => row[valueKey]));
  $(target).innerHTML = rows.length ? rows.map(row => `
    <div class="bar-row">
      <span>${escapeHtml(row[labelKey])}</span>
      <div class="bar-track"><div class="bar-fill ${alt ? 'alt' : ''}" style="width:${Math.max(4, row[valueKey] / max * 100)}%"></div></div>
      <strong>${money(row[valueKey])}</strong>
    </div>
  `).join('') : '<p class="empty">Sem dados para exibir.</p>';
}

function renderMonthBars(rows) {
  const max = Math.max(1, ...rows.flatMap(row => [row.income, row.expense]));
  $('monthBars').innerHTML = rows.length ? rows.map(row => `
    <div class="bar-row">
      <span>${row.month}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, row.income / max * 100)}%"></div></div>
      <strong>${money(row.income)}</strong>
      <span></span>
      <div class="bar-track"><div class="bar-fill alt" style="width:${Math.max(3, row.expense / max * 100)}%"></div></div>
      <strong>${money(row.expense)}</strong>
    </div>
  `).join('') : '<p class="empty">Sem dados para exibir.</p>';
}

function renderTransactions() {
  renderTransactionFilters();
  const typeFilter = $('transactionTypeFilter').value;
  const monthFilter = $('transactionMonthFilter').value;
  const categoryFilter = $('transactionCategoryFilter').value;
  const projectionFilter = $('transactionProjectionFilter').value;
  const sort = $('transactionSort').value;
  const filteredRows = state.transactions
    .filter(tx => typeFilter === 'all' || tx.type === typeFilter)
    .filter(tx => monthFilter === 'all' || tx.date.slice(0, 7) === monthFilter)
    .filter(tx => categoryFilter === 'all' || transactionCategoryKey(tx) === categoryFilter)
    .filter(tx => {
      if (projectionFilter === 'planned') return isPlannedInstallment(tx);
      if (projectionFilter === 'future') return isPlannedInstallment(tx) && tx.date >= today();
      return true;
    })
    .sort((a, b) => {
      const direction = sort === 'asc' ? 1 : -1;
      return direction * (a.date.localeCompare(b.date) || a.id - b.id);
    });
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / TRANSACTION_PAGE_SIZE));
  transactionPage = Math.min(Math.max(1, transactionPage), totalPages);
  const start = (transactionPage - 1) * TRANSACTION_PAGE_SIZE;
  const rows = filteredRows.slice(start, start + TRANSACTION_PAGE_SIZE);

  $('transactionsTable').innerHTML = rows.length ? rows.map(tx => `
    <tr>
      <td>${tx.date}</td>
      <td>${escapeHtml(tx.description)} ${tx.installment_total > 1 ? `<small>${tx.installment_index}/${tx.installment_total}</small>` : ''}</td>
      <td>${escapeHtml(tx.category)}</td>
      <td>${tx.type === 'income' ? '+' : '-'} ${money(tx.amount)}</td>
      <td>${labelMethod(tx.payment_method)}${tx.card_name ? ` - ${escapeHtml(tx.card_name)}` : ''}</td>
      <td>
        <button class="secondary" data-edit-tx="${tx.id}">Editar</button>
        <button class="danger" data-del-tx="${tx.id}">Excluir</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="6">Nenhum lancamento encontrado para os filtros selecionados.</td></tr>';
  renderTransactionPagination(filteredRows.length, start, rows.length, totalPages);
}

function renderTransactionFilters() {
  const current = selectedTransactionMonth;
  const months = Array.from(new Set(state.transactions.map(tx => tx.date.slice(0, 7)))).sort((a, b) => b.localeCompare(a));
  $('transactionMonthFilter').innerHTML = [
    '<option value="all">Todos os meses</option>',
    ...months.map(month => `<option value="${month}">${month}</option>`)
  ].join('');
  $('transactionMonthFilter').value = months.includes(current) ? current : 'all';
  selectedTransactionMonth = $('transactionMonthFilter').value;

  const currentCategory = selectedTransactionCategory;
  const typeFilter = $('transactionTypeFilter').value;
  const categories = state.categories
    .filter(category => typeFilter === 'all' || category.type === typeFilter)
    .map(category => ({ key: `${category.type}::${category.name}`, label: `${category.type === 'income' ? 'Receita' : 'Despesa'} - ${category.name}` }));
  const existingKeys = new Set(categories.map(category => category.key));
  for (const tx of state.transactions) {
    if (typeFilter !== 'all' && tx.type !== typeFilter) continue;
    const key = transactionCategoryKey(tx);
    if (!existingKeys.has(key)) {
      categories.push({ key, label: `${tx.type === 'income' ? 'Receita' : 'Despesa'} - ${tx.category}` });
      existingKeys.add(key);
    }
  }
  categories.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  $('transactionCategoryFilter').innerHTML = [
    '<option value="all">Todas as categorias</option>',
    ...categories.map(category => `<option value="${escapeAttr(category.key)}">${escapeHtml(category.label)}</option>`)
  ].join('');
  $('transactionCategoryFilter').value = existingKeys.has(currentCategory) ? currentCategory : 'all';
  selectedTransactionCategory = $('transactionCategoryFilter').value;
}

function renderTransactionPagination(totalRows, start, pageRows, totalPages) {
  const from = totalRows ? start + 1 : 0;
  const to = start + pageRows;
  $('transactionPageInfo').textContent = totalRows
    ? `${from}-${to} de ${totalRows} lancamentos | pagina ${transactionPage} de ${totalPages}`
    : '0 lancamentos';
  $('transactionPrevPage').disabled = transactionPage <= 1;
  $('transactionNextPage').disabled = transactionPage >= totalPages;
}

function transactionCategoryKey(tx) {
  return `${tx.type}::${tx.category}`;
}

function isPlannedInstallment(tx) {
  return Number(tx.installment_total || 1) > 1;
}

function renderCards() {
  $('cardsList').innerHTML = state.cards.length ? state.cards.map(card => `
    <article class="card">
      <div>
        <strong>${escapeHtml(card.name)}</strong>
        <p>${escapeHtml(card.brand || 'Sem bandeira')} | Limite ${money(card.limit_amount)} | Fecha dia ${card.closing_day} | Vence dia ${card.due_day}</p>
      </div>
      <div class="actions">
        <button class="secondary" data-edit-card="${card.id}">Editar</button>
        <button class="danger" data-del-card="${card.id}">Excluir</button>
      </div>
    </article>
  `).join('') : '<section><p>Nenhum cartao cadastrado.</p></section>';
}

function renderInvoices() {
  $('invoiceList').innerHTML = state.invoices.length ? state.invoices.map(invoice => `
    <article class="card">
      <div>
        <strong>${escapeHtml(invoice.original_name)}</strong>
        <p>${invoice.month} | ${escapeHtml(invoice.card_name || 'Sem cartao')} | Total detectado ${money(invoice.total_amount)}</p>
      </div>
      <div class="actions">
        <button class="danger" data-del-invoice="${invoice.id}">Excluir</button>
      </div>
    </article>
  `).join('') : '<p>Nenhuma fatura importada.</p>';
}

function renderAdmin() {
  if (!$('adminUsersTable')) return;
  $('adminUsersTable').innerHTML = state.adminUsers.length ? state.adminUsers.map(user => `
    <tr>
      <td>
        <strong>${escapeHtml(user.email)}</strong>
        <small>${user.email_verified ? 'email confirmado' : 'email pendente'}</small>
      </td>
      <td>
        <select data-admin-status="${user.id}">
          <option value="active" ${user.account_status === 'active' ? 'selected' : ''}>Ativo</option>
          <option value="pending_payment" ${user.account_status === 'pending_payment' ? 'selected' : ''}>Aguardando pagamento</option>
          <option value="blocked" ${user.account_status === 'blocked' ? 'selected' : ''}>Bloqueado</option>
        </select>
      </td>
      <td><input type="date" value="${user.paid_until || ''}" data-admin-paid="${user.id}"></td>
      <td>
        <select data-admin-role="${user.id}">
          <option value="user" ${user.role === 'user' ? 'selected' : ''}>Usuario</option>
          <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
      </td>
      <td><button class="secondary" data-save-access="${user.id}">Salvar acesso</button></td>
    </tr>
  `).join('') : '<tr><td colspan="5">Nenhum usuario encontrado.</td></tr>';

  $('salesList').innerHTML = state.salesOrders.length ? state.salesOrders.map(order => `
    <article class="card compact-card">
      <div>
        <strong>${escapeHtml(order.buyer_email || order.external_order_id || 'Venda recebida')}</strong>
        <p>${escapeHtml(order.provider)} | ${escapeHtml(order.status)} | ${money(order.amount)} | ${order.created_at}</p>
      </div>
    </article>
  `).join('') : '<p class="empty">Nenhuma venda recebida ainda.</p>';
}

function renderInvoiceDraft() {
  const rows = state.invoiceDraft?.rows || [];
  $('invoiceReview').classList.toggle('hidden', !state.invoiceDraft);
  $('invoiceRows').innerHTML = rows.map((row, index) => `
    <div class="review-row invoice-review-row" data-row="${index}">
      <input type="date" value="${row.date}" data-invoice-field="date">
      <input value="${escapeAttr(row.description)}" data-invoice-field="description">
      <select data-invoice-field="category">${expenseCategoryOptions(row.category)}</select>
      <input type="number" step="0.01" min="0" value="${row.amount}" data-invoice-field="amount">
      <input type="number" min="1" max="120" value="${row.installment_index || 1}" title="Parcela atual" data-invoice-field="installment_index">
      <input type="number" min="1" max="120" value="${row.installment_total || 1}" title="Total de parcelas" data-invoice-field="installment_total">
      <button class="danger" data-remove-invoice-row="${index}">X</button>
    </div>
  `).join('');
}

function labelMethod(method) {
  return ({ cash: 'Dinheiro/Pix', bank: 'Conta bancaria', debit_card: 'Debito', credit_card: 'Cartao' })[method] || method;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function readTxForm() {
  const id = $('transactionId').value;
  const original = id ? state.transactions.find(item => item.id === Number(id)) : null;
  return {
    type: $('txType').value,
    date: $('txDate').value,
    description: $('txDescription').value,
    category: $('txCategory').value,
    amount: Number($('txAmount').value),
    payment_method: $('txMethod').value,
    card_id: $('txCard').value || null,
    installments: Number($('txInstallments').value || 1),
    invoice_id: original?.invoice_id || null,
    installment_group: original?.installment_group || null,
    installment_index: original?.installment_index || 1,
    installment_total: original?.installment_total || Number($('txInstallments').value || 1),
    notes: $('txNotes').value
  };
}

function setTransactionEditing(tx) {
  $('transactionEditStatus').classList.remove('hidden');
  $('transactionEditText').textContent = `${tx.date} - ${tx.description} - ${money(tx.amount)}`;
  $('saveTxBtn').textContent = 'Salvar alteracoes';
  $('clearTxBtn').textContent = 'Cancelar';
  $('transactionForm').classList.add('editing');
  $('transactionForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('txDescription').focus(), 250);
  toast('Lancamento aberto para edicao no formulario acima.');
}

function clearTxForm() {
  $('transactionId').value = '';
  $('transactionForm').reset();
  $('txDate').value = today();
  $('txInstallments').value = 1;
  updateTransactionInstallmentHint();
  $('transactionEditStatus').classList.add('hidden');
  $('saveTxBtn').textContent = 'Salvar lancamento';
  $('clearTxBtn').textContent = 'Limpar';
  $('transactionForm').classList.remove('editing');
  renderCategories();
}

function clearCardForm() {
  $('cardId').value = '';
  $('cardForm').reset();
  $('cardActive').checked = true;
}

function clearCategoryForm() {
  $('categoryId').value = '';
  $('categoryForm').reset();
  $('categoryType').value = 'expense';
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('.nav');
  if (nav) {
    document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button === nav));
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === nav.dataset.view));
    $('viewTitle').textContent = nav.textContent;
  }

  const txEdit = event.target.dataset.editTx;
  if (txEdit) {
    const tx = state.transactions.find(item => item.id === Number(txEdit));
    if (!tx) return;
    $('transactionId').value = tx.id;
    $('txType').value = tx.type;
    renderCategories(tx.category);
    $('txDate').value = tx.date;
    $('txDescription').value = tx.description;
    $('txCategory').value = tx.category;
    $('txAmount').value = tx.amount;
    $('txMethod').value = tx.payment_method;
    $('txCard').value = tx.card_id || '';
    $('txInstallments').value = tx.installment_total || 1;
    updateTransactionInstallmentHint();
    $('txNotes').value = tx.notes || '';
    setTransactionEditing(tx);
  }

  const txDelete = event.target.dataset.delTx;
  if (txDelete && confirm('Excluir este lancamento?')) {
    await runAction(async () => {
      await api(`/api/transactions/${txDelete}`, { method: 'DELETE' });
      await refreshAll();
      toast('Lancamento excluido.');
    });
  }

  const categoryEdit = event.target.dataset.editCategory;
  if (categoryEdit) {
    const category = state.categories.find(item => item.id === Number(categoryEdit));
    $('categoryId').value = category.id;
    $('categoryName').value = category.name;
    $('categoryType').value = category.type;
  }

  const categoryDelete = event.target.dataset.delCategory;
  if (categoryDelete && confirm('Excluir esta categoria? Lancamentos existentes continuarao com o nome atual.')) {
    await runAction(async () => {
      await api(`/api/categories/${categoryDelete}`, { method: 'DELETE' });
      await refreshAll();
      toast('Categoria excluida.');
    });
  }

  const cardEdit = event.target.dataset.editCard;
  if (cardEdit) {
    const card = state.cards.find(item => item.id === Number(cardEdit));
    $('cardId').value = card.id;
    $('cardName').value = card.name;
    $('cardBrand').value = card.brand || '';
    $('cardLimit').value = card.limit_amount || 0;
    $('cardClosing').value = card.closing_day || 1;
    $('cardDue').value = card.due_day || 10;
    $('cardActive').checked = Boolean(card.active);
  }

  const cardDelete = event.target.dataset.delCard;
  if (cardDelete && confirm('Excluir este cartao? Lancamentos existentes ficarao sem cartao.')) {
    await runAction(async () => {
      await api(`/api/cards/${cardDelete}`, { method: 'DELETE' });
      await refreshAll();
      toast('Cartao excluido.');
    });
  }

  const invoiceDelete = event.target.dataset.delInvoice;
  if (invoiceDelete && confirm('Excluir esta fatura? Os lancamentos importados dela e as parcelas futuras previstas tambem serao excluidos.')) {
    await runAction(async () => {
      const result = await api(`/api/invoices/${invoiceDelete}`, { method: 'DELETE' });
      await refreshAll();
      toast(`Fatura excluida. ${result.deleted_transactions || 0} lancamentos removidos.`);
    });
  }

  const saveAccess = event.target.dataset.saveAccess;
  if (saveAccess) {
    await runAction(async () => {
      const body = {
        account_status: document.querySelector(`[data-admin-status="${saveAccess}"]`).value,
        paid_until: document.querySelector(`[data-admin-paid="${saveAccess}"]`).value || null,
        role: document.querySelector(`[data-admin-role="${saveAccess}"]`).value
      };
      await api(`/api/admin/users/${saveAccess}/access`, { method: 'PUT', body: JSON.stringify(body) });
      await refreshAdmin();
      toast('Acesso atualizado.');
    });
  }

  const removeInvoiceRow = event.target.dataset.removeInvoiceRow;
  if (removeInvoiceRow) {
    state.invoiceDraft.rows.splice(Number(removeInvoiceRow), 1);
    renderInvoiceDraft();
  }
});

$('authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await runAction(async () => {
    state.user = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
    sessionStorage.setItem(APP_SESSION_KEY, '1');
    showApp();
    await refreshAll();
  });
});

$('registerBtn').addEventListener('click', async () => {
  if (!$('authForm').reportValidity()) return;
  await runAction(async () => {
    const credentials = { email: $('email').value, password: $('password').value };
    const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(credentials) });
    $('verificationNotice').classList.remove('hidden');
    $('verificationNotice').innerHTML = result.emailSent
      ? 'Conta criada. Verifique seu email para confirmar o cadastro antes de entrar.'
      : `Conta criada. Ambiente local sem SMTP configurado. Confirme pelo link: <a href="${result.verificationLink}">verificar email</a>`;
    toast('Confirme seu email para ativar a conta.');
  });
});

$('logoutBtn').addEventListener('click', () => logout());
$('logoutTopBtn').addEventListener('click', () => logout());

$('refreshBtn').addEventListener('click', refreshFromButton);
$('refreshAdminBtn').addEventListener('click', () => runAction(refreshAdmin));
$('themeSelect').addEventListener('change', () => applyTheme($('themeSelect').value));
$('dashboardMonth').addEventListener('change', async () => {
  selectedDashboardMonth = $('dashboardMonth').value;
  await refreshFromButton();
});
$('clearTxBtn').addEventListener('click', clearTxForm);
$('cancelTxEditBtn').addEventListener('click', clearTxForm);
$('clearCardBtn').addEventListener('click', clearCardForm);
$('clearCategoryBtn').addEventListener('click', clearCategoryForm);
$('txType').addEventListener('change', renderCategories);
$('txInstallments').addEventListener('input', updateTransactionInstallmentHint);
$('txInstallments').addEventListener('change', updateTransactionInstallmentHint);
$('transactionTypeFilter').addEventListener('change', () => {
  transactionPage = 1;
  selectedTransactionCategory = 'all';
  renderTransactions();
});
$('transactionMonthFilter').addEventListener('change', () => {
  selectedTransactionMonth = $('transactionMonthFilter').value;
  transactionPage = 1;
  renderTransactions();
});
$('transactionCategoryFilter').addEventListener('change', () => {
  selectedTransactionCategory = $('transactionCategoryFilter').value;
  transactionPage = 1;
  renderTransactions();
});
$('transactionProjectionFilter').addEventListener('change', () => {
  transactionPage = 1;
  renderTransactions();
});
$('transactionSort').addEventListener('change', () => {
  transactionPage = 1;
  renderTransactions();
});
$('transactionPrevPage').addEventListener('click', () => {
  transactionPage = Math.max(1, transactionPage - 1);
  renderTransactions();
});
$('transactionNextPage').addEventListener('click', () => {
  transactionPage += 1;
  renderTransactions();
});

$('transactionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await runAction(async () => {
    const id = $('transactionId').value;
    const body = readTxForm();
    if (id) await api(`/api/transactions/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/transactions', { method: 'POST', body: JSON.stringify(body) });
    clearTxForm();
    await refreshAll();
    toast('Lancamento salvo.');
  });
});

$('cardForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await runAction(async () => {
    const body = {
      name: $('cardName').value,
      brand: $('cardBrand').value,
      limit_amount: Number($('cardLimit').value || 0),
      closing_day: Number($('cardClosing').value || 1),
      due_day: Number($('cardDue').value || 10),
      active: $('cardActive').checked
    };
    const id = $('cardId').value;
    if (id) await api(`/api/cards/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/cards', { method: 'POST', body: JSON.stringify(body) });
    clearCardForm();
    await refreshAll();
    toast('Cartao salvo.');
  });
});

$('categoryForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await runAction(async () => {
    const body = {
      name: $('categoryName').value,
      type: $('categoryType').value
    };
    const id = $('categoryId').value;
    if (id) await api(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/categories', { method: 'POST', body: JSON.stringify(body) });
    clearCategoryForm();
    await refreshAll();
    toast('Categoria salva.');
  });
});

$('passwordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await runAction(async () => {
    if ($('newPassword').value !== $('confirmPassword').value) throw new Error('A confirmacao da nova senha nao confere.');
    await api('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: $('currentPassword').value,
        newPassword: $('newPassword').value
      })
    });
    $('passwordForm').reset();
    toast('Senha alterada com sucesso.');
  });
});

$('invoiceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!$('invoicePdf').files.length) {
    toast('Selecione uma fatura em PDF.');
    return;
  }
  setInvoiceProcessing(true);
  try {
    await runAction(async () => {
      const form = new FormData();
      form.append('card_id', $('invoiceCard').value);
      form.append('month', $('invoiceMonth').value);
      form.append('pdf', $('invoicePdf').files[0]);
      const draft = await api('/api/invoices/upload', { method: 'POST', body: form });
      state.invoiceDraft = { ...draft, card_id: $('invoiceCard').value };
      renderInvoiceDraft();
      await refreshAll();
      toast(`${draft.rows.length} itens detectados no PDF.`);
    });
  } finally {
    setInvoiceProcessing(false);
  }
});

function updateInvoiceDraftField(event) {
  const rowEl = event.target.closest('[data-row]');
  if (!rowEl) return;
  const row = state.invoiceDraft.rows[Number(rowEl.dataset.row)];
  const numericFields = ['amount', 'installment_index', 'installment_total'];
  row[event.target.dataset.invoiceField] = numericFields.includes(event.target.dataset.invoiceField) ? Number(event.target.value) : event.target.value;
}

$('invoiceRows').addEventListener('input', updateInvoiceDraftField);
$('invoiceRows').addEventListener('change', updateInvoiceDraftField);

$('importInvoiceBtn').addEventListener('click', async () => {
  if (!state.invoiceDraft) return;
  await runAction(async () => {
    const result = await api('/api/invoices/import', { method: 'POST', body: JSON.stringify(state.invoiceDraft) });
    state.invoiceDraft = null;
    renderInvoiceDraft();
    await refreshAll();
    const updated = Number(result.updated || 0);
    const created = Number(result.created || 0);
    toast(updated ? `${created} lancamentos criados e ${updated} previsoes confirmadas.` : 'Lancamentos importados.');
  });
});

boot().catch(error => toast(error.message));

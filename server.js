import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { initDatabase } from './db.js';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const dataDir = join(__dirname, 'data');
const uploadDir = join(dataDir, 'uploads');
const publicDir = join(__dirname, 'public');
const bundledPython = process.env.PYTHON || (process.platform === 'win32'
  ? 'C:\\Users\\limag\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe'
  : 'python3');
mkdirSync(uploadDir, { recursive: true });

const database = await initDatabase({ dataDir });
const { statements, defaultCategories } = database;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(Buffer.from(hash, 'hex'), candidate);
}

function publicBaseUrl(req) {
  return process.env.APP_BASE_URL || `http://${req.headers.host || 'localhost:3060'}`;
}

function smtpTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendVerificationEmailWithApi(email, link) {
  if (!process.env.RESEND_API_KEY) return false;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'CF-RD <onboarding@resend.dev>',
      to: [email],
      subject: 'Confirme seu cadastro no CF-R&D',
      text: `Confirme seu cadastro acessando este link: ${link}`,
      html: `<p>Confirme seu cadastro no CF-R&amp;D acessando o link abaixo:</p><p><a href="${link}">${link}</a></p>`
    })
  });
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Falha ao enviar email pela API: ${response.status} ${details.slice(0, 200)}`);
  }
  return true;
}

async function sendVerificationEmail(email, link) {
  const apiSent = await sendVerificationEmailWithApi(email, link);
  if (apiSent) return true;
  const transport = smtpTransport();
  if (!transport) return false;
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Confirme seu cadastro no CF-R&D',
    text: `Confirme seu cadastro acessando este link: ${link}`,
    html: `<p>Confirme seu cadastro no CF-R&amp;D acessando o link abaixo:</p><p><a href="${link}">${link}</a></p>`
  });
  return true;
}

async function sendWhatsAppMessage(phone, message, templateData = {}) {
  if (process.env.NOTIFICATION_DELIVERY_ENABLED !== 'true') {
    return { sent: false, status: 'skipped', details: 'Envio de notificacoes desativado no servidor.' };
  }
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return { sent: false, status: 'skipped', details: 'WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID nao configurado.' };
  }

  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;
  const endpoint = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const body = templateName
    ? {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'pt_BR' },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: templateData.cardName || '' },
              { type: 'text', text: templateData.eventLabel || '' },
              { type: 'text', text: templateData.targetDate || '' },
              { type: 'text', text: templateData.daysText || '' }
            ]
          }]
        }
      }
    : {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { preview_url: false, body: message }
      };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const details = await response.text().catch(() => '');
  if (!response.ok) {
    return { sent: false, status: 'failed', details: `${response.status} ${details.slice(0, 300)}` };
  }
  return { sent: true, status: 'sent', details: details.slice(0, 300) };
}

async function sendSmsMessage(phone, message) {
  if (process.env.NOTIFICATION_DELIVERY_ENABLED !== 'true') {
    return { sent: false, status: 'skipped', details: 'Envio de notificacoes desativado no servidor.' };
  }
  const provider = String(process.env.SMS_PROVIDER || '').toLowerCase();
  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) return { sent: false, status: 'skipped', details: 'Twilio nao configurado.' };
    const body = new URLSearchParams({ To: `+${phone}`, From: from, Body: message });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body
    });
    const details = await response.text().catch(() => '');
    if (!response.ok) return { sent: false, status: 'failed', details: `${response.status} ${details.slice(0, 300)}` };
    return { sent: true, status: 'sent', details: details.slice(0, 300) };
  }
  if (provider === 'zenvia') {
    const token = process.env.ZENVIA_TOKEN;
    const from = process.env.ZENVIA_FROM || 'CF-RD';
    if (!token) return { sent: false, status: 'skipped', details: 'Zenvia nao configurado.' };
    const response = await fetch('https://api.zenvia.com/v2/channels/sms/messages', {
      method: 'POST',
      headers: {
        'x-api-token': token,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: phone,
        contents: [{ type: 'text', text: message }]
      })
    });
    const details = await response.text().catch(() => '');
    if (!response.ok) return { sent: false, status: 'failed', details: `${response.status} ${details.slice(0, 300)}` };
    return { sent: true, status: 'sent', details: details.slice(0, 300) };
  }
  return { sent: false, status: 'skipped', details: 'Provedor SMS nao selecionado.' };
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const [key, ...value] = part.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    pragma: 'no-cache',
    expires: '0'
  });
  res.end(body);
}

function setSessionCookie(res, token) {
  const attrs = ['HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (process.env.NODE_ENV === 'production' || String(process.env.APP_BASE_URL || '').startsWith('https://')) attrs.push('Secure');
  res.setHeader('set-cookie', `session=${encodeURIComponent(token)}; ${attrs.join('; ')}`);
}

function clearSessionCookie(res) {
  const attrs = ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production' || String(process.env.APP_BASE_URL || '').startsWith('https://')) attrs.push('Secure');
  res.setHeader('set-cookie', `session=; ${attrs.join('; ')}`);
}

async function readBody(req, limitBytes = MAX_JSON_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'Conteudo enviado excede o limite permitido.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON invalido.');
  }
}

async function currentUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const session = await statements.getSession.get(token);
  if (!session) return null;
  return await statements.getUserById.get(session.user_id);
}

function accessError(user) {
  if (!user) return 'Autenticacao necessaria.';
  if (user.role === 'admin') return '';
  if (user.account_status === 'blocked') return 'Sua conta esta bloqueada. Fale com o administrador.';
  if (user.account_status === 'pending_payment') return 'Cadastro confirmado. Acesso aguardando pagamento ou liberacao do administrador.';
  if (user.paid_until && user.paid_until < new Date().toISOString().slice(0, 10)) return 'Seu acesso venceu. Renove para continuar usando.';
  return '';
}

function requireUser(req, res) {
  return currentUser(req).then(user => {
    const error = accessError(user);
    if (error) {
      sendJson(res, user ? 403 : 401, { error });
      return null;
    }
    return user;
  });
}

function requireAdmin(user, res) {
  if (user.role !== 'admin') {
    sendJson(res, 403, { error: 'Acesso exclusivo do administrador.' });
    return false;
  }
  return true;
}

function sanitizeAccessBody(body, currentRole = 'user') {
  const validStatuses = new Set(['active', 'pending_payment', 'blocked']);
  const validRoles = new Set(['user', 'admin']);
  const accountStatus = validStatuses.has(body.account_status) ? body.account_status : 'active';
  const role = validRoles.has(body.role) ? body.role : currentRole;
  const paidUntil = body.paid_until ? String(body.paid_until).slice(0, 10) : null;
  return { accountStatus, paidUntil, role };
}

function orderFromWebhook(payload) {
  const externalId = String(payload.order_id || payload.id || payload.resource || payload.topic || randomBytes(8).toString('hex'));
  const buyer = payload.buyer || payload.payer || {};
  const total = payload.total_amount ?? payload.paid_amount ?? payload.amount ?? payload.transaction_amount ?? 0;
  return {
    externalId,
    buyerEmail: buyer.email || payload.buyer_email || payload.email || '',
    buyerName: buyer.nickname || buyer.name || payload.buyer_name || '',
    status: String(payload.status || payload.action || payload.topic || 'received'),
    amount: toNumber(total)
  };
}

async function ensureDefaultCategories(userId) {
  for (const [name, type] of defaultCategories) await statements.addCategory.run(userId, name, type);
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function sanitizeNotificationSettings(input) {
  return {
    whatsapp_phone: normalizePhone(input.whatsapp_phone),
    notify_whatsapp_enabled: input.notify_whatsapp_enabled ? 1 : 0,
    notify_sms_enabled: input.notify_sms_enabled ? 1 : 0,
    notify_closing_days: Math.max(0, Math.min(30, Number(input.notify_closing_days ?? 3))),
    notify_due_days: Math.max(0, Math.min(30, Number(input.notify_due_days ?? 3)))
  };
}

function localToday() {
  const timeZone = process.env.APP_TIMEZONE || 'America/Fortaleza';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date())
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseDateParts(dateText) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  return { year, month, day };
}

function dateUtc(dateText) {
  const { year, month, day } = parseDateParts(dateText);
  return Date.UTC(year, month - 1, day);
}

function daysBetween(startDate, endDate) {
  return Math.round((dateUtc(endDate) - dateUtc(startDate)) / 86400000);
}

function dateForDay(year, month, day) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const date = new Date(Date.UTC(year, month - 1, Math.min(Math.max(1, day), lastDay)));
  return date.toISOString().slice(0, 10);
}

function nextMonthlyDate(day, todayText) {
  const { year, month } = parseDateParts(todayText);
  const currentMonthDate = dateForDay(year, month, day);
  if (currentMonthDate >= todayText) return currentMonthDate;
  const next = new Date(Date.UTC(year, month, 1));
  return dateForDay(next.getUTCFullYear(), next.getUTCMonth() + 1, day);
}

function dateBR(dateText) {
  const { year, month, day } = parseDateParts(dateText);
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

function daysText(days) {
  if (days === 0) return 'hoje';
  if (days === 1) return 'amanha';
  return `em ${days} dias`;
}

function monthAdd(dateText, index) {
  const [year, month, day] = dateText.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month + index, 0)).getUTCDate();
  const date = new Date(Date.UTC(year, month - 1 + index, Math.min(day, lastDay)));
  return date.toISOString().slice(0, 10);
}

function addMonthsToMonth(monthText, index) {
  const [year, month] = monthText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + index, 1));
  return date.toISOString().slice(0, 7);
}

function buildMonthRange(startMonth, endMonth, monthRows) {
  const rows = [];
  if (!startMonth || !endMonth || startMonth > endMonth) return rows;
  for (let month = startMonth, index = 0; month <= endMonth; index += 1, month = addMonthsToMonth(startMonth, index)) {
    rows.push(monthRows[month] || { month, income: 0, expense: 0, forecast_card: 0 });
  }
  return rows;
}

function normalizeTransaction(input) {
  return {
    type: input.type === 'income' ? 'income' : 'expense',
    date: String(input.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    description: String(input.description || 'Lancamento').trim(),
    category: String(input.category || 'Outros').trim(),
    amount: Math.abs(toNumber(input.amount)),
    payment_method: String(input.payment_method || 'cash'),
    card_id: input.card_id ? Number(input.card_id) : null,
    invoice_id: input.invoice_id ? Number(input.invoice_id) : null,
    installment_group: input.installment_group || null,
    installment_index: Math.max(1, Number(input.installment_index || 1)),
    installment_total: Math.max(1, Number(input.installment_total || 1)),
    notes: String(input.notes || '').trim()
  };
}

function validateTransaction(tx) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date)) throw new HttpError(400, 'Data invalida.');
  if (!tx.description) throw new HttpError(400, 'Informe a descricao.');
  if (!tx.category) throw new HttpError(400, 'Informe a categoria.');
  if (!Number.isFinite(tx.amount) || tx.amount <= 0) throw new HttpError(400, 'Informe um valor maior que zero.');
  if (tx.installment_index > tx.installment_total) throw new HttpError(400, 'A parcela atual nao pode ser maior que o total de parcelas.');
}

async function validateOwnedReferences(userId, tx) {
  if (tx.card_id && !(await statements.getCard.get(tx.card_id, userId))) {
    throw new HttpError(400, 'Cartao invalido para este usuario.');
  }
  if (tx.invoice_id) {
    const invoice = await statements.getInvoice.get(tx.invoice_id, userId);
    if (!invoice) throw new HttpError(400, 'Fatura invalida para este usuario.');
    if (tx.card_id && invoice.card_id && Number(invoice.card_id) !== Number(tx.card_id)) {
      throw new HttpError(400, 'Cartao informado nao corresponde a fatura.');
    }
  }
}

async function normalizeAndValidateTransaction(userId, input) {
  const tx = normalizeTransaction(input);
  validateTransaction(tx);
  await validateOwnedReferences(userId, tx);
  return tx;
}

async function createInvoiceRows(userId, input) {
  const tx = await normalizeAndValidateTransaction(userId, input);
  const total = Math.max(1, Math.min(120, Number(tx.installment_total || input.installment_total || 1)));
  const current = Math.max(1, Math.min(total, Number(tx.installment_index || input.installment_index || 1)));
  const shouldProject = tx.type === 'expense' && tx.payment_method === 'credit_card' && total > current;
  const existingCurrent = total > 1
    ? await statements.findProjectedInstallment.get(userId, tx.type, tx.card_id, tx.card_id, current, total, tx.amount, tx.description)
    : null;
  const group = existingCurrent?.installment_group || tx.installment_group || (shouldProject ? randomBytes(8).toString('hex') : null);
  let created = 0;
  let updated = 0;

  for (let index = current; index <= total; index++) {
    const date = monthAdd(tx.date, index - current);
    const projectedNotes = index === current ? tx.notes : [tx.notes, 'Parcela futura prevista a partir da fatura.'].filter(Boolean).join(' ');
    const existingProjected = index === current
      ? existingCurrent
      : group ? await statements.findProjectedInstallmentByGroup.get(userId, group, index) : null;
    if (existingProjected) {
      await statements.updateTransaction.run(tx.type, date, tx.description, tx.category, tx.amount, tx.payment_method, tx.card_id, index === current ? tx.invoice_id : null, group, index, total, projectedNotes, existingProjected.id, userId);
      updated += 1;
    } else {
      await statements.insertTransaction.run(
        userId,
        tx.type,
        date,
        tx.description,
        tx.category,
        tx.amount,
        tx.payment_method,
        tx.card_id,
        index === current ? tx.invoice_id : null,
        group,
        index,
        total,
        projectedNotes
      );
      created += 1;
    }
    await statements.addCategory.run(userId, tx.category, tx.type);
  }

  return { created, updated };
}

async function createTransactionRows(userId, input) {
  const tx = await normalizeAndValidateTransaction(userId, input);
  const total = Math.max(1, Math.min(120, Number(input.installments || tx.installment_total || 1)));
  const current = Math.max(1, Math.min(total, Number(input.installment_index || tx.installment_index || 1)));
  const shouldProject = total > current && !input.id;
  const rows = [];
  if (shouldProject) {
    const group = randomBytes(8).toString('hex');
    for (let index = current; index <= total; index++) {
      const projectedNotes = index === current ? tx.notes : [tx.notes, 'Parcela futura prevista a partir de lancamento manual.'].filter(Boolean).join(' ');
      rows.push({
        ...tx,
        date: monthAdd(tx.date, index - current),
        installment_group: group,
        installment_index: index,
        installment_total: total,
        notes: projectedNotes
      });
    }
  } else {
    rows.push({ ...tx, installment_total: total, installment_index: current });
  }
  for (const row of rows) {
    await statements.insertTransaction.run(userId, row.type, row.date, row.description, row.category, row.amount, row.payment_method, row.card_id, row.invoice_id, row.installment_group, row.installment_index, row.installment_total, row.notes);
    await statements.addCategory.run(userId, row.category, row.type);
  }
  return rows.length;
}

async function updateTransactionRows(userId, id, input) {
  const existing = await statements.getTransaction.get(id, userId);
  if (!existing) throw new HttpError(404, 'Lancamento nao encontrado.');

  const tx = normalizeTransaction({
    ...input,
    invoice_id: input.invoice_id ?? existing.invoice_id,
    installment_group: input.installment_group ?? existing.installment_group,
    installment_index: input.installment_index ?? existing.installment_index,
    installment_total: input.installment_total ?? existing.installment_total
  });
  const total = Math.max(1, Math.min(120, Number(input.installments || tx.installment_total || 1)));
  const current = Math.max(1, Math.min(total, Number(input.installment_index || tx.installment_index || 1)));
  tx.installment_index = current;
  tx.installment_total = total;
  validateTransaction(tx);
  await validateOwnedReferences(userId, tx);

  const hadInstallmentSeries = existing.installment_group || Number(existing.installment_total || 1) > 1;
  if (!hadInstallmentSeries && total === 1) {
    await statements.updateTransaction.run(tx.type, tx.date, tx.description, tx.category, tx.amount, tx.payment_method, tx.card_id, tx.invoice_id, null, 1, 1, tx.notes, id, userId);
    await statements.addCategory.run(userId, tx.category, tx.type);
    return { updated: 1, created: 0, deleted: 0 };
  }

  const group = existing.installment_group || tx.installment_group || randomBytes(8).toString('hex');
  if (total === 1) {
    const deleted = existing.installment_group
      ? (await statements.deleteTransactionGroupExcept.run(userId, existing.installment_group, id)).changes
      : 0;
    await statements.updateTransaction.run(tx.type, tx.date, tx.description, tx.category, tx.amount, tx.payment_method, tx.card_id, tx.invoice_id, null, 1, 1, tx.notes, id, userId);
    await statements.addCategory.run(userId, tx.category, tx.type);
    return { updated: 1, created: 0, deleted };
  }

  const groupRows = existing.installment_group
    ? await statements.listInstallmentGroup.all(userId, existing.installment_group)
    : [existing];
  const rowsByIndex = new Map();
  for (const row of groupRows) {
    const index = Number(row.installment_index || 1);
    if (!rowsByIndex.has(index)) rowsByIndex.set(index, row);
  }

  const baseDate = monthAdd(tx.date, 1 - current);
  let updated = 0;
  let created = 0;
  for (let index = 1; index <= total; index++) {
    const row = rowsByIndex.get(index);
    const date = monthAdd(baseDate, index - 1);
    const notes = index === current ? tx.notes : [tx.notes, 'Parcela futura prevista a partir de lancamento manual.'].filter(Boolean).join(' ');
    const invoiceId = row?.invoice_id || (index === current ? tx.invoice_id : null);
    if (row) {
      await statements.updateTransaction.run(tx.type, date, tx.description, tx.category, tx.amount, tx.payment_method, tx.card_id, invoiceId, group, index, total, notes, row.id, userId);
      updated += 1;
    } else {
      await statements.insertTransaction.run(userId, tx.type, date, tx.description, tx.category, tx.amount, tx.payment_method, tx.card_id, invoiceId, group, index, total, notes);
      created += 1;
    }
  }

  const deleted = (await statements.deleteTransactionGroupAfter.run(userId, group, total)).changes;
  await statements.addCategory.run(userId, tx.category, tx.type);
  return { updated, created, deleted };
}

const investmentTypes = new Set(['renda_fixa', 'acoes', 'fiis', 'fundos', 'tesouro', 'crypto', 'previdencia', 'outros']);
const investmentKinds = new Set(['buy', 'sell', 'dividend', 'interest', 'fee']);

function normalizeInvestmentAsset(input) {
  const ticker = String(input.ticker || '').trim().toUpperCase();
  const name = String(input.name || ticker).trim();
  const assetType = investmentTypes.has(input.asset_type) ? input.asset_type : 'outros';
  return {
    ticker,
    name,
    asset_type: assetType,
    institution: String(input.institution || '').trim(),
    current_price: Math.max(0, toNumber(input.current_price)),
    target_percent: Math.max(0, Math.min(100, toNumber(input.target_percent))),
    notes: String(input.notes || '').trim()
  };
}

function validateInvestmentAsset(asset) {
  if (!asset.ticker) throw new HttpError(400, 'Informe o codigo do ativo.');
  if (!asset.name) throw new HttpError(400, 'Informe o nome do ativo.');
}

function normalizeInvestmentMovement(input) {
  const quantity = Math.max(0, toNumber(input.quantity));
  const unitPrice = Math.max(0, toNumber(input.unit_price));
  const fallbackAmount = quantity && unitPrice ? quantity * unitPrice : 0;
  const amountWasProvided = input.amount !== undefined && input.amount !== null && String(input.amount).trim() !== '';
  return {
    asset_id: Number(input.asset_id),
    date: String(input.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    kind: investmentKinds.has(input.kind) ? input.kind : 'buy',
    quantity,
    unit_price: unitPrice,
    amount: Math.max(0, amountWasProvided ? toNumber(input.amount, fallbackAmount) : fallbackAmount),
    fees: Math.max(0, toNumber(input.fees)),
    notes: String(input.notes || '').trim()
  };
}

async function normalizeAndValidateInvestmentMovement(userId, input) {
  const movement = normalizeInvestmentMovement(input);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(movement.date)) throw new HttpError(400, 'Data invalida.');
  if (!movement.asset_id || !(await statements.getInvestmentAsset.get(movement.asset_id, userId))) {
    throw new HttpError(400, 'Ativo invalido para este usuario.');
  }
  if ((movement.kind === 'buy' || movement.kind === 'sell') && (!movement.quantity || !movement.unit_price)) {
    throw new HttpError(400, 'Informe quantidade e preco unitario.');
  }
  if ((movement.kind === 'dividend' || movement.kind === 'interest' || movement.kind === 'fee') && !movement.amount) {
    throw new HttpError(400, 'Informe o valor da movimentacao.');
  }
  return movement;
}

function buildInvestmentSummary(assets, movements) {
  const byAsset = new Map(assets.map(asset => [Number(asset.id), {
    ...asset,
    quantity: 0,
    cost: 0,
    realized_result: 0,
    earnings: 0,
    fees_total: 0,
    current_value: 0,
    unrealized_result: 0,
    total_result: 0,
    average_price: 0
  }]));

  const ordered = [...movements].sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.id) - Number(b.id));
  for (const movement of ordered) {
    const asset = byAsset.get(Number(movement.asset_id));
    if (!asset) continue;
    const quantity = toNumber(movement.quantity);
    const unitPrice = toNumber(movement.unit_price);
    const amount = toNumber(movement.amount, quantity * unitPrice);
    const fees = toNumber(movement.fees);
    if (movement.kind === 'buy') {
      asset.quantity += quantity;
      asset.cost += amount + fees;
      asset.fees_total += fees;
    } else if (movement.kind === 'sell') {
      const soldQuantity = Math.min(quantity, asset.quantity);
      const averageCost = asset.quantity > 0 ? asset.cost / asset.quantity : 0;
      const soldCost = averageCost * soldQuantity;
      asset.quantity -= soldQuantity;
      asset.cost = Math.max(0, asset.cost - soldCost);
      asset.realized_result += amount - fees - soldCost;
      asset.fees_total += fees;
    } else if (movement.kind === 'dividend' || movement.kind === 'interest') {
      asset.earnings += amount;
    } else if (movement.kind === 'fee') {
      asset.fees_total += amount;
      asset.realized_result -= amount;
    }
  }

  const positions = [...byAsset.values()].map(asset => {
    const currentPrice = toNumber(asset.current_price);
    const currentValue = asset.quantity * currentPrice;
    const unrealized = currentValue - asset.cost;
    const totalResult = unrealized + asset.realized_result + asset.earnings;
    return {
      ...asset,
      quantity: Number(asset.quantity.toFixed(8)),
      cost: Number(asset.cost.toFixed(2)),
      average_price: asset.quantity > 0 ? Number((asset.cost / asset.quantity).toFixed(4)) : 0,
      current_value: Number(currentValue.toFixed(2)),
      unrealized_result: Number(unrealized.toFixed(2)),
      total_result: Number(totalResult.toFixed(2)),
      earnings: Number(asset.earnings.toFixed(2)),
      realized_result: Number(asset.realized_result.toFixed(2)),
      fees_total: Number(asset.fees_total.toFixed(2))
    };
  });

  const summary = positions.reduce((acc, asset) => {
    acc.cost += asset.cost;
    acc.current_value += asset.current_value;
    acc.unrealized_result += asset.unrealized_result;
    acc.realized_result += asset.realized_result;
    acc.earnings += asset.earnings;
    acc.fees_total += asset.fees_total;
    return acc;
  }, { cost: 0, current_value: 0, unrealized_result: 0, realized_result: 0, earnings: 0, fees_total: 0 });
  summary.total_result = summary.unrealized_result + summary.realized_result + summary.earnings;
  for (const key of Object.keys(summary)) summary[key] = Number(summary[key].toFixed(2));

  const allocationMap = {};
  for (const asset of positions) allocationMap[asset.asset_type] = (allocationMap[asset.asset_type] || 0) + asset.current_value;
  const allocation = Object.entries(allocationMap)
    .map(([name, amount]) => ({
      name,
      amount: Number(amount.toFixed(2)),
      percent: summary.current_value > 0 ? Number(((amount / summary.current_value) * 100).toFixed(2)) : 0
    }))
    .sort((a, b) => b.amount - a.amount);

  return { summary, positions: positions.sort((a, b) => b.current_value - a.current_value), allocation };
}

async function investmentsDashboard(userId) {
  const assets = await statements.listInvestmentAssets.all(userId);
  const movements = await statements.listInvestmentMovements.all(userId);
  return { assets, movements, ...buildInvestmentSummary(assets, movements) };
}

async function dashboard(userId, selectedMonth = null) {
  const transactions = await statements.listTransactions.all(userId);
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const activeMonth = selectedMonth || thisMonth;
  const monthRows = {};
  const categories = {};
  const cardTotals = {};
  let incomeMonth = 0;
  let expenseMonth = 0;

  for (const tx of transactions) {
    const month = tx.date.slice(0, 7);
    monthRows[month] ||= { month, income: 0, expense: 0, forecast_card: 0 };
    monthRows[month][tx.type] += tx.amount;
    if (tx.payment_method === 'credit_card' && tx.type === 'expense') monthRows[month].forecast_card += tx.amount;
    if (month === activeMonth) {
      if (tx.type === 'income') incomeMonth += tx.amount;
      else {
        expenseMonth += tx.amount;
        categories[tx.category] = (categories[tx.category] || 0) + tx.amount;
        if (tx.payment_method === 'credit_card') {
          const cardKey = tx.card_id || 'none';
          cardTotals[cardKey] ||= { card_id: tx.card_id || null, name: tx.card_name || 'Sem cartao', amount: 0, count: 0 };
          cardTotals[cardKey].amount += Number(tx.amount || 0);
          cardTotals[cardKey].count += 1;
        }
      }
    }
  }

  const knownMonths = Object.keys(monthRows);
  const lastMonth = knownMonths.length ? knownMonths.reduce((max, month) => month > max ? month : max, activeMonth) : activeMonth;
  const startMonth = activeMonth < thisMonth ? activeMonth : thisMonth;
  const endMonth = lastMonth > activeMonth ? lastMonth : activeMonth;
  const months = buildMonthRange(startMonth, endMonth, monthRows);
  const activityMonths = months.filter(row =>
    Number(row.income || 0) !== 0
    || Number(row.expense || 0) !== 0
    || Number(row.forecast_card || 0) !== 0
  );
  const forecast = Object.values(monthRows)
    .filter(row => row.month >= thisMonth && row.forecast_card > 0)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(0, 18);

  return {
    thisMonth,
    selectedMonth: activeMonth,
    incomeMonth,
    expenseMonth,
    balanceMonth: incomeMonth - expenseMonth,
    categories: Object.entries(categories).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
    cardsMonthly: Object.values(cardTotals).sort((a, b) => b.amount - a.amount),
    months,
    activityMonths,
    forecast
  };
}

function buildCardReminder(row, type, targetDate, days, channel = 'whatsapp') {
  const eventLabel = type === 'closing' ? 'fechamento da fatura' : 'vencimento da fatura';
  const action = type === 'closing' ? 'fecha' : 'vence';
  const text = daysText(days);
  const message = channel === 'sms'
    ? `CF-RD: Cartao ${row.card_name} ${action} ${text}, em ${dateBR(targetDate)}. ${type === 'closing' ? 'Confira os lancamentos.' : 'Programe o pagamento.'}`
    : [
        `CF-R&D: lembrete do cartao ${row.card_name}.`,
        `A fatura ${action} ${text}, em ${dateBR(targetDate)}.`,
        type === 'closing'
          ? 'Confira os lancamentos antes do fechamento.'
          : 'Programe o pagamento para evitar juros e multa.'
      ].join(' ');
  return {
    message,
    templateData: {
      cardName: row.card_name,
      eventLabel,
      targetDate: dateBR(targetDate),
      daysText: text
    }
  };
}

async function processCardReminder(row, type, targetDate, todayText, channel = 'whatsapp') {
  const days = daysBetween(todayText, targetDate);
  const existing = await statements.getCardReminderLog.get(row.user_id, row.card_id, type, todayText, targetDate);
  if (existing?.status === 'sent') return { status: 'already_sent' };

  const { message, templateData } = buildCardReminder(row, type, targetDate, days, channel);
  let sendResult;
  try {
    sendResult = channel === 'sms'
      ? await sendSmsMessage(row.whatsapp_phone, message)
      : await sendWhatsAppMessage(row.whatsapp_phone, message, templateData);
  } catch (error) {
    sendResult = { sent: false, status: 'failed', details: error.message };
  }
  await statements.upsertCardReminderLog.run(
    row.user_id,
    row.card_id,
    type,
    todayText,
    targetDate,
    sendResult.status,
    channel,
    message,
    sendResult.details || ''
  );
  return { status: sendResult.status };
}

async function runCardReminders(todayText = localToday()) {
  const rows = await statements.listCardReminderTargets.all();
  const summary = { date: todayText, checked: 0, sent: 0, skipped: 0, failed: 0, already_sent: 0 };
  for (const row of rows) {
    if (row.paid_until && row.paid_until < todayText) continue;
    const phone = normalizePhone(row.whatsapp_phone);
    if (!phone) continue;
    const targetRows = [
      { type: 'closing', targetDate: nextMonthlyDate(Number(row.closing_day || 1), todayText), daysLimit: Number(row.notify_closing_days ?? 3) },
      { type: 'due', targetDate: nextMonthlyDate(Number(row.due_day || 10), todayText), daysLimit: Number(row.notify_due_days ?? 3) }
    ];
    for (const reminder of targetRows) {
      const days = daysBetween(todayText, reminder.targetDate);
      if (days < 0 || days > reminder.daysLimit) continue;
      const channels = [
        Number(row.notify_whatsapp_enabled || 0) ? 'whatsapp' : null,
        Number(row.notify_sms_enabled || 0) ? 'sms' : null
      ].filter(Boolean);
      for (const channel of channels) {
        summary.checked += 1;
        const result = await processCardReminder({ ...row, whatsapp_phone: phone }, reminder.type, reminder.targetDate, todayText, channel);
        summary[result.status] = (summary[result.status] || 0) + 1;
      }
    }
  }
  return summary;
}

async function extractPdfText(filePath) {
  const script = join(__dirname, 'scripts', 'extract_pdf.py');
  const result = spawnSync(bundledPython, [script, filePath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || 'Nao foi possivel ler o PDF.');
  if (result.stdout.trim().length > 80) return result.stdout;

  const ocrScript = join(__dirname, 'scripts', 'ocr_pdf.mjs');
  const ocr = spawnSync(process.execPath, [ocrScript, filePath], {
    cwd: __dirname,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
  if (ocr.status !== 0) throw new Error(ocr.stderr || 'Nao foi possivel fazer OCR do PDF.');
  return ocr.stdout;
}

function parseMoneyBR(value) {
  const cleaned = String(value || '').replace(/[^\d,.-]/g, '').replace(/\.$/, '');
  if (/^-?\d{3,}$/.test(cleaned)) {
    const sign = cleaned.startsWith('-') ? -1 : 1;
    const digits = cleaned.replace('-', '');
    return sign * Number(`${digits.slice(0, -2)}.${digits.slice(-2)}`);
  }
  return Number(cleaned.replace(/\./g, '').replace(',', '.'));
}

function inferCategory(description) {
  const text = description.toLowerCase();
  if (/mercado|super|atacad|padaria|restaurante|ifood|lanch|food|bar\b/.test(text)) return 'Alimentacao';
  if (/uber|99|posto|combust|estacion|metro|onibus|passagem/.test(text)) return 'Transporte';
  if (/farm|drog|medic|hospital|clinica|saude/.test(text)) return 'Saude';
  if (/netflix|spotify|prime|google|apple|microsoft|assinatura/.test(text)) return 'Assinaturas';
  if (/escola|curso|livr|faculdade|educ/.test(text)) return 'Educacao';
  if (/cinema|show|lazer|viagem|hotel/.test(text)) return 'Lazer';
  return 'Cartao de credito';
}

function normalizeMonthToken(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase()
    .slice(0, 3);
}

function monthFromToken(value) {
  const months = {
    jan: 1,
    fev: 2,
    mar: 3,
    abr: 4,
    mai: 5,
    jun: 6,
    jul: 7,
    ago: 8,
    set: 9,
    out: 10,
    nov: 11,
    dez: 12
  };
  return months[normalizeMonthToken(value)] || 0;
}

function normalizeInvoiceLine(rawLine) {
  return String(rawLine || '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/(\d{1,3}\s*\/\s*)(\d{2})(\d{1,3},\d{2}\b)/g, '$1$2 $3')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeInvoiceSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isInvoiceTransactionHeader(line) {
  const text = normalizeInvoiceSearch(line);
  return (
    (/^data\b/.test(text) && /(descricao|estabelecimento|historico|valor|parcela)/.test(text))
    || /lancamentos.*(brasil|nacionais|valor|cartao)/.test(text)
    || /compras.*(nacionais|cartao|valor)/.test(text)
    || /detalhamento.*(compra|transacao|lancamento)/.test(text)
  );
}

function isInvoiceStopLine(line) {
  const text = normalizeInvoiceSearch(line);
  return /^(total|subtotal)\b/.test(text)
    || /^(pagamento minimo|vencimento|codigo de barras|linha digitavel|boleto|pix copia)/.test(text)
    || /^(encargos financeiros|limite disponivel|melhor dia de compra|resumo da fatura)/.test(text);
}

function extractInvoiceDatePrefix(line, fallbackMonth) {
  const numeric = line.match(/^(\d{1,2})\s*[\/.-]\s*(\d{1,2})(?:\s*[\/.-]\s*(\d{2,4}))?\s*(.*)$/i);
  const named = line.match(/^(\d{1,2})\s+([a-zA-Z\u00C0-\u00FF]{3,9})\.?(?:\s+(\d{2,4}))?\s*(.*)$/i);
  const compact = line.match(/^(\d{2})(\d{2})\s+(.+)$/i);
  const match = numeric || named || (compact ? [compact[0], compact[1], compact[2], undefined, compact[3]] : null);
  if (!match) return null;

  const [, day, monthRaw, yearRaw, rest = ''] = match;
  const dayNumber = Number(day);
  const monthNumber = /^\d+$/.test(monthRaw) ? Number(monthRaw) : monthFromToken(monthRaw);
  if (dayNumber < 1 || dayNumber > 31 || monthNumber < 1 || monthNumber > 12) return null;

  const fallbackYear = Number(fallbackMonth.slice(0, 4));
  const fallbackMonthNumber = Number(fallbackMonth.slice(5, 7));
  const inferredYear = monthNumber > fallbackMonthNumber ? fallbackYear - 1 : fallbackYear;
  const year = yearRaw ? (yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : String(inferredYear);
  const date = `${year}-${String(monthNumber).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
  return { date, rest: normalizeInvoiceLine(rest) };
}

function extractLastInvoiceAmount(text) {
  const amountRegex = /(?:R\$\s*)?-?\d{1,3}(?:\.\d{3})*,\d{2}-?|(?:R\$\s*)?-?\d{3,}-?/gi;
  const matches = [];
  for (const match of text.matchAll(amountRegex)) {
    const raw = match[0];
    const index = match.index || 0;
    const before = text[index - 1] || '';
    const after = text[index + raw.length] || '';
    if (before === '/' || after === '/') continue;

    const tail = text.slice(index + raw.length).trim();
    const hasMoneyShape = raw.includes(',') || /R\$/i.test(raw);
    if (!hasMoneyShape && tail.length > 3) continue;
    matches.push({ raw, index, end: index + raw.length });
  }
  return matches.length ? matches[matches.length - 1] : null;
}

function stripLeadingInvoiceDate(text) {
  return normalizeInvoiceLine(text)
    .replace(/^\d{1,2}\s*[\/.-]\s*\d{1,2}(?:\s*[\/.-]\s*\d{2,4})?\s+/, '')
    .replace(/^\d{1,2}\s+[a-zA-Z\u00C0-\u00FF]{3,9}\.?(?:\s+\d{2,4})?\s+/, '')
    .trim();
}

function validInstallment(index, total) {
  return Number.isInteger(index)
    && Number.isInteger(total)
    && index >= 1
    && total >= 1
    && index <= total
    && total <= 120;
}

function extractInstallmentInfo(description) {
  const candidates = [
    /\b(?:parc(?:ela)?|parcelamento|prest(?:acao)?|prest)\.?\s*(\d{1,3})\s*(?:\/|de)\s*(\d{1,3})\b/i,
    /\b(\d{1,3})\s*(?:\/|de)\s*(\d{1,3})\s*(?:parc(?:ela)?s?|parcelas?|prest(?:acoes|acao)?|prest)\b/i,
    /(?:^|[^\d])(\d{1,3})\s+de\s+(\d{1,3})(?=$|[^\d])/i,
    /(?:^|[^\d/])(\d{1,3})\s*\/\s*(\d{1,3})(?=$|[^\d/])/i
  ];

  for (const pattern of candidates) {
    const match = description.match(pattern);
    if (!match) continue;
    const installment_index = Number(match[1]);
    const installment_total = Number(match[2]);
    if (validInstallment(installment_index, installment_total)) {
      return { installment_index, installment_total };
    }
  }
  return { installment_index: 1, installment_total: 1 };
}

function cleanInvoiceDescription(description) {
  return stripLeadingInvoiceDate(description)
    .replace(/\b(?:parc(?:ela)?|parcelamento|prest(?:acao)?|prest)\.?\s*\d{1,3}\s*(?:\/|de)\s*\d{1,3}\b/gi, ' ')
    .replace(/\b\d{1,3}\s*(?:\/|de)\s*\d{1,3}\s*(?:parc(?:ela)?s?|parcelas?|prest(?:acoes|acao)?|prest)\b/gi, ' ')
    .replace(/(?:^|[^\d])\d{1,3}\s+de\s+\d{1,3}(?=$|[^\d])/gi, ' ')
    .replace(/(?:^|[^\d/])\d{1,3}\s*\/\s*\d{1,3}(?=$|[^\d/])/g, ' ')
    .replace(/^[-|:;,\s]+/, '')
    .replace(/[-|:;,\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseInvoiceBlock(block, fallbackMonth) {
  const prefix = extractInvoiceDatePrefix(block.text, fallbackMonth);
  if (!prefix) return null;

  const amountMatch = extractLastInvoiceAmount(prefix.rest);
  if (!amountMatch) return null;

  const beforeAmount = prefix.rest.slice(0, amountMatch.index).trim();
  const afterAmount = prefix.rest.slice(amountMatch.end).replace(/^[DC]\b/i, '').trim();
  const descriptionRaw = beforeAmount.length >= 3 || !/[a-zA-Z\u00C0-\u00FF]/.test(afterAmount)
    ? beforeAmount
    : afterAmount;
  const installment = extractInstallmentInfo(descriptionRaw);
  const description = cleanInvoiceDescription(descriptionRaw);
  const isCreditOrPayment = /-$/.test(amountMatch.raw)
    || /pagamento|credito recebido|cr[e\u00E9]dito|estorno|ajuste a credito/i.test(description);
  const amount = Math.abs(parseMoneyBR(amountMatch.raw));
  if (!description || !amount || isCreditOrPayment) return null;

  return {
    type: 'expense',
    date: prefix.date,
    description,
    category: inferCategory(description),
    amount,
    payment_method: 'credit_card',
    installment_index: installment.installment_index,
    installment_total: installment.installment_total,
    installments: 1,
    confidence: block.inTransactions ? 0.84 : 0.64
  };
}

function parseInvoiceText(text, fallbackMonth) {
  const rows = [];
  const fallbackRows = [];
  const totalRegex = /(?:total\s+(?:da\s+)?fatura|valor\s+total).*?(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  const ignoredSections = /parcele facil|pagamento minimo|encargos financeiros|boleto|recibo do pagador|resumo da fatura|limites em r\$|previsao para fechamento|saldos futuros/i;
  let total = 0;
  let inTransactions = false;
  let currentBlock = null;
  const blocks = [];

  const flushBlock = () => {
    if (currentBlock) blocks.push(currentBlock);
    currentBlock = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeInvoiceLine(rawLine);
    if (!line) continue;

    if (isInvoiceTransactionHeader(line)) {
      flushBlock();
      inTransactions = true;
      continue;
    }

    const totalMatch = line.match(totalRegex);
    if (totalMatch) total = parseMoneyBR(totalMatch[1]);

    if (isInvoiceStopLine(line)) {
      flushBlock();
      if (inTransactions && /^total/i.test(normalizeInvoiceSearch(line))) break;
      continue;
    }
    if (ignoredSections.test(line) && !inTransactions) {
      flushBlock();
      continue;
    }

    if (extractInvoiceDatePrefix(line, fallbackMonth)) {
      flushBlock();
      currentBlock = { text: line, inTransactions };
      continue;
    }

    if (currentBlock) {
      currentBlock.text = `${currentBlock.text} ${line}`;
    }
  }

  flushBlock();

  for (const block of blocks) {
    const parsedRow = parseInvoiceBlock(block, fallbackMonth);
    if (!parsedRow) continue;
    if (block.inTransactions) rows.push(parsedRow);
    else fallbackRows.push(parsedRow);
  }

  return { total, rows: rows.length ? rows : fallbackRows };
}

function parseInvoiceTextLegacy(text, fallbackMonth) {
  const rows = [];
  const fallbackRows = [];
  const numericDateLineRegex = /^(\d{1,2})\s*[\/.-]\s*(\d{1,2})(?:[\/.-](\d{2,4}))?\s+(.+?)\s+(R\$?\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2}-?|-?\d{2,}-?)\s*$/i;
  const namedMonthLineRegex = /^(\d{1,2})\s+([a-zA-Z\u00C0-\u00FF]{3,9})\.?(?:\s+(\d{2,4}))?\s+(.+?)\s+(R\$?\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2}-?|-?\d{2,}-?)\s*$/i;
  const totalRegex = /(?:total\s+(?:da\s+)?fatura|valor\s+total).*?(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  const ignoredSections = /parcele facil|pagamento minimo|encargos financeiros|boleto|recibo do pagador|resumo da fatura|limites em r\$|previsao para fechamento|saldos futuros/i;
  let total = 0;
  let inTransactions = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
    if (/lan[cç]amentos no brasil|data descri[cç][aã]o valor/i.test(line)) {
      inTransactions = true;
      continue;
    }
    const totalMatch = line.match(totalRegex);
    if (totalMatch) total = parseMoneyBR(totalMatch[1]);
    if (inTransactions && /^total da fatura/i.test(line)) break;
    if (ignoredSections.test(line) && !inTransactions) continue;
    const match = line.match(namedMonthLineRegex) || line.match(numericDateLineRegex);
    if (!match) continue;
    const [, day, monthRaw, yearRaw, descriptionRaw, , amountRaw] = match;
    const dayNumber = Number(day);
    const monthNumber = /^\d+$/.test(monthRaw) ? Number(monthRaw) : monthFromToken(monthRaw);
    if (dayNumber < 1 || dayNumber > 31 || monthNumber < 1 || monthNumber > 12) continue;
    const fallbackYear = Number(fallbackMonth.slice(0, 4));
    const fallbackMonthNumber = Number(fallbackMonth.slice(5, 7));
    const inferredYear = monthNumber > fallbackMonthNumber ? fallbackYear - 1 : fallbackYear;
    const year = yearRaw ? (yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : String(inferredYear);
    const date = `${year}-${String(monthNumber).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
    const installment = descriptionRaw.match(/(?:^|[\s-])(\d{1,2})\s*\/\s*(\d{1,2})(?=\D*$)/);
    const installment_index = installment ? Number(installment[1]) : 1;
    const installment_total = installment ? Number(installment[2]) : 1;
    const description = descriptionRaw
      .replace(/\s*-?\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/, '')
      .replace(/^[-\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const isCreditOrPayment = /-$/.test(amountRaw) || /pagamento|credito recebido|cr[eé]dito|estorno/i.test(description);
    const amount = Math.abs(parseMoneyBR(amountRaw));
    if (!description || !amount || isCreditOrPayment) continue;
    const parsedRow = {
      type: 'expense',
      date,
      description,
      category: inferCategory(description),
      amount,
      payment_method: 'credit_card',
      installment_index,
      installment_total,
      installments: 1,
      confidence: inTransactions ? 0.82 : 0.62
    };
    if (inTransactions) rows.push(parsedRow);
    else fallbackRows.push(parsedRow);
  }
  return { total, rows: rows.length ? rows : fallbackRows };
}

async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.match(/boundary=(.+)$/)?.[1];
  if (!boundary) throw new HttpError(400, 'Upload invalido.');
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  const parts = body.toString('binary').split(`--${boundary}`);
  const fields = {};
  const files = {};
  for (const part of parts) {
    const [rawHeaders, rawContent] = part.split('\r\n\r\n');
    if (!rawContent) continue;
    const name = rawHeaders.match(/name="([^"]+)"/)?.[1];
    const filename = rawHeaders.match(/filename="([^"]*)"/)?.[1];
    const content = rawContent.slice(0, -2);
    if (!name) continue;
    if (filename) files[name] = { filename, buffer: Buffer.from(content, 'binary') };
    else fields[name] = Buffer.from(content, 'binary').toString('utf8');
  }
  return { fields, files };
}

function route(method, pathname, expectedMethod, expectedPath) {
  return method === expectedMethod && pathname === expectedPath;
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (route(req.method, pathname, 'POST', '/api/auth/register')) {
    const { email, password } = await readJson(req);
    if (!email || !password || password.length < 6) return sendJson(res, 400, { error: 'Informe email e senha com pelo menos 6 caracteres.' });
    let result;
    const normalizedEmail = String(email).toLowerCase().trim();
    try {
      result = await statements.createUnverifiedUser.run(normalizedEmail, hashPassword(password));
    } catch {
      return sendJson(res, 409, { error: 'Email ja cadastrado.' });
    }
    await ensureDefaultCategories(result.lastInsertRowid);
    const token = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    await statements.createVerification.run(token, result.lastInsertRowid, expires);
    const verificationLink = `${publicBaseUrl(req)}/api/auth/verify?token=${token}`;
    let emailSent = false;
    try {
      emailSent = await sendVerificationEmail(normalizedEmail, verificationLink);
    } catch (error) {
      console.error(`Falha ao enviar email de verificacao: ${error.message}`);
    }
    return sendJson(res, 201, { ok: true, requiresVerification: true, emailSent, verificationLink: emailSent ? undefined : verificationLink });
  }

  if (route(req.method, pathname, 'GET', '/api/auth/verify')) {
    const token = url.searchParams.get('token');
    const verification = token ? await statements.getVerification.get(token) : null;
    if (!verification) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Link invalido ou expirado</h1><p>Solicite um novo cadastro ou novo link de verificacao.</p>');
      return;
    }
    await statements.verifyUserEmail.run(verification.user_id);
    await statements.useVerification.run(token);
    res.writeHead(302, { location: '/?verified=1' });
    res.end();
    return;
  }

  if (route(req.method, pathname, 'POST', '/api/auth/login')) {
    const { email, password } = await readJson(req);
    const user = await statements.getUserByEmail.get(String(email || '').toLowerCase().trim());
    if (!user || !verifyPassword(String(password || ''), user.password_hash)) return sendJson(res, 401, { error: 'Email ou senha invalidos.' });
    if (!user.email_verified) return sendJson(res, 403, { error: 'Confirme seu email antes de entrar.' });
    const blockedReason = accessError(user);
    if (blockedReason) return sendJson(res, 403, { error: blockedReason });
    const token = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    await statements.createSession.run(token, user.id, expires);
    setSessionCookie(res, token);
    return sendJson(res, 200, {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified,
      role: user.role,
      account_status: user.account_status,
      paid_until: user.paid_until,
      whatsapp_phone: user.whatsapp_phone,
      notify_whatsapp_enabled: user.notify_whatsapp_enabled,
      notify_sms_enabled: user.notify_sms_enabled,
      notify_closing_days: user.notify_closing_days,
      notify_due_days: user.notify_due_days
    });
  }

  if (route(req.method, pathname, 'POST', '/api/auth/logout')) {
    const token = parseCookies(req).session;
    if (token) await statements.deleteSession.run(token);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (route(req.method, pathname, 'POST', '/api/webhooks/mercado-livre')) {
    const secret = process.env.ML_WEBHOOK_SECRET;
    if (!secret) return sendJson(res, 503, { error: 'Webhook nao configurado.' });
    if (secret && req.headers['x-cf-webhook-secret'] !== secret) return sendJson(res, 401, { error: 'Webhook nao autorizado.' });
    const payload = await readJson(req);
    const order = orderFromWebhook(payload);
    await statements.insertSalesOrder.run('mercado_livre', order.externalId, order.buyerEmail, order.buyerName, order.status, order.amount, JSON.stringify(payload));
    return sendJson(res, 200, { ok: true });
  }

  if (route(req.method, pathname, 'POST', '/api/notifications/run')) {
    const secret = process.env.REMINDER_CRON_SECRET;
    if (!secret) return sendJson(res, 503, { error: 'Agendador de avisos nao configurado.' });
    if (req.headers['x-cf-cron-secret'] !== secret) return sendJson(res, 401, { error: 'Agendador nao autorizado.' });
    return sendJson(res, 200, await runCardReminders(url.searchParams.get('date') || localToday()));
  }

  const user = await requireUser(req, res);
  if (!user) return;

  if (route(req.method, pathname, 'GET', '/api/me')) return sendJson(res, 200, user);
  if (route(req.method, pathname, 'PUT', '/api/me/notifications')) {
    const settings = sanitizeNotificationSettings(await readJson(req));
    await statements.updateNotificationSettings.run(
      settings.whatsapp_phone,
      settings.notify_whatsapp_enabled,
      settings.notify_sms_enabled,
      settings.notify_closing_days,
      settings.notify_due_days,
      user.id
    );
    return sendJson(res, 200, { ok: true, user: await statements.getUserById.get(user.id) });
  }
  if (route(req.method, pathname, 'POST', '/api/me/notifications/test')) {
    const body = await readJson(req);
    const channel = body.channel === 'sms' ? 'sms' : 'whatsapp';
    const current = await statements.getUserById.get(user.id);
    const phone = normalizePhone(current.whatsapp_phone);
    if (!phone) return sendJson(res, 400, { error: 'Cadastre seu telefone com DDD antes de testar.' });
    const message = channel === 'sms'
      ? 'CF-RD: teste de aviso do sistema.'
      : 'CF-R&D: teste de aviso do sistema. Se voce recebeu esta mensagem, os lembretes de cartao poderao ser enviados pelo WhatsApp.';
    const result = channel === 'sms' ? await sendSmsMessage(phone, message) : await sendWhatsAppMessage(phone, message, {
      cardName: 'Teste',
      eventLabel: 'teste de aviso',
      targetDate: dateBR(localToday()),
      daysText: 'hoje'
    });
    if (!result.sent) return sendJson(res, result.status === 'skipped' ? 503 : 502, { error: result.details || 'Nao foi possivel enviar o teste.', status: result.status });
    return sendJson(res, 200, { ok: true });
  }
  if (route(req.method, pathname, 'POST', '/api/me/password')) {
    const body = await readJson(req);
    const privateUser = await statements.getPrivateUserById.get(user.id);
    if (!privateUser || !verifyPassword(String(body.currentPassword || ''), privateUser.password_hash)) {
      return sendJson(res, 400, { error: 'Senha atual incorreta.' });
    }
    if (!body.newPassword || String(body.newPassword).length < 6) {
      return sendJson(res, 400, { error: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    }
    await statements.updatePassword.run(hashPassword(String(body.newPassword)), user.id);
    return sendJson(res, 200, { ok: true });
  }

  if (route(req.method, pathname, 'GET', '/api/admin/users')) {
    if (!requireAdmin(user, res)) return;
    return sendJson(res, 200, await statements.listAdminUsers.all());
  }

  if (pathname.startsWith('/api/admin/users/') && pathname.endsWith('/access') && req.method === 'PUT') {
    if (!requireAdmin(user, res)) return;
    const targetId = Number(pathname.split('/')[4]);
    const target = await statements.getPrivateUserById.get(targetId);
    if (!target) return sendJson(res, 404, { error: 'Usuario nao encontrado.' });
    const body = await readJson(req);
    const access = sanitizeAccessBody(body, target.role);
    await statements.updateUserAccess.run(access.accountStatus, access.paidUntil, access.role, targetId);
    await statements.addLicenseEvent.run(targetId, user.id, 'access_update', `status=${access.accountStatus}; paid_until=${access.paidUntil || ''}; role=${access.role}`);
    return sendJson(res, 200, { ok: true });
  }

  if (route(req.method, pathname, 'GET', '/api/admin/sales')) {
    if (!requireAdmin(user, res)) return;
    return sendJson(res, 200, await statements.listSalesOrders.all());
  }

  if (route(req.method, pathname, 'GET', '/api/categories')) return sendJson(res, 200, await statements.listCategories.all(user.id));
  if (route(req.method, pathname, 'POST', '/api/categories')) {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const type = body.type === 'income' ? 'income' : 'expense';
    if (!name) return sendJson(res, 400, { error: 'Informe o nome da categoria.' });
    try {
      const result = await statements.insertCategory.run(user.id, name, type);
      return sendJson(res, 201, { id: result.lastInsertRowid });
    } catch {
      return sendJson(res, 409, { error: 'Categoria ja cadastrada para este tipo.' });
    }
  }
  if (pathname.startsWith('/api/categories/') && req.method === 'PUT') {
    const id = Number(pathname.split('/').pop());
    const current = await statements.getCategory.get(id, user.id);
    if (!current) return sendJson(res, 404, { error: 'Categoria nao encontrada.' });
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const type = body.type === 'income' ? 'income' : 'expense';
    if (!name) return sendJson(res, 400, { error: 'Informe o nome da categoria.' });
    try {
      await statements.updateCategory.run(name, type, id, user.id);
      await statements.updateTransactionCategoryName.run(name, user.id, current.name, current.type);
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 409, { error: 'Ja existe uma categoria com este nome e tipo.' });
    }
  }
  if (pathname.startsWith('/api/categories/') && req.method === 'DELETE') {
    await statements.deleteCategory.run(Number(pathname.split('/').pop()), user.id);
    return sendJson(res, 200, { ok: true });
  }
  if (route(req.method, pathname, 'GET', '/api/dashboard')) return sendJson(res, 200, await dashboard(user.id, url.searchParams.get('month')));

  if (route(req.method, pathname, 'GET', '/api/investments')) return sendJson(res, 200, await investmentsDashboard(user.id));
  if (route(req.method, pathname, 'POST', '/api/investments/assets')) {
    const asset = normalizeInvestmentAsset(await readJson(req));
    validateInvestmentAsset(asset);
    try {
      const result = await statements.insertInvestmentAsset.run(user.id, asset.ticker, asset.name, asset.asset_type, asset.institution, asset.current_price, asset.target_percent, asset.notes);
      return sendJson(res, 201, { id: result.lastInsertRowid });
    } catch {
      return sendJson(res, 409, { error: 'Ja existe um ativo com este codigo.' });
    }
  }
  if (pathname.startsWith('/api/investments/assets/') && req.method === 'PUT') {
    const id = Number(pathname.split('/').pop());
    if (!(await statements.getInvestmentAsset.get(id, user.id))) return sendJson(res, 404, { error: 'Ativo nao encontrado.' });
    const asset = normalizeInvestmentAsset(await readJson(req));
    validateInvestmentAsset(asset);
    try {
      await statements.updateInvestmentAsset.run(asset.ticker, asset.name, asset.asset_type, asset.institution, asset.current_price, asset.target_percent, asset.notes, id, user.id);
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 409, { error: 'Ja existe um ativo com este codigo.' });
    }
  }
  if (pathname.startsWith('/api/investments/assets/') && req.method === 'DELETE') {
    await statements.deleteInvestmentAsset.run(Number(pathname.split('/').pop()), user.id);
    return sendJson(res, 200, { ok: true });
  }
  if (route(req.method, pathname, 'POST', '/api/investments/movements')) {
    const movement = await normalizeAndValidateInvestmentMovement(user.id, await readJson(req));
    const result = await statements.insertInvestmentMovement.run(user.id, movement.asset_id, movement.date, movement.kind, movement.quantity, movement.unit_price, movement.amount, movement.fees, movement.notes);
    return sendJson(res, 201, { id: result.lastInsertRowid });
  }
  if (pathname.startsWith('/api/investments/movements/') && req.method === 'PUT') {
    const id = Number(pathname.split('/').pop());
    if (!(await statements.getInvestmentMovement.get(id, user.id))) return sendJson(res, 404, { error: 'Movimentacao nao encontrada.' });
    const movement = await normalizeAndValidateInvestmentMovement(user.id, await readJson(req));
    await statements.updateInvestmentMovement.run(movement.asset_id, movement.date, movement.kind, movement.quantity, movement.unit_price, movement.amount, movement.fees, movement.notes, id, user.id);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname.startsWith('/api/investments/movements/') && req.method === 'DELETE') {
    await statements.deleteInvestmentMovement.run(Number(pathname.split('/').pop()), user.id);
    return sendJson(res, 200, { ok: true });
  }

  if (route(req.method, pathname, 'GET', '/api/cards')) return sendJson(res, 200, await statements.listCards.all(user.id));
  if (route(req.method, pathname, 'POST', '/api/cards')) {
    const body = await readJson(req);
    const result = await statements.insertCard.run(user.id, body.name, body.brand || '', toNumber(body.limit_amount), Number(body.closing_day || 1), Number(body.due_day || 10), body.active === false ? 0 : 1);
    return sendJson(res, 201, { id: result.lastInsertRowid });
  }
  if (pathname.startsWith('/api/cards/') && req.method === 'PUT') {
    const id = Number(pathname.split('/').pop());
    const body = await readJson(req);
    await statements.updateCard.run(body.name, body.brand || '', toNumber(body.limit_amount), Number(body.closing_day || 1), Number(body.due_day || 10), body.active === false ? 0 : 1, id, user.id);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname.startsWith('/api/cards/') && req.method === 'DELETE') {
    await statements.deleteCard.run(Number(pathname.split('/').pop()), user.id);
    return sendJson(res, 200, { ok: true });
  }

  if (route(req.method, pathname, 'GET', '/api/transactions')) return sendJson(res, 200, await statements.listTransactions.all(user.id));
  if (route(req.method, pathname, 'POST', '/api/transactions')) {
    const created = await createTransactionRows(user.id, await readJson(req));
    return sendJson(res, 201, { created });
  }
  if (pathname.startsWith('/api/transactions/') && req.method === 'PUT') {
    const id = Number(pathname.split('/').pop());
    const result = await updateTransactionRows(user.id, id, await readJson(req));
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (pathname.startsWith('/api/transactions/') && req.method === 'DELETE') {
    await statements.deleteTransaction.run(Number(pathname.split('/').pop()), user.id);
    return sendJson(res, 200, { ok: true });
  }

  if (route(req.method, pathname, 'GET', '/api/invoices')) return sendJson(res, 200, await statements.listInvoices.all(user.id));
  if (pathname.startsWith('/api/invoices/') && req.method === 'DELETE') {
    const id = Number(pathname.split('/').pop());
    const invoice = await statements.getInvoice.get(id, user.id);
    if (!invoice) return sendJson(res, 404, { error: 'Fatura nao encontrada.' });
    const txProjected = (await statements.deleteInvoiceProjectedTransactions.run(user.id, user.id, id)).changes;
    const txDirect = (await statements.deleteInvoiceTransactions.run(user.id, id)).changes;
    await statements.deleteInvoice.run(id, user.id);
    const storedPath = invoice.stored_name ? resolve(join(uploadDir, invoice.stored_name)) : '';
    if (storedPath && storedPath.startsWith(uploadDir) && storedPath !== uploadDir && existsSync(storedPath)) unlinkSync(storedPath);
    return sendJson(res, 200, { ok: true, deleted_transactions: txDirect + txProjected });
  }
  if (pathname.startsWith('/api/invoices/') && pathname.endsWith('/reparse') && req.method === 'POST') {
    const id = Number(pathname.split('/')[3]);
    const invoice = await statements.getInvoice.get(id, user.id);
    if (!invoice) return sendJson(res, 404, { error: 'Fatura nao encontrada.' });
    const storedPath = invoice.stored_name ? resolve(join(uploadDir, invoice.stored_name)) : '';
    if (!storedPath || !storedPath.startsWith(uploadDir) || storedPath === uploadDir || !existsSync(storedPath)) {
      return sendJson(res, 404, { error: 'Arquivo PDF da fatura nao encontrado no servidor. Envie o PDF novamente.' });
    }
    const text = await extractPdfText(storedPath);
    const parsed = parseInvoiceText(text, invoice.month);
    return sendJson(res, 200, {
      invoice_id: id,
      card_id: invoice.card_id,
      total: parsed.total,
      rows: parsed.rows,
      extracted_text: text.slice(0, 20000),
      replace_existing: true
    });
  }
  if (route(req.method, pathname, 'POST', '/api/invoices/upload')) {
    const { fields, files } = await parseMultipart(req);
    const file = files.pdf;
    if (!file || !file.filename.toLowerCase().endsWith('.pdf')) return sendJson(res, 400, { error: 'Anexe uma fatura em PDF.' });
    const month = fields.month || new Date().toISOString().slice(0, 7);
    const cardId = fields.card_id ? Number(fields.card_id) : null;
    if (cardId && !(await statements.getCard.get(cardId, user.id))) throw new HttpError(400, 'Cartao invalido para este usuario.');
    const existingInvoice = await statements.findInvoiceByUpload.get(user.id, month, file.filename, cardId, cardId);
    if (existingInvoice) {
      const importedCount = await statements.countInvoiceTransactions.get(user.id, existingInvoice.id);
      if (Number(importedCount?.count || 0) > 0) {
        throw new HttpError(409, 'Esta fatura ja foi enviada para este cartao e periodo.');
      }
      await statements.deleteInvoice.run(existingInvoice.id, user.id);
      const oldStoredPath = existingInvoice.stored_name ? resolve(join(uploadDir, existingInvoice.stored_name)) : '';
      if (oldStoredPath && oldStoredPath.startsWith(uploadDir) && oldStoredPath !== uploadDir && existsSync(oldStoredPath)) unlinkSync(oldStoredPath);
    }
    const stored = `${Date.now()}-${createHash('sha1').update(file.filename).digest('hex')}.pdf`;
    const filePath = join(uploadDir, stored);
    writeFileSync(filePath, file.buffer);
    const text = await extractPdfText(filePath);
    const parsed = parseInvoiceText(text, month);
    const invoice = await statements.insertInvoice.run(user.id, cardId, month, file.filename, stored, parsed.total);
    return sendJson(res, 201, {
      invoice_id: invoice.lastInsertRowid,
      total: parsed.total,
      rows: parsed.rows,
      extracted_chars: text.length,
      extracted_text: text.slice(0, 30000)
    });
  }
  if (route(req.method, pathname, 'POST', '/api/invoices/import')) {
    const body = await readJson(req);
    const invoiceId = Number(body.invoice_id);
    const invoice = await statements.getInvoice.get(invoiceId, user.id);
    if (!invoice) throw new HttpError(404, 'Fatura nao encontrada.');
    const alreadyImported = await statements.countInvoiceTransactions.get(user.id, invoiceId);
    if (Number(alreadyImported?.count || 0) > 0) {
      if (!body.replace_existing) throw new HttpError(409, 'Esta fatura ja foi importada.');
      await statements.deleteInvoiceProjectedTransactions.run(user.id, user.id, invoiceId);
      await statements.deleteInvoiceTransactions.run(user.id, invoiceId);
    }
    const rows = Array.isArray(body.rows) ? body.rows : [];
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const result = await createInvoiceRows(user.id, { ...row, invoice_id: invoiceId, card_id: body.card_id || row.card_id || invoice.card_id, payment_method: 'credit_card' });
      created += result.created;
      updated += result.updated;
    }
    return sendJson(res, 201, { created, updated });
  }

  sendJson(res, 404, { error: 'Rota nao encontrada.' });
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(join(publicDir, safePath));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    const status = error.status || 500;
    const message = error instanceof HttpError || process.env.NODE_ENV !== 'production'
      ? error.message || 'Erro interno.'
      : 'Erro interno.';
    sendJson(res, status, { error: message });
  }
});

const port = Number(process.env.PORT || 3060);
server.listen(port, () => {
  console.log(`Controle financeiro rodando em http://localhost:${port}`);
});

let lastReminderRunDate = '';
let reminderJobRunning = false;

async function runDailyReminderJob() {
  if (process.env.REMINDER_AUTO_RUN !== 'true' || reminderJobRunning) return;
  const todayText = localToday();
  if (lastReminderRunDate === todayText) return;
  reminderJobRunning = true;
  try {
    const result = await runCardReminders(todayText);
    lastReminderRunDate = todayText;
    if (result.checked) console.log(`Avisos de cartao processados: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`Falha ao processar avisos de cartao: ${error.message}`);
  } finally {
    reminderJobRunning = false;
  }
}

setTimeout(runDailyReminderJob, 15000);
setInterval(runDailyReminderJob, 60 * 60 * 1000);

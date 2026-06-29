import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  res.setHeader('set-cookie', `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`);
}

function clearSessionCookie(res) {
  res.setHeader('set-cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  return JSON.parse(body.toString('utf8'));
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

function monthAdd(dateText, index) {
  const [year, month, day] = dateText.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month + index, 0)).getUTCDate();
  const date = new Date(Date.UTC(year, month - 1 + index, Math.min(day, lastDay)));
  return date.toISOString().slice(0, 10);
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

async function createInvoiceRows(userId, input) {
  const tx = normalizeTransaction(input);
  const total = Math.max(1, Math.min(120, Number(tx.installment_total || input.installment_total || 1)));
  const current = Math.max(1, Math.min(total, Number(tx.installment_index || input.installment_index || 1)));
  const shouldProject = tx.type === 'expense' && tx.payment_method === 'credit_card' && total > current;
  const group = tx.installment_group || (shouldProject ? randomBytes(8).toString('hex') : null);
  let created = 0;

  for (let index = current; index <= total; index++) {
    const date = monthAdd(tx.date, index - current);
    const projectedNotes = index === current ? tx.notes : [tx.notes, 'Parcela futura prevista a partir da fatura.'].filter(Boolean).join(' ');
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
    await statements.addCategory.run(userId, tx.category, tx.type);
    created += 1;
  }

  return created;
}

async function createTransactionRows(userId, input) {
  const tx = normalizeTransaction(input);
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

async function dashboard(userId, selectedMonth = null) {
  const transactions = await statements.listTransactions.all(userId);
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const activeMonth = selectedMonth || thisMonth;
  const monthRows = {};
  const categories = {};
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
      }
    }
  }

  const months = Object.values(monthRows).sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
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
    months,
    forecast
  };
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

function parseInvoiceText(text, fallbackMonth) {
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
  if (!boundary) throw new Error('Upload invalido.');
  const body = await readBody(req);
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
      paid_until: user.paid_until
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
    if (secret && req.headers['x-cf-webhook-secret'] !== secret) return sendJson(res, 401, { error: 'Webhook nao autorizado.' });
    const payload = await readJson(req);
    const order = orderFromWebhook(payload);
    await statements.insertSalesOrder.run('mercado_livre', order.externalId, order.buyerEmail, order.buyerName, order.status, order.amount, JSON.stringify(payload));
    return sendJson(res, 200, { ok: true });
  }

  const user = await requireUser(req, res);
  if (!user) return;

  if (route(req.method, pathname, 'GET', '/api/me')) return sendJson(res, 200, user);
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
    const tx = normalizeTransaction(await readJson(req));
    await statements.updateTransaction.run(tx.type, tx.date, tx.description, tx.category, tx.amount, tx.payment_method, tx.card_id, tx.invoice_id, tx.installment_group, tx.installment_index, tx.installment_total, tx.notes, id, user.id);
    await statements.addCategory.run(user.id, tx.category, tx.type);
    return sendJson(res, 200, { ok: true });
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
    return sendJson(res, 200, { ok: true, deleted_transactions: txDirect + txProjected });
  }
  if (route(req.method, pathname, 'POST', '/api/invoices/upload')) {
    const { fields, files } = await parseMultipart(req);
    const file = files.pdf;
    if (!file || !file.filename.toLowerCase().endsWith('.pdf')) return sendJson(res, 400, { error: 'Anexe uma fatura em PDF.' });
    const month = fields.month || new Date().toISOString().slice(0, 7);
    const stored = `${Date.now()}-${createHash('sha1').update(file.filename).digest('hex')}.pdf`;
    const filePath = join(uploadDir, stored);
    writeFileSync(filePath, file.buffer);
    const text = await extractPdfText(filePath);
    const parsed = parseInvoiceText(text, month);
    const invoice = await statements.insertInvoice.run(user.id, fields.card_id ? Number(fields.card_id) : null, month, file.filename, stored, parsed.total);
    return sendJson(res, 201, { invoice_id: invoice.lastInsertRowid, total: parsed.total, rows: parsed.rows, extracted_chars: text.length });
  }
  if (route(req.method, pathname, 'POST', '/api/invoices/import')) {
    const body = await readJson(req);
    const invoiceId = Number(body.invoice_id);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    let created = 0;
    for (const row of rows) {
      created += await createInvoiceRows(user.id, { ...row, invoice_id: invoiceId, card_id: body.card_id || row.card_id, payment_method: 'credit_card' });
    }
    return sendJson(res, 201, { created });
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
    sendJson(res, 500, { error: error.message || 'Erro interno.' });
  }
});

const port = Number(process.env.PORT || 3060);
server.listen(port, () => {
  console.log(`Controle financeiro rodando em http://localhost:${port}`);
});

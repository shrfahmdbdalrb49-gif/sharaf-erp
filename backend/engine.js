/* ============================================================
   engine.js — محرك المحاسبة مزدوجة القيد + المخزون FEFO (خادمي)
   كل العمليات تمر عبر معاملات SQL مع قفل صفّي للدفعات
   (يمنع بيع نفس الوحدة مرتين من فرعين متزامنين)
   ============================================================ */
const { query, pool, getClient, nextSequence } = require('./db')

/* ---------- أكواد الحسابات النظامية ---------- */
const SYS_ACCOUNTS = {
  cash: '1-1-1', bank: '1-1-2', receivables: '1-2', inventory: '1-3',
  payables: '2-1', equity: '3-1', salesRevenue: '4-1',
  salesReturns: '4-2', cogs: '5-1', operatingExpenses: '5-2',
}

/* توحيد: يقبل runner = object {query} أو دالة query(text,params) */
function runnerQuery(clientOrGlobal) {
  if (!clientOrGlobal) return query
  if (typeof clientOrGlobal.query === 'function') return clientOrGlobal.query.bind(clientOrGlobal)
  if (typeof clientOrGlobal === 'function') return clientOrGlobal
  throw new Error('runner غير صالح')
}
async function sysAccounts(clientOrGlobal) {
  const q = runnerQuery(clientOrGlobal)
  const result = await q(`SELECT id, code FROM chart_of_accounts WHERE active = true`)
  const rows = result.rows
  const get = (code) => {
    const a = rows.find(x => x.code === code)
    if (!a) throw new Error(`حساب النظام غير موجود: ${code}`)
    return a.id
  }
  return {
    cash: get(SYS_ACCOUNTS.cash), bank: get(SYS_ACCOUNTS.bank),
    receivables: get(SYS_ACCOUNTS.receivables), inventory: get(SYS_ACCOUNTS.inventory),
    payables: get(SYS_ACCOUNTS.payables), equity: get(SYS_ACCOUNTS.equity),
    salesRevenue: get(SYS_ACCOUNTS.salesRevenue), salesReturns: get(SYS_ACCOUNTS.salesReturns),
    cogs: get(SYS_ACCOUNTS.cogs), operatingExpenses: get(SYS_ACCOUNTS.operatingExpenses),
  }
}

/* ---------- التحقق من التوازن ---------- */
function balanceCheck(lines) {
  const debit = lines.reduce((s, l) => s + Number(l.debit || 0), 0)
  const credit = lines.reduce((s, l) => s + Number(l.credit || 0), 0)
  if (Math.abs(debit - credit) > 0.005) {
    throw new Error(`القيد غير متوازن: مدين ${debit.toFixed(2)} / دائن ${credit.toFixed(2)}`)
  }
  if (lines.length < 2) throw new Error('القيد يتطلب سطرين على الأقل')
  for (const l of lines) {
    if (!l.accountId) throw new Error('سطر قيد بدون حساب')
    const d = Number(l.debit || 0), c = Number(l.credit || 0)
    if (d < 0 || c < 0) throw new Error('قيم سالبة غير مسموحة')
    if (d === 0 && c === 0) throw new Error('سطر بقيمة صفرية')
  }
  return { debit, credit }
}

/* ---------- نشر قيد مزدوج (عبر transaction) ---------- */
async function postJournalEntry({ client, date, description, refKind, refId, lines, createdBy }) {
  const { debit, credit } = balanceCheck(lines)
  const entryNo = await nextSequence('nextJournalEntryNo')
  const r = await client.query(
    `INSERT INTO journal_entries (entry_no, entry_date, description, ref_kind, ref_id, posted, total_debit, total_credit, created_by)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8) RETURNING id`,
    [entryNo, date || new Date().toISOString().slice(0, 10), description || '', refKind || null, refId || null, debit, credit, createdBy || null]
  )
  const entryId = r.rows[0].id
  if (lines.length) {
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_id, description, debit, credit)
       SELECT $1, l.account_id, l.description, l.debit, l.credit
       FROM UNNEST($2::int[], $3::text[], $4::numeric[], $5::numeric[]) AS l(account_id, description, debit, credit)`,
      [entryId, lines.map(l => l.accountId), lines.map(l => l.description || null), lines.map(l => Number(l.debit || 0)), lines.map(l => Number(l.credit || 0))]
    )
  }
  return entryId
}

/* ---------- قيد شراء: مخزون ← ذمم/صندوق ---------- */
async function postPurchaseJournal({ client, purchaseId, total, paymentType, createdBy }) {
  const sys = await sysAccounts(client)
  const lines = [{ accountId: sys.inventory, debit: total }]
  if (paymentType === 'cash') lines.push({ accountId: sys.cash, credit: total })
  else if (paymentType === 'bank') lines.push({ accountId: sys.bank, credit: total })
  else lines.push({ accountId: sys.payables, credit: total })
  return postJournalEntry({ client, description: `قيد شراء #${purchaseId}`, refKind: 'purchase', refId: purchaseId, lines, createdBy })
}

/* ---------- قيد بيع: صندوق/ذمم ← إيرادات + تكلفة ← مخزون ---------- */
async function postSaleJournal({ client, saleId, total, paid, customerPaid, cogsAmount, createdBy }) {
  const sys = await sysAccounts(client)
  const onCredit = Math.max(0, Number(total || 0) - Number(paid || 0))
  const lines = []
  if (Number(paid || 0) > 0) {
    if (customerPaid === 'bank') lines.push({ accountId: sys.bank, debit: paid })
    else lines.push({ accountId: sys.cash, debit: paid })
  }
  if (onCredit > 0) lines.push({ accountId: sys.receivables, debit: onCredit })
  lines.push({ accountId: sys.salesRevenue, credit: total })
  if (Number(cogsAmount || 0) > 0) {
    lines.push({ accountId: sys.cogs, debit: cogsAmount })
    lines.push({ accountId: sys.inventory, credit: cogsAmount })
  }
  return postJournalEntry({ client, description: `قيد بيع #${saleId}`, refKind: 'sale', refId: saleId, lines, createdBy })
}

/* ---------- قيد تحصيل ---------- */
async function postCollectionJournal({ client, collectionId, amount, method, createdBy }) {
  const sys = await sysAccounts(client)
  const lines = [
    { accountId: method === 'bank' ? sys.bank : sys.cash, debit: amount },
    { accountId: sys.receivables, credit: amount },
  ]
  return postJournalEntry({ client, description: `قيد تحصيل #${collectionId}`, refKind: 'collection', refId: collectionId, lines, createdBy })
}

/* ---------- قيد مرتجع ---------- */
async function postReturnJournal({ client, returnId, total, refundMethod, createdBy }) {
  const sys = await sysAccounts(client)
  const lines = [
    { accountId: sys.salesReturns, debit: total },
    { accountId: refundMethod === 'cash' ? sys.cash : refundMethod === 'bank' ? sys.bank : sys.receivables, credit: total },
  ]
  return postJournalEntry({ client, description: `قيد مرتجع #${returnId}`, refKind: 'saleReturn', refId: returnId, lines, createdBy })
}

/* ---------- قيد سداد مورد ---------- */
async function postSupplierPaymentJournal({ client, paymentId, amount, method, createdBy, operationType, accountKey }) {
  const sys = await sysAccounts(client)
  if (operationType === 'expense' && accountKey) {
    const acc = await client.query(`SELECT id FROM chart_of_accounts WHERE code = $1 AND active`, [accountKey])
    if (!acc.rows.length) throw new Error(`حساب المصاريف ${accountKey} غير موجود`)
    const lines = [
      { accountId: acc.rows[0].id, debit: amount },
      { accountId: method === 'bank' ? sys.bank : sys.cash, credit: amount },
    ]
    return postJournalEntry({ client, description: `قيد مصروفات #${paymentId}`, refKind: 'supplierPayment', refId: paymentId, lines, createdBy })
  }
  const lines = [
    { accountId: sys.payables, debit: amount },
    { accountId: method === 'bank' ? sys.bank : sys.cash, credit: amount },
  ]
  return postJournalEntry({ client, description: `قيد سداد مورد #${paymentId}`, refKind: 'supplierPayment', refId: paymentId, lines, createdBy })
}

/* ---------- قيد يدوي ---------- */
async function postManualJournal({ client, date, description, lines, createdBy }) {
  return postJournalEntry({ client, date, description, refKind: 'manual', refId: null, lines, createdBy })
}

/* ---------- قيد افتتاحي ---------- */
async function postOpeningJournal({ client, date, description, lines, createdBy }) {
  return postJournalEntry({ client, date, description, refKind: 'opening', refId: null, lines, createdBy })
}

/* ---------- المخزون: إضافة تشغيلة + حركة in (مع قفل على صفوف الصنف) ---------- */
async function addBatch({ client, itemId, storeId, batchNo, mfgDate, expDate, qty, cost, sourceKind, sourceId, userId }) {
  if (!qty || qty <= 0) throw new Error('كمية غير صحيحة')
  // قفل تنافسي: منع بيع/خصم متزامن من نفس الصنف لحظة الاستلام
  await client.query(`SELECT id FROM items WHERE id = $1 FOR UPDATE`, [itemId])
  await client.query(`SELECT id FROM stores WHERE id = $1 FOR UPDATE`, [storeId])
  const r = await client.query(
    `INSERT INTO batches (item_id, store_id, batch_no, mfg_date, exp_date, qty, cost, source_kind, source_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [itemId, storeId, batchNo || '', mfgDate || null, expDate || null, Number(qty), Number(cost || 0), sourceKind || 'purchase', sourceId || null]
  )
  await client.query(
    `INSERT INTO stock_movements (item_id, batch_id, kind, qty, ref_kind, ref_id, user_id)
     VALUES ($1, $2, 'in', $3, $4, $5, $6)`,
    [itemId, r.rows[0].id, Number(qty), sourceKind || 'purchase', sourceId || null, userId || null]
  )
  return r.rows[0].id
}

/* ---------- قراءة مخزون صنف: الدفعات الصالحة بترتيب FEFO ---------- */
async function itemStock(client, itemId) {
  const r = await runnerQuery(client)(
    `SELECT id, item_id, store_id, batch_no, mfg_date, exp_date, qty, cost
     FROM batches WHERE item_id = $1 AND NOT quarantined AND qty > 0
     ORDER BY exp_date NULLS LAST, cost ASC`,
    [itemId]
  )
  const batches = r.rows
  const total = batches.reduce((s, b) => s + Number(b.qty), 0)
  const totalCost = batches.reduce((s, b) => s + Number(b.qty) * Number(b.cost || 0), 0)
  return { batches, total, avgCost: total > 0 ? totalCost / total : 0 }
}

/* ---------- صرف من المخزون FEFO مع قفل صفّي على الدفعات ---------- */
async function consumeStock({ client, itemId, qty, refKind, refId, userId }) {
  // قفل جميع دفعات الصنف غير المُعلَّمة لمنع التنافس
  const r = await client.query(
    `SELECT id, qty, cost, exp_date FROM batches
     WHERE item_id = $1 AND NOT quarantined AND qty > 0
     ORDER BY exp_date NULLS LAST, cost ASC
     FOR UPDATE`,
    [itemId]
  )
  let remaining = Number(qty)
  const consumed = []
  for (const b of r.rows) {
    if (remaining <= 0) break
    const take = Math.min(Number(b.qty), remaining)
    consumed.push({ batchId: b.id, qty: take, cost: Number(b.cost || 0) })
    await client.query(`UPDATE batches SET qty = qty - $1 WHERE id = $2`, [take, b.id])
    await client.query(
      `INSERT INTO stock_movements (item_id, batch_id, kind, qty, ref_kind, ref_id, user_id)
       VALUES ($1, $2, 'out', $3, $4, $5, $6)`,
      [itemId, b.id, take, refKind || 'sale', refId || null, userId || null]
    )
    remaining -= take
  }
  if (remaining > 0) throw new Error(`مخزون غير كافٍ للصنف #${itemId}: المتاح أقل من المطلوب بـ ${remaining}`)
  return consumed
}

/* ---------- حساب تكلفة المبيعات prospective (دون خصم فعلي) ---------- */
async function computeCOGS(client, itemId, qty) {
    const { batches } = await itemStock(runnerQuery(client), itemId)
  let remaining = Number(qty), cogs = 0
  for (const b of batches) {
    if (remaining <= 0) break
    const take = Math.min(Number(b.qty), remaining)
    cogs += take * Number(b.cost || 0)
    remaining -= take
  }
  return { cogs, available: batches.reduce((s, b) => s + Number(b.qty), 0) }
}

/* ---------- سجل التدقيق ---------- */
async function audit({ client, userId, username, action, refKind, refId, details, ip }) {
  await client.query(
    `INSERT INTO audit_logs (user_id, username, action, ref_kind, ref_id, details, client_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId || null, username || null, action, refKind || null, refId || null,
     details != null && typeof details === 'object' ? JSON.stringify(details) : details != null ? String(details) : null,
     ip || null]
  )
}

/* ---------- سجل التدقيق بدون transaction (للاستخدام العام) ---------- */
async function auditGlobal({ userId, username, action, refKind, refId, details, ip }) {
  const client = { query: (t, p) => pool.query(t, p) }
  return audit({ client, userId, username, action, refKind, refId, details, ip })
}

/* ---------- إلغاء فاتورة بيع: عكس القيود وعودة المخزون وذمم العميل ---------- */
async function cancelSale({ client, saleId, userId, username }) {
  const r = await client.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [saleId])
  if (!r.rows[0]) throw new Error('فاتورة البيع غير موجودة')
  const sale = r.rows[0]
  if (String(sale.status) === 'cancelled') throw new Error('الفاتورة ملغاة مسبقًا')
  const entry = await client.query(`SELECT id FROM journal_entries WHERE ref_kind = 'sale' AND ref_id = $1`, [saleId])
  if (entry.rows[0]) {
    await client.query('DELETE FROM journal_lines WHERE entry_id = $1', [entry.rows[0].id])
    await client.query('DELETE FROM journal_entries WHERE id = $1', [entry.rows[0].id])
  }
  // عودة المخزون: حذف حركات البيع ثم إعادة الكميات للدفعات المحسومة
  const movements = await client.query(`SELECT * FROM stock_movements WHERE ref_kind = 'sale' AND ref_id = $1`, [saleId])
  const byBatch = {}
  for (const m of movements.rows) byBatch[m.batch_id] = (byBatch[m.batch_id] || 0) + Number(m.qty)
  for (const [batchId, qty] of Object.entries(byBatch)) {
    await client.query(`UPDATE batches SET qty = qty + $1 WHERE id = $2`, [qty, Number(batchId)])
  }
  await client.query(`DELETE FROM stock_movements WHERE ref_kind = 'sale' AND ref_id = $1`, [saleId])
  await client.query(`UPDATE sales SET status = 'cancelled' WHERE id = $1`, [saleId])
  await audit({ client, userId, username, action: 'sale_cancelled', refKind: 'sale', refId: saleId, details: { invoiceNo: sale.invoice_no } })
}

/* ---------- إلغاء فاتورة شراء: عكس القيود وعودة المخزون وذمم المورد ---------- */
async function cancelPurchase({ client, purchaseId, userId, username }) {
  const r = await client.query(`SELECT * FROM purchase_invoices WHERE id = $1 FOR UPDATE`, [purchaseId])
  if (!r.rows[0]) throw new Error('فاتورة الشراء غير موجودة')
  const p = r.rows[0]
  if (String(p.status) === 'cancelled') throw new Error('الفاتورة ملغاة مسبقًا')
  const entry = await client.query(`SELECT id FROM journal_entries WHERE ref_kind = 'purchase' AND ref_id = $1`, [purchaseId])
  if (entry.rows[0]) {
    await client.query('DELETE FROM journal_lines WHERE entry_id = $1', [entry.rows[0].id])
    await client.query('DELETE FROM journal_entries WHERE id = $1', [entry.rows[0].id])
  }
  const movements = await client.query(`SELECT * FROM stock_movements WHERE ref_kind = 'purchase' AND ref_id = $1`, [purchaseId])
  const byBatch = {}
  for (const m of movements.rows) byBatch[m.batch_id] = (byBatch[m.batch_id] || 0) + Number(m.qty)
  for (const [batchId, qty] of Object.entries(byBatch)) {
    await client.query(`UPDATE batches SET qty = qty - $1 WHERE id = $2`, [qty, Number(batchId)])
  }
  await client.query(`DELETE FROM stock_movements WHERE ref_kind = 'purchase' AND ref_id = $1`, [purchaseId])
  await client.query(`UPDATE purchase_invoices SET status = 'cancelled' WHERE id = $1`, [purchaseId])
  await audit({ client, userId, username, action: 'purchase_cancelled', refKind: 'purchase', refId: purchaseId, details: { invoiceNo: p.invoice_no } })
}

/* ============================================================
   دورة حياة فواتير الشراء: مسودة ← استلام ← ترحيل ← إلغاء
   مسودة: إدراج فقط بلا حركات بلا قيود
   استلام: حركات مخزون FEFO (دفعات) فقط — بلا قيود
   ترحيل: القيد المحاسبي المزدوج فقط (المخزون استُلم أصلًا)
   ============================================================ */
async function nextPurchaseNo(client) {
  const s = await client.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_no FROM '(\\d+)$') AS INTEGER)), 0) AS seq
     FROM purchase_invoices WHERE invoice_no LIKE 'PO-%'`)
  return `PO-${String(Number(s.rows[0].seq) + 1).padStart(6, '0')}`
}

/* إنشاء مسودة: إدراج الفاتورة وبنودها فقط — لا مخزون ولا قيود */
async function createPurchaseDraft({ client, supplierId, storeId, invoiceDate, lines, discount, tax, paymentType, paidAmount, notes, invoiceNo, createdBy }) {
  const total = lines.reduce((s, l) => s + Number(l.subtotal || 0), 0)
  const docNo = invoiceNo || await nextPurchaseNo(client)
  const inv = await client.query(
    `INSERT INTO purchase_invoices (invoice_no, supplier_id, branch_id, store_id, invoice_date, subtotal, discount, tax, total, payment_type, paid_amount, status, notes, created_by)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11, $12) RETURNING *`,
    [docNo, Number(supplierId), Number(storeId), invoiceDate || new Date().toISOString().slice(0, 10),
     total - Number(discount || 0), Number(discount || 0), Number(tax || 0), total,
     paymentType || 'credit', Number(paidAmount || 0), notes || null, createdBy || null]
  )
  const invoice = inv.rows[0]
  const insertedLines = []
  for (const l of lines) {
    if (!l.itemId || !l.qty || Number(l.qty) <= 0) throw new Error('بنود الفاتورة غير صالحة')
    const lineTotal = Number(l.qty) * Number(l.unitCost || 0) - Number(l.discount || 0) + Number(l.tax || 0)
    const r = await client.query(
      `INSERT INTO purchase_lines (invoice_id, item_id, batch_id, qty, bonus, unit_cost, discount, tax, subtotal, expiry_date)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9) RETURNING id, item_id, qty, unit_cost, discount, tax, subtotal, expiry_date`,
      [invoice.id, Number(l.itemId), Number(l.qty), Number(l.bonus || 0), Number(l.unitCost || 0), Number(l.discount || 0), Number(l.tax || 0), lineTotal, l.expiryDate || null]
    )
    insertedLines.push(r.rows[0])
  }
  return { invoice, lines: insertedLines }
}

/* استلام مسودة: حركات مخزون FEFO (دفعات) فقط — بلا قيود */
async function receivePurchase({ client, purchaseId, userId, username }) {
  const r = await client.query(`SELECT * FROM purchase_invoices WHERE id = $1 FOR UPDATE`, [purchaseId])
  const p = r.rows[0]
  if (!p) throw new Error('الفاتورة غير موجودة')
  if (String(p.status) === 'cancelled') throw new Error('الفاتورة ملغاة')
  if (String(p.status) !== 'draft') throw new Error(`لا يمكن الاستلام: الحالة الحالية ${p.status}`)
  const lines = await client.query(
    `SELECT pl.*, i.name AS item_name FROM purchase_lines pl
     JOIN items i ON i.id = pl.item_id WHERE pl.invoice_id = $1`, [purchaseId]
  )
  if (!lines.rows.length) throw new Error('الفاتورة بلا بنود')
  for (const l of lines.rows) {
    const batchId = await addBatch({
      client, itemId: l.item_id, storeId: Number(p.store_id),
      batchNo: `PO-${p.id}-${l.id}`, mfgDate: null, expDate: l.expiry_date || null,
      qty: Number(l.qty) + Number(l.bonus || 0), cost: Number(l.unit_cost || 0), sourceKind: 'purchase', sourceId: purchaseId, userId,
    })
    await client.query(`UPDATE purchase_lines SET batch_id = $1 WHERE id = $2`, [batchId, l.id])
  }
  await client.query(`UPDATE purchase_invoices SET status = 'received' WHERE id = $1`, [purchaseId])
  await audit({ client, userId, username, action: 'purchase_received', refKind: 'purchase', refId: purchaseId, details: { invoiceNo: p.invoice_no, total: p.total } })
  return { status: 'received' }
}

/* ترحيل فاتورة مستلمة: القيد المحاسبي المزدوج فقط (المخزون استُلم أصلًا) */
async function postPurchase({ client, purchaseId, userId, username }) {
  const r = await client.query(`SELECT * FROM purchase_invoices WHERE id = $1 FOR UPDATE`, [purchaseId])
  const p = r.rows[0]
  if (!p) throw new Error('الفاتورة غير موجودة')
  if (String(p.status) === 'cancelled') throw new Error('الفاتورة ملغاة')
  if (String(p.status) !== 'received') throw new Error(`الترحيل يتطلب الاستلام المسبق: الحالة الحالية ${p.status}`)
  const existing = await client.query(`SELECT id FROM journal_entries WHERE ref_kind = 'purchase' AND ref_id = $1`, [purchaseId])
  if (existing.rows[0]) throw new Error('الفاتورة مرحّلة مسبقًا')
  // الإجمالي الفعلي = مجموع سطور الفاتورة (المسودات تُخزَّن بلا إجمالي مسبق)
  const linesSum = await client.query(`SELECT COALESCE(SUM(subtotal), 0) AS total FROM purchase_lines WHERE invoice_id = $1`, [purchaseId])
  const total = Number(linesSum.rows[0].total)
  if (total <= 0) throw new Error('الفاتورة بلا قيمة صالحة')
  await client.query(`UPDATE purchase_invoices SET total = $1, subtotal = $1, status = 'posted' WHERE id = $2`, [total, purchaseId])
  await postPurchaseJournal({ client, purchaseId, total, paymentType: p.payment_type, createdBy: userId })
  await audit({ client, userId, username, action: 'purchase_posted', refKind: 'purchase', refId: purchaseId, details: { invoiceNo: p.invoice_no, total } })
  return { status: 'posted' }
}

/* إلغاء استلام فاتورة مستلمة (لم تُرحَّل بعد): يعكس حركات المخزون فقط */
async function unreceivePurchase({ client, purchaseId, userId, username }) {
  const r = await client.query(`SELECT * FROM purchase_invoices WHERE id = $1 FOR UPDATE`, [purchaseId])
  const p = r.rows[0]
  if (!p) throw new Error('الفاتورة غير موجودة')
  if (String(p.status) === 'cancelled') throw new Error('الفاتورة ملغاة')
  if (String(p.status) !== 'received') throw new Error(`يمكن إلغاء الاستلام للحالة received فقط: الحالية ${p.status}`)
  const movements = await client.query(`SELECT * FROM stock_movements WHERE ref_kind = 'purchase' AND ref_id = $1`, [purchaseId])
  const byBatch = {}
  for (const m of movements.rows) byBatch[m.batch_id] = (byBatch[m.batch_id] || 0) + Number(m.qty)
  for (const [batchId, qty] of Object.entries(byBatch)) {
    const bb = await client.query(`SELECT id, qty FROM batches WHERE id = $1 FOR UPDATE`, [batchId])
    if (!bb.rows[0]) throw new Error(`دفعة غير موجودة #${batchId}`)
    if (Number(bb.rows[0].qty) < qty) {
      throw new Error(`لا يمكن إلغاء الاستلام: كمية الدفعة #${batchId} المتبقية أقل من الكمية المستلمة (${qty}) — قد تكون جزء منها مبيعًا`)
    }
    await client.query(`UPDATE batches SET qty = qty - $1 WHERE id = $2`, [qty, batchId])
  }
  await client.query(`DELETE FROM stock_movements WHERE ref_kind = 'purchase' AND ref_id = $1`, [purchaseId])
  await client.query(`UPDATE purchase_lines SET batch_id = NULL WHERE invoice_id = $1`, [purchaseId])
  await client.query(`UPDATE purchase_invoices SET status = 'draft' WHERE id = $1`, [purchaseId])
  await audit({ client, userId, username, action: 'purchase_unreceived', refKind: 'purchase', refId: purchaseId, details: { invoiceNo: p.invoice_no } })
  return { status: 'draft' }
}

module.exports = {
  sysAccounts, postJournalEntry, postPurchaseJournal, postSaleJournal,
  postCollectionJournal, postReturnJournal, postSupplierPaymentJournal,
  postManualJournal, postOpeningJournal,
  addBatch, itemStock, consumeStock, computeCOGS, audit, auditGlobal,
  cancelSale, cancelPurchase,
  createPurchaseDraft, receivePurchase, postPurchase, unreceivePurchase, nextPurchaseNo,
}

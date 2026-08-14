/* routes/invoices.js — المشتريات، المبيعات، المرتجعات، التحصيل، سداد الموردين */
const { Router } = require('express')
const { authenticate, requirePermission } = require('../auth')
const { query, pool } = require('../db')
const engine = require('../engine')

const router = Router()
router.use(authenticate)

const DEFAULT_STORE = 1

/* ============================================================
   المشتريات
   ============================================================ */
router.get('/sales-lines', async (req, res, next) => {
  try {
    const r = await query(`SELECT sl.*, i.name AS item_name FROM sales_lines sl
      JOIN items i ON i.id = sl.item_id ORDER BY sl.id DESC LIMIT 1000`)
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.get('/purchases-lines', async (req, res, next) => {
  try {
    const r = await query(`SELECT pl.*, i.name AS item_name FROM purchase_lines pl
      JOIN items i ON i.id = pl.item_id ORDER BY pl.id DESC LIMIT 1000`)
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.get('/transfers', async (req, res, next) => {
  try {
    const r = await query(`SELECT t.*, i.name AS item_name FROM transfers t
      LEFT JOIN items i ON i.id = t.item_id ORDER BY t.id DESC LIMIT 200`)
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.get('/purchases', async (req, res, next) => {
  try {
    const { status, supplierId, dateFrom, dateTo } = req.query
    let sql = `SELECT pi.*, s.name AS supplier_name FROM purchase_invoices pi
       JOIN suppliers s ON s.id = pi.supplier_id WHERE 1=1`
    const params = []
    if (status) { params.push(status); sql += ` AND pi.status = $${params.length}` }
    if (supplierId) { params.push(Number(supplierId)); sql += ` AND pi.supplier_id = $${params.length}` }
    if (dateFrom) { params.push(dateFrom); sql += ` AND pi.invoice_date >= $${params.length}` }
    if (dateTo) { params.push(dateTo); sql += ` AND pi.invoice_date <= $${params.length}` }
    sql += ` ORDER BY pi.id DESC LIMIT 500`
    const r = await query(sql, params)
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.get('/purchases/:id', async (req, res, next) => {
  try {
    const r = await query(`SELECT * FROM purchase_invoices WHERE id = $1`, [Number(req.params.id)])
    if (!r.rows[0]) return res.status(404).json({ error: 'الفاتورة غير موجودة' })
    const lines = await query(
      `SELECT pl.*, i.name AS item_name FROM purchase_lines pl
       JOIN items i ON i.id = pl.item_id WHERE pl.invoice_id = $1`, [Number(req.params.id)]
    )
    res.json({ invoice: r.rows[0], lines })
  } catch (e) { next(e) }
})

/* إنشاء فاتورة شراء → دفعات + حركات + قيد مزدوج (transaction كامل) */
router.post('/purchases', requirePermission('purchases.write'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { supplierId, invoiceDate, lines, discount, tax, paymentType, paidAmount, notes } = req.body
    if (!supplierId || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'المورد وبنود الفاتورة مطلوبة' })
    }
    await client.query('BEGIN')
    const total = lines.reduce((s, l) => s + Number(l.subtotal || 0), 0)

    const invoiceNo = await engine.nextPurchaseNo(client)
    const inv = await client.query(
      `INSERT INTO purchase_invoices (invoice_no, supplier_id, branch_id, store_id, invoice_date, subtotal, discount, tax, total, payment_type, paid_amount, notes, created_by)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [invoiceNo, Number(supplierId), DEFAULT_STORE, invoiceDate || new Date().toISOString().slice(0, 10),
       total - Number(discount || 0), Number(discount || 0), Number(tax || 0), total,
       paymentType || 'credit', Number(paidAmount || 0), notes || null, req.user.id]
    )
    const invoice = inv.rows[0]
    for (const l of lines) {
      if (!l.itemId || !l.qty || Number(l.qty) <= 0) throw new Error('بنود الفاتورة غير صالحة')
      const lineTotal = Number(l.qty) * Number(l.unitCost || 0) - Number(l.discount || 0) + Number(l.tax || 0)
      const batchId = await engine.addBatch({
        client, itemId: Number(l.itemId), storeId: DEFAULT_STORE,
        batchNo: l.batchNo || `PO-${invoice.id}`, mfgDate: l.mfgDate || null, expDate: l.expiryDate || null,
        qty: Number(l.qty) + Number(l.bonus || 0), cost: Number(l.unitCost || 0), sourceKind: 'purchase', sourceId: invoice.id, userId: req.user.id,
      })
      await client.query(
        `INSERT INTO purchase_lines (invoice_id, item_id, batch_id, qty, bonus, unit_cost, discount, tax, subtotal, expiry_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [invoice.id, Number(l.itemId), batchId, Number(l.qty), Number(l.bonus || 0), Number(l.unitCost || 0), Number(l.discount || 0), Number(l.tax || 0), lineTotal, l.expiryDate || null]
      )
    }
    await engine.postPurchaseJournal({ client, purchaseId: invoice.id, total, paymentType: paymentType || 'credit', createdBy: req.user.id })
    await engine.audit({ client, userId: req.user.id, username: req.user.username, action: 'purchase_posted', refKind: 'purchase', refId: invoice.id, details: { total } })
    await client.query('COMMIT')
    res.status(201).json({ invoice, success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message && /غير متوازن|غير كافٍ|غير صحيحة/.test(e.message)) return res.status(400).json({ error: e.message })
    next(e)
  } finally {
    client.release()
  }
})

/* ============================================================
   المبيعات (POS)
   ============================================================ */
router.get('/sales', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT si.*, c.name AS customer_name FROM sales_invoices si
       LEFT JOIN customers c ON c.id = si.customer_id
       ORDER BY si.id DESC LIMIT 200`
    )
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.get('/sales/:id', async (req, res, next) => {
  try {
    const r = await query(`SELECT * FROM sales_invoices WHERE id = $1`, [Number(req.params.id)])
    if (!r.rows[0]) return res.status(404).json({ error: 'الفاتورة غير موجودة' })
    const lines = await query(
      `SELECT sl.*, i.name AS item_name FROM sales_lines sl
       JOIN items i ON i.id = sl.item_id WHERE sl.invoice_id = $1`, [Number(req.params.id)]
    )
    res.json({ invoice: r.rows[0], lines })
  } catch (e) { next(e) }
})

/* بيع: خصم FEFO + قيد مزدوج (transaction كامل مع قفل) */
router.post('/sales', requirePermission('pos.sale'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { customerId, invoiceDate, lines, discount, tax, paymentType, paidAmount, notes } = req.body
    if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'السلة فارغة' })

    await client.query('BEGIN')
    const total = lines.reduce((s, l) => s + Number(l.subtotal || 0), 0)
    if (total <= 0) throw new Error('الإجمالي صفر')
    const paid = paymentType === 'credit' ? 0 : (paidAmount == null ? total : Number(paidAmount))

    const noRes = await client.query(`SELECT COALESCE(MAX(id), 0) + 1 AS next_no FROM sales_invoices`)
    const invoiceNo = `S-${String(noRes.rows[0].next_no).padStart(5, '0')}`
    const inv = await client.query(
      `INSERT INTO sales_invoices (invoice_no, customer_id, branch_id, store_id, invoice_date, subtotal, discount, tax, total, paid_amount, payment_type, notes, created_by)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [invoiceNo, customerId || null, DEFAULT_STORE, invoiceDate || new Date().toISOString().slice(0, 10),
       total - Number(discount || 0), Number(discount || 0), Number(tax || 0), total, paid,
       paymentType || 'cash', notes || null, req.user.id]
    )
    const invoice = inv.rows[0]
    let totalCogs = 0
    for (const l of lines) {
      if (!l.itemId || !l.qty || Number(l.qty) <= 0) throw new Error('بنود الفاتورة غير صالحة')
      const { cogs, available } = await engine.computeCOGS(client, Number(l.itemId), Number(l.qty))
      if (available < Number(l.qty)) throw new Error(`مخزون غير كافٍ: "${l.name || l.itemId}" — المتاح ${available}`)
      const consumed = await engine.consumeStock({ client, itemId: Number(l.itemId), qty: Number(l.qty), refKind: 'sale', refId: invoice.id, userId: req.user.id })
      const subtotal = Number(l.qty) * Number(l.price || 0) - Number(l.discount || 0) + Number(l.tax || 0)
      await client.query(
        `INSERT INTO sales_lines (invoice_id, item_id, batch_ids, qty, price, discount, tax, subtotal, cogs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [invoice.id, Number(l.itemId), consumed.map(c => c.batchId), Number(l.qty), Number(l.price || 0),
         Number(l.discount || 0), Number(l.tax || 0), subtotal, cogs]
      )
      totalCogs += cogs
    }
    await engine.postSaleJournal({ client, saleId: invoice.id, total, paid, customerPaid: paymentType || 'cash', cogsAmount: totalCogs, createdBy: req.user.id })
    await engine.audit({ client, userId: req.user.id, username: req.user.username, action: 'sale_completed', refKind: 'sale', refId: invoice.id, details: { total } })
    await client.query('COMMIT')
    res.status(201).json({ invoice, success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message && /غير متوازن|غير كافٍ|فارغة|صفر/.test(e.message)) return res.status(400).json({ error: e.message })
    next(e)
  } finally {
    client.release()
  }
})

/* ============================================================
   المرتجعات
   ============================================================ */
router.get('/sales-returns', async (req, res, next) => {
  try {
    const r = await query(`SELECT * FROM sales_returns ORDER BY id DESC LIMIT 200`)
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.post('/sales/:id/cancel', requirePermission('pos.sale'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const id = Number(req.params.id)
    await client.query('BEGIN')
    await engine.cancelSale({ client, saleId: id, userId: req.user.id, username: req.user.username })
    await client.query('COMMIT')
    res.status(200).json({ success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message) return res.status(400).json({ error: e.message })
    next(e)
  } finally { client.release() }
})

router.post('/purchases/:id/cancel', requirePermission('purchases.write'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const id = Number(req.params.id)
    await client.query('BEGIN')
    await engine.cancelPurchase({ client, purchaseId: id, userId: req.user.id, username: req.user.username })
    await client.query('COMMIT')
    res.status(200).json({ success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message) return res.status(400).json({ error: e.message })
    next(e)
  } finally { client.release() }
})

/* ---------- دورة الحياة: مسودة ← استلام ← ترحيل ---------- */
router.post('/purchases/draft', requirePermission('purchases.write'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { supplierId, invoiceDate, lines, discount, tax, paymentType, paidAmount, notes } = req.body
    if (!supplierId || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'المورد وبنود الفاتورة مطلوبة' })
    }
    await client.query('BEGIN')
    const result = await engine.createPurchaseDraft({
      client, supplierId, storeId: DEFAULT_STORE, invoiceDate: invoiceDate || new Date().toISOString().slice(0, 10),
      lines, discount: Number(discount || 0), tax: Number(tax || 0), paymentType: paymentType || 'credit',
      paidAmount: Number(paidAmount || 0), notes: notes || null, createdBy: req.user.id,
    })
    await engine.audit({ client, userId: req.user.id, username: req.user.username, action: 'purchase_draft_created', refKind: 'purchase', refId: result.invoice.id, details: { total: result.invoice.total } })
    await client.query('COMMIT')
    res.status(201).json({ success: true, ...result })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message) return res.status(400).json({ error: e.message })
    next(e)
  } finally { client.release() }
})

router.post('/purchases/:id/receive', requirePermission('purchases.write'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const id = Number(req.params.id)
    await client.query('BEGIN')
    const result = await engine.receivePurchase({ client, purchaseId: id, userId: req.user.id, username: req.user.username })
    await client.query('COMMIT')
    res.status(200).json({ success: true, ...result })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message) return res.status(400).json({ error: e.message })
    next(e)
  } finally { client.release() }
})

router.post('/purchases/:id/post', requirePermission('accounting.post'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const id = Number(req.params.id)
    await client.query('BEGIN')
    const result = await engine.postPurchase({ client, purchaseId: id, userId: req.user.id, username: req.user.username })
    await client.query('COMMIT')
    res.status(200).json({ success: true, ...result })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message) return res.status(400).json({ error: e.message })
    next(e)
  } finally { client.release() }
})

router.post('/purchases/:id/unreceive', requirePermission('purchases.write'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const id = Number(req.params.id)
    await client.query('BEGIN')
    const result = await engine.unreceivePurchase({ client, purchaseId: id, userId: req.user.id, username: req.user.username })
    await client.query('COMMIT')
    res.status(200).json({ success: true, ...result })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message) return res.status(400).json({ error: e.message })
    next(e)
  } finally { client.release() }
})

router.post('/sales-returns', requirePermission('sales.write'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { saleInvoiceId, customerId, lines, refundMethod, notes } = req.body
    if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'بنود المرتجع مطلوبة' })
    await client.query('BEGIN')
    let total = 0
    const ret = await client.query(
      `INSERT INTO sales_returns (sale_invoice_id, customer_id, branch_id, total, refund_method, notes, created_by)
       VALUES ($1, $2, 1, 0, $3, $4, $5) RETURNING *`,
      [saleInvoiceId || null, customerId || null, refundMethod || 'cash', notes || null, req.user.id]
    )
    for (const l of lines) {
      if (!l.itemId || !l.qty || Number(l.qty) <= 0) throw new Error('بنود غير صالحة')
      await client.query(
        `INSERT INTO sales_return_lines (return_id, item_id, qty, price, subtotal)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ret.rows[0].id, Number(l.itemId), Number(l.qty), Number(l.price || 0), Number(l.qty) * Number(l.price || 0)]
      )
      total += Number(l.qty) * Number(l.price || 0)
      // إعادة المخزون للدفعة الأصلية إن وجدت، وإلا دفعة جديدة
      if (l.batchId) {
        await client.query(`UPDATE batches SET qty = qty + $1 WHERE id = $2`, [Number(l.qty), Number(l.batchId)])
        await client.query(
          `INSERT INTO stock_movements (item_id, batch_id, kind, qty, ref_kind, ref_id, user_id)
           VALUES ($1, $2, 'return_in', $3, 'saleReturn', $4, $5)`,
          [Number(l.itemId), Number(l.batchId), Number(l.qty), ret.rows[0].id, req.user.id]
        )
      } else {
        await engine.addBatch({ client, itemId: Number(l.itemId), storeId: DEFAULT_STORE, batchNo: `RET-${ret.rows[0].id}`, qty: Number(l.qty), cost: 0, sourceKind: 'return', sourceId: ret.rows[0].id, userId: req.user.id })
      }
    }
    await client.query(`UPDATE sales_returns SET total = $1 WHERE id = $2`, [total, ret.rows[0].id])
    await engine.postReturnJournal({ client, returnId: ret.rows[0].id, total, refundMethod: refundMethod || 'cash', createdBy: req.user.id })
    await engine.audit({ client, userId: req.user.id, username: req.user.username, action: 'return_posted', refKind: 'saleReturn', refId: ret.rows[0].id, details: { total } })
    await client.query('COMMIT')
    const full = await query(`SELECT * FROM sales_returns WHERE id = $1`, [ret.rows[0].id])
    res.status(201).json({ ...(full.rows[0] || ret.rows[0]), success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message && /غير متوازن|غير صالحة/.test(e.message)) return res.status(400).json({ error: e.message })
    next(e)
  } finally {
    client.release()
  }
})

/* ============================================================
   التحصيل من العملاء
   ============================================================ */
router.get('/collections', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT c.*, cu.name AS customer_name FROM collections c
       JOIN customers cu ON cu.id = c.customer_id ORDER BY c.id DESC LIMIT 200`
    )
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.post('/collections', requirePermission('collections'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { customerId, amount, method, collectedDate, referenceNo, notes } = req.body
    if (!customerId || !amount || Number(amount) <= 0) return res.status(400).json({ error: 'العميل والمبلغ مطلوبان وبقيمة صحيحة' })
    await client.query('BEGIN')
    const col = await client.query(
      `INSERT INTO collections (customer_id, amount, method, collected_date, reference_no, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [Number(customerId), Number(amount), method || 'cash', collectedDate || new Date().toISOString().slice(0, 10), referenceNo || null, notes || null, req.user.id]
    )
    await engine.postCollectionJournal({ client, collectionId: col.rows[0].id, amount: Number(amount), method: method || 'cash', createdBy: req.user.id })
    await engine.audit({ client, userId: req.user.id, username: req.user.username, action: 'collection_posted', refKind: 'collection', refId: col.rows[0].id, details: { amount: Number(amount) } })
    await client.query('COMMIT')
    res.status(201).json({ collection: col.rows[0], success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message && /غير متوازن|مطلوبان/.test(e.message)) return res.status(400).json({ error: e.message })
    next(e)
  } finally {
    client.release()
  }
})

/* ============================================================
   سداد الموردين
   ============================================================ */
router.get('/supplier-payments', async (req, res, next) => {
  try {
    const r = await query(`SELECT sp.*, ca.code AS expense_account_code, ca.name AS expense_account_name,
        s.name AS supplier_name FROM supplier_payments sp
        LEFT JOIN chart_of_accounts ca ON ca.id = sp.expense_account_id
        LEFT JOIN suppliers s ON s.id = sp.supplier_id
        ORDER BY sp.id DESC LIMIT 500`)
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.post('/supplier-payments', requirePermission('suppliers.write'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { supplierId, amount, method, paymentDate, referenceNo, notes, operationType, accountKey } = req.body
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'المبلغ مطلوب بقيمة صحيحة' })
    const opType = (operationType === 'expense' && accountKey) ? 'expense' : 'supplier'
    if (opType === 'expense' && (!accountKey || !/^[0-9][0-9-]*$/.test(accountKey))) return res.status(400).json({ error: 'حساب المصاريف غير صالح' })
    if (opType === 'supplier' && !supplierId) return res.status(400).json({ error: 'المورد مطلوب' })
    await client.query('BEGIN')
    let expenseAccountId = null
    if (opType === 'expense') {
      const acc = await client.query(`SELECT id FROM chart_of_accounts WHERE code = $1 AND active`, [accountKey])
      if (!acc.rows.length) return res.status(400).json({ error: `حساب المصاريف ${accountKey} غير موجود` })
      expenseAccountId = acc.rows[0].id
    }
    const pay = await client.query(
      `INSERT INTO supplier_payments (supplier_id, operation_type, expense_account_id, amount, method, payment_date, reference_no, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [opType === 'supplier' ? Number(supplierId) : null, opType, expenseAccountId, Number(amount), method || 'cash', paymentDate || new Date().toISOString().slice(0, 10), referenceNo || null, notes || null, req.user.id]
    )
    await engine.postSupplierPaymentJournal({ client, paymentId: pay.rows[0].id, amount: Number(amount), method: method || 'cash', createdBy: req.user.id, operationType: opType, accountKey: accountKey || null })
    await engine.audit({ client, userId: req.user.id, username: req.user.username, action: 'supplier_payment_posted', refKind: 'supplierPayment', refId: pay.rows[0].id, details: { amount: Number(amount) } })
    await client.query('COMMIT')
    res.status(201).json({ payment: pay.rows[0], success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message && /غير متوازن|مطلوبان/.test(e.message)) return res.status(400).json({ error: e.message })
    next(e)
  } finally {
    client.release()
  }
})

module.exports = router

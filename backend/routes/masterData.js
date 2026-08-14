/* routes/masterData.js — الأصناف، العملاء، الموردون، المخزون */
const { Router } = require('express')
const { authenticate, requirePermission } = require('../auth')
const { query, pool } = require('../db')
const engine = require('../engine')

const router = Router()
router.use(authenticate)

/* ---------- الأصناف ---------- */
router.get('/items', async (req, res, next) => {
  try {
    const status = req.query.status === 'all' ? null : (req.query.status || 'active')
    const r = await query(
      status ? `SELECT * FROM items WHERE status = $1 ORDER BY id DESC` : `SELECT * FROM items ORDER BY id DESC`,
      status ? [status] : []
    )
    /* ربط المخزون ومتوسط التكلفة لكل صنف في طلب واحد */
    const ids = r.rows.map(x => x.id)
    let stocks = []
    if (ids.length) {
      const s = await query(
        `SELECT item_id, COALESCE(SUM(qty), 0) AS total, COALESCE(SUM(qty * cost), 0) / NULLIF(SUM(qty), 0) AS avg_cost
         FROM batches WHERE item_id = ANY($1) GROUP BY item_id`, [ids])
      stocks = s.rows
    }
    const sm = new Map(stocks.map(x => [x.item_id, { stock: Number(x.total), avgCost: x.avg_cost ? Number(x.avg_cost) : null }]))
    res.json(r.rows.map(it => {
      const st = sm.get(it.id) || { stock: 0, avgCost: null }
      return { ...it, stock: st.stock, avgCost: st.avgCost, sellPrice: st.avgCost != null ? Number(Math.round(st.avgCost * 1.3 * 100) / 100) : 0 }
    }))
  } catch (e) { next(e) }
})

router.get('/items/:id', async (req, res, next) => {
  try {
    const r = await query(`SELECT * FROM items WHERE id = $1`, [req.params.id])
    if (!r.rows[0]) return res.status(404).json({ error: 'الصنف غير موجود' })
    const stock = await engine.itemStock(query, Number(req.params.id))
    res.json({ ...r.rows[0], stock: stock.total, avgCost: stock.avgCost, batches: stock.batches })
  } catch (e) { next(e) }
})

router.post('/items', requirePermission('items.write'), async (req, res, next) => {
  try {
    const { name, code, barcode, category, scientific_name, unit, min_stock, note } = req.body
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم الصنف مطلوب' })
    const r = await query(
      `INSERT INTO items (code, name, barcode, category, scientific_name, unit, min_stock, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [code || null, String(name).trim(), barcode || null, category || null, scientific_name || null, unit || 'unit', Number(min_stock || 0), note || null]
    )
    await engine.auditGlobal({ userId: req.user.id, username: req.user.username, action: 'item_created', refKind: 'item', refId: r.rows[0].id, details: { name: r.rows[0].name } })
    res.status(201).json(r.rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: e.constraint === 'idx_items_name' ? 'اسم الصنف موجود مسبقًا' : 'الكود أو الباركود موجود مسبقًا' })
    next(e)
  }
})

router.put('/items/:id', requirePermission('items.write'), async (req, res, next) => {
  try {
    const { name, code, barcode, category, scientific_name, unit, min_stock, note, status } = req.body
    const r = await query(
      `UPDATE items SET name = COALESCE($1, name), code = COALESCE($2, code), barcode = COALESCE($3, barcode),
       category = COALESCE($4, category), scientific_name = COALESCE($5, scientific_name),
       unit = COALESCE($6, unit), min_stock = COALESCE($7, min_stock), note = COALESCE($8, note),
       status = COALESCE($9, status), updated_at = NOW()
       WHERE id = $10 RETURNING *`,
      [name, code, barcode, category, scientific_name, unit, min_stock == null ? null : Number(min_stock), note, status, Number(req.params.id)]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'الصنف غير موجود' })
    await engine.auditGlobal({ userId: req.user.id, username: req.user.username, action: 'item_updated', refKind: 'item', refId: r.rows[0].id })
    res.json(r.rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: e.constraint === 'idx_items_name' ? 'اسم الصنف موجود مسبقًا' : 'الكود أو الباركود موجود مسبقًا' })
    next(e)
  }
})

router.delete('/items/:id', requirePermission('items.write'), async (req, res, next) => {
  try {
    // لا حذف مادي — تعطيل فقط للحفاظ على سلامة القيود والمخزون
    const r = await query(`UPDATE items SET status = 'inactive' WHERE id = $1 RETURNING id`, [Number(req.params.id)])
    if (!r.rows[0]) return res.status(404).json({ error: 'الصنف غير موجود' })
    res.json({ id: r.rows[0].id, status: 'inactive' })
  } catch (e) { next(e) }
})

/* ---------- المخزون: قراءة دفعة / جميع الدفعات / حركات ---------- */
router.get('/batches', async (req, res, next) => {
  try {
    const r = await query(`SELECT * FROM batches WHERE qty > 0 ORDER BY exp_date NULLS LAST, id DESC LIMIT 500`)
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.get('/items/:id/stock', async (req, res, next) => {
  try {
    const stock = await engine.itemStock(query, Number(req.params.id))
    res.json(stock)
  } catch (e) { next(e) }
})

router.get('/stock-movements', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT sm.*, i.name AS item_name, b.batch_no FROM stock_movements sm
       JOIN items i ON i.id = sm.item_id
       JOIN batches b ON b.id = sm.batch_id
       ORDER BY sm.id DESC LIMIT 200`
    )
    res.json(r.rows)
  } catch (e) { next(e) }
})

/* ---------- العملاء ---------- */
router.get('/customers', async (req, res, next) => {
  try {
    const status = req.query.status === 'all' ? null : (req.query.status || 'active')
    const r = await query(
      status ? `SELECT * FROM customers WHERE status = $1 ORDER BY name` : `SELECT * FROM customers ORDER BY name`,
      status ? [status] : []
    )
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.post('/customers', requirePermission('customers'), async (req, res, next) => {
  try {
    const { name, phone, email, credit_limit, address, notes } = req.body
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم العميل مطلوب' })
    const r = await query(
      `INSERT INTO customers (name, phone, email, credit_limit, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [String(name).trim(), phone || null, email || null, Number(credit_limit || 0), address || null, notes || null]
    )
    res.status(201).json(r.rows[0])
  } catch (e) { next(e) }
})

router.put('/customers/:id', requirePermission('customers'), async (req, res, next) => {
  try {
    const { name, phone, email, credit_limit, address, notes, status } = req.body
    const r = await query(
      `UPDATE customers SET name = COALESCE($1, name), phone = COALESCE($2, phone), email = COALESCE($3, email),
       credit_limit = COALESCE($4, credit_limit), address = COALESCE($5, address), notes = COALESCE($6, notes),
       status = COALESCE($7, status) WHERE id = $8 RETURNING *`,
      [name, phone, email, credit_limit == null ? null : Number(credit_limit), address, notes, status, Number(req.params.id)]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'العميل غير موجود' })
    res.json(r.rows[0])
  } catch (e) { next(e) }
})

/* رصيد ذمم عميل */
router.get('/customers/:id/balance', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS balance
       FROM journal_lines l
       JOIN journal_entries je ON je.id = l.entry_id
       JOIN chart_of_accounts ca ON ca.id = l.account_id
       WHERE ca.code = '1-2' AND je.ref_kind = 'sale' AND je.ref_id IS NOT NULL`,
    )
    // مبسط: نستخدم قيد البيع المرتبط بالعميل عبر الفاتورة
    const sales = await query(
      `SELECT COALESCE(SUM(si.total) - SUM(si.paid_amount), 0) AS due
       FROM sales_invoices si WHERE si.customer_id = $1 AND si.status = 'posted'`, [Number(req.params.id)]
    )
    const coll = await query(
      `SELECT COALESCE(SUM(c.amount), 0) AS collected
       FROM collections c WHERE c.customer_id = $1 AND c.status = 'posted'`, [Number(req.params.id)]
    )
    const due = Number(sales.rows[0].due) - Number(coll.rows[0].collected)
    res.json({ customerId: Number(req.params.id), creditSales: Number(sales.rows[0].due), collected: Number(coll.rows[0].collected), due, balance: Math.max(0, due) })
  } catch (e) { next(e) }
})

/* ---------- الموردون ---------- */
router.get('/suppliers', async (req, res, next) => {
  try {
    const status = req.query.status === 'all' ? null : (req.query.status || 'active')
    const r = await query(
      status ? `SELECT * FROM suppliers WHERE status = $1 ORDER BY name` : `SELECT * FROM suppliers ORDER BY name`,
      status ? [status] : []
    )
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.post('/suppliers', requirePermission('suppliers.write'), async (req, res, next) => {
  try {
    const { name, phone, email, tax_number, address, notes } = req.body
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم المورد مطلوب' })
    const r = await query(
      `INSERT INTO suppliers (name, phone, email, tax_number, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [String(name).trim(), phone || null, email || null, tax_number || null, address || null, notes || null]
    )
    res.status(201).json(r.rows[0])
  } catch (e) { next(e) }
})

router.put('/suppliers/:id', requirePermission('suppliers.write'), async (req, res, next) => {
  try {
    const { name, phone, email, tax_number, address, notes, status } = req.body
    const r = await query(
      `UPDATE suppliers SET name = COALESCE($1, name), phone = COALESCE($2, phone), email = COALESCE($3, email),
       tax_number = COALESCE($4, tax_number), address = COALESCE($5, address), notes = COALESCE($6, notes),
       status = COALESCE($7, status) WHERE id = $8 RETURNING *`,
      [name, phone, email, tax_number, address, notes, status, Number(req.params.id)]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'المورد غير موجود' })
    res.json(r.rows[0])
  } catch (e) { next(e) }
})

/* رصيد ذمم مورد */
router.get('/suppliers/:id/balance', async (req, res, next) => {
  try {
    const purch = await query(
      `SELECT COALESCE(SUM(total) - SUM(paid_amount), 0) AS due
       FROM purchase_invoices WHERE supplier_id = $1 AND status = 'posted'`, [Number(req.params.id)]
    )
    const pay = await query(
      `SELECT COALESCE(SUM(amount), 0) AS paid
       FROM supplier_payments WHERE supplier_id = $1 AND status = 'posted'`, [Number(req.params.id)]
    )
    res.json({ supplierId: Number(req.params.id), due: Number(purch.rows[0].due) - Number(pay.rows[0].paid) })
  } catch (e) { next(e) }
})

module.exports = router

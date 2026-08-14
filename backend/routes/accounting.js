/* routes/accounting.js — دليل الحسابات، القيود اليدوية، التقارير المالية */
const { Router } = require('express')
const { authenticate, requirePermission } = require('../auth')
const { query, pool } = require('../db')
const engine = require('../engine')

const router = Router()
router.use(authenticate)

/* ---------- دليل الحسابات ---------- */
router.get('/accounts', async (req, res, next) => {
  try {
    const active = req.query.active === 'false' ? false : true
    const r = await query(`SELECT * FROM chart_of_accounts WHERE active = $1 ORDER BY number`, [active])
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.put('/accounts/:id', requirePermission('accounts.write'), async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const b = req.body || {}
    if (Object.prototype.hasOwnProperty.call(b, 'active')) {
      const r = await query(`UPDATE chart_of_accounts SET active = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, b.active])
      const rec = r.rows[0]
      if (!rec) return res.status(404).json({ error: 'الحساب غير موجود' })
      await engine.audit({ userId: req.user.id, username: req.user.username, action: b.active ? 'account_activated' : 'account_deactivated', refKind: 'account', refId: id })
      return res.status(200).json(rec)
    }
    const name = b.name
    if (name) {
      const r = await query(`UPDATE chart_of_accounts SET name = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, name])
      const rec = r.rows[0]
      if (!rec) return res.status(404).json({ error: 'الحساب غير موجود' })
      await engine.audit({ userId: req.user.id, username: req.user.username, action: 'account_updated', refKind: 'account', refId: id })
      return res.status(200).json(rec)
    }
    res.status(400).json({ error: 'بيانات غير مكتملة' })
  } catch (e) { next(e) }
})

router.get('/accounts/:id', async (req, res, next) => {
  try {
    const acc = await query(`SELECT * FROM chart_of_accounts WHERE id = $1`, [Number(req.params.id)])
    if (!acc.rows[0]) return res.status(404).json({ error: 'الحساب غير موجود' })
    const balance = await accountBalance(Number(req.params.id))
    res.json({ ...acc.rows[0], ...balance })
  } catch (e) { next(e) }
})

router.post('/accounts', requirePermission('accounts.write'), async (req, res, next) => {
  try {
    const { code, number, name, type, level, parentId, openingDebit, openingCredit } = req.body
    if (!code || !name || !type || !level) return res.status(400).json({ error: 'الكود والاسم والنوع والمستوى مطلوبة' })
    if (!['Assets', 'Liabilities', 'Equity', 'Revenue', 'Expense'].includes(type)) {
      return res.status(400).json({ error: 'نوع غير صالح' })
    }
    const r = await query(
      `INSERT INTO chart_of_accounts (code, number, name, type, level, parent_id, opening_debit, opening_credit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [code, number || 0, name, type, Number(level), parentId || null, Number(openingDebit || 0), Number(openingCredit || 0)]
    )
    res.status(201).json(r.rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'الكود أو الرقم موجود مسبقًا' })
    next(e)
  }
})

/* ---------- ميزان المراجعة ---------- */
router.get('/reports/trial-balance', async (req, res, next) => {
  try {
    const accounts = await query(`SELECT * FROM chart_of_accounts WHERE active = true ORDER BY number`)
    const lines = await query(
      `SELECT account_id, SUM(debit) AS debit, SUM(credit) AS credit
       FROM journal_lines GROUP BY account_id`
    )
    const map = Object.fromEntries(lines.rows.map(l => [l.account_id, { debit: Number(l.debit || 0), credit: Number(l.credit || 0) }]))
    const rows = accounts.rows.map(a => {
      const m = map[a.id] || { debit: 0, credit: 0 }
      let balance = 0
      if (a.type === 'Assets' || a.type === 'Expense') balance = Number(a.opening_debit || 0) + m.debit - m.credit
      else balance = Number(a.opening_credit || 0) + m.credit - m.debit
      return { ...a, debit: m.debit, credit: m.credit, balance }
    })
    const totalDebit = rows.reduce((s, r) => s + r.debit, 0)
    const totalCredit = rows.reduce((s, r) => s + r.credit, 0)
    res.json({ rows, totalDebit: Number(totalDebit.toFixed(2)), totalCredit: Number(totalCredit.toFixed(2)), balanced: Math.abs(totalDebit - totalCredit) < 0.01 })
  } catch (e) { next(e) }
})

/* ---------- قائمة الدخل ---------- */
router.get('/reports/income-statement', async (req, res, next) => {
  try {
    const { from, to } = req.query
    const accounts = await query(
      `SELECT * FROM chart_of_accounts WHERE active = true AND type IN ('Revenue', 'Expense') ORDER BY number`
    )
    const lines = await query(
      `SELECT jl.account_id, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       WHERE ($1::date IS NULL OR je.entry_date >= $1) AND ($2::date IS NULL OR je.entry_date <= $2)
       GROUP BY jl.account_id`,
      [from || null, to || null]
    )
    const map = Object.fromEntries(lines.rows.map(l => [l.account_id, { debit: Number(l.debit || 0), credit: Number(l.credit || 0) }]))
    const revenues = [], expenses = []
    for (const a of accounts.rows) {
      const m = map[a.id] || { debit: 0, credit: 0 }
      /* صافي الحساب: الإيرادات (credit - debit) قيمة موجبة، المصروفات (debit - credit) قيمة موجبة */
      const net = a.type === 'Revenue' ? Number((m.credit - m.debit).toFixed(2)) : Number((m.debit - m.credit).toFixed(2))
      const row = { ...a, net }
      if (a.type === 'Revenue') revenues.push(row); else expenses.push(row)
    }
    const totalRevenue = revenues.reduce((s, r) => s + r.net, 0)
    const totalExpense = expenses.reduce((s, r) => s + r.net, 0)
    res.json({ revenues, expenses, totalRevenue: Number(totalRevenue.toFixed(2)), totalExpense: Number(totalExpense.toFixed(2)), netIncome: Number((totalRevenue - totalExpense).toFixed(2)) })
  } catch (e) { next(e) }
})

/* ---------- رصيد حساب ---------- */
async function accountBalance(accountId) {
  const acc = await query(`SELECT * FROM chart_of_accounts WHERE id = $1`, [accountId])
  if (!acc.rows[0]) return { debit: 0, credit: 0, balance: 0 }
  const a = acc.rows[0]
  const lines = await query(
    `SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
     FROM journal_lines WHERE account_id = $1`, [accountId]
  )
  const d = Number(lines.rows[0].debit), c = Number(lines.rows[0].credit)
  let balance = 0
  if (a.type === 'Assets' || a.type === 'Expense') balance = Number(a.opening_debit || 0) + d - c
  else balance = Number(a.opening_credit || 0) + c - d
  return { debit: d, credit: c, balance: Number(balance.toFixed(2)) }
}

/* ---------- الأستاذ العام لحساب ---------- */
router.get('/reports/general-ledger/:accountId', async (req, res, next) => {
  try {
    const { from, to } = req.query
    const rows = await query(
      `SELECT jl.id, jl.entry_id, jl.description, jl.debit, jl.credit, je.entry_no, je.entry_date, je.ref_kind, je.ref_id
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       WHERE jl.account_id = $1 AND ($2::date IS NULL OR je.entry_date >= $2) AND ($3::date IS NULL OR je.entry_date <= $3)
       ORDER BY je.entry_date, jl.id`,
      [Number(req.params.accountId), from || null, to || null]
    )
    let run = 0
    const data = rows.rows.map(l => {
      run += Number(l.debit || 0) - Number(l.credit || 0)
      return { ...l, runningBalance: Number(run.toFixed(2)) }
    })
    res.json(data)
  } catch (e) { next(e) }
})

/* ---------- القيود المحاسبية ---------- */
router.get('/journals-lines', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT jl.*, ca.code AS account_code, ca.name AS account_name FROM journal_lines jl
       LEFT JOIN chart_of_accounts ca ON ca.id = jl.account_id
       ORDER BY jl.id DESC LIMIT 2000`
    )
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.get('/journals', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT je.*, u.username FROM journal_entries je
       LEFT JOIN users u ON u.id = je.created_by
       ORDER BY je.id DESC LIMIT 200`
    )
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.get('/journals/:id', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT je.*, json_agg(json_build_object('id', jl.id, 'account_id', jl.account_id, 'description', jl.description, 'debit', jl.debit, 'credit', jl.credit)) AS lines
       FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.entry_id = je.id
       WHERE je.id = $1 GROUP BY je.id`,
      [Number(req.params.id)]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'القيد غير موجود' })
    res.json(r.rows[0])
  } catch (e) { next(e) }
})

/* قيد يدوي */
router.post('/journals', requirePermission('journals.write'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { date, description, lines } = req.body
    if (!Array.isArray(lines) || lines.length < 2) return res.status(400).json({ error: 'القيد يتطلب سطرين على الأقل' })
    await client.query('BEGIN')
    const entryId = await engine.postJournalEntry({
      client, date, description, refKind: 'manual', refId: null,
      lines: lines.map(l => ({ accountId: l.accountId, description: l.description, debit: l.debit, credit: l.credit })),
      createdBy: req.user.id,
    })
    await engine.audit({ client, userId: req.user.id, username: req.user.username, action: 'manual_journal_posted', refKind: 'journal', refId: entryId, details: { description } })
    await client.query('COMMIT')
    res.status(201).json({ entryId, success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message && /غير متوازن|سطرين|بدون حساب|صفرية|سالب/.test(e.message)) return res.status(400).json({ error: e.message })
    next(e)
  } finally {
    client.release()
  }
})

/* ---------- التحويلات بين المخازن ---------- */
router.post('/transfers', requirePermission('inventory.write'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { fromStoreId, toStoreId, itemId, batchId, qty } = req.body
    if (!fromStoreId || !toStoreId || !itemId || !qty || Number(qty) <= 0) {
      return res.status(400).json({ error: 'بيانات التحويل غير مكتملة'})
    }
    await client.query('BEGIN')
    let srcBatch
    if (batchId) {
      const b = await client.query(`SELECT * FROM batches WHERE id = $1 FOR UPDATE`, [Number(batchId)])
      srcBatch = b.rows[0] || null
      if (!srcBatch) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'التشغيلة المحددة غير موجودة' })
      }
    } else {
      const fb = await client.query(
        `SELECT * FROM batches WHERE item_id = $1 AND store_id = $2 AND qty > 0
         ORDER BY COALESCE(exp_date, '9999-12-31'::date) ASC, id ASC LIMIT 1 FOR UPDATE`,
        [Number(itemId), Number(fromStoreId)]
      )
      srcBatch = fb.rows[0] || null
      if (!srcBatch) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'لا يوجد مخزون متاح في المخزن المصدر' })
      }
    }
    if (Number(srcBatch.qty) < Number(qty)) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'مخزون غير كافٍ للتحويل' })
    }
    const t = await client.query(
      `INSERT INTO transfers (from_store_id, to_store_id, item_id, source_batch_id, qty, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [Number(fromStoreId), Number(toStoreId), Number(itemId), srcBatch.id, Number(qty), req.user.id]
    )
    const newBatch = await engine.addBatch({
      client, itemId: Number(itemId), storeId: Number(toStoreId),
      batchNo: `${srcBatch.batch_no}-T`, mfgDate: srcBatch.mfg_date, expDate: srcBatch.exp_date,
      qty: Number(qty), cost: Number(srcBatch.cost), sourceKind: 'transfer_in', sourceId: srcBatch.id, userId: req.user.id,
    })
    await client.query(`UPDATE batches SET qty = qty - $1 WHERE id = $2`, [Number(qty), srcBatch.id])
    await client.query(
      `INSERT INTO stock_movements (item_id, batch_id, kind, qty, ref_kind, ref_id, user_id)
       VALUES ($1, $2, 'transfer_out', $3, 'transfer', $4, $5)`,
      [Number(itemId), srcBatch.id, Number(qty), t.rows[0].id, req.user.id]
    )
    await client.query(`UPDATE transfers SET new_batch_id = $1 WHERE id = $2`, [newBatch, t.rows[0].id])
    await engine.audit({ client, userId: req.user.id, username: req.user.username, action: 'transfer_posted', refKind: 'transfer', refId: t.rows[0].id, details: { qty: Number(qty) } })
    await client.query('COMMIT')
    res.status(201).json({ transferId: t.rows[0].id, newBatchId: newBatch, success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.message && /غير متوازن|غير كافٍ|مكتملة/.test(e.message)) return res.status(400).json({ error: e.message })
    next(e)
  } finally {
    client.release()
  }
})

module.exports = router

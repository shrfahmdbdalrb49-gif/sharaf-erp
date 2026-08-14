/* routes/system.js — المصادقة، المستخدمون، سجل التدقيق، الإعدادات */
const { Router } = require('express')
const bcrypt = require('bcryptjs')
const { authenticate, requirePermission, login } = require('../auth')
const { query } = require('../db')
const engine = require('../engine')

const router = Router()

/* ---------- تسجيل الدخول ---------- */
router.post('/auth/login', async (req, res, next) => {
  try {
    const { username, password } = req.body
    if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' })
    const result = await login({ username, password })
    await engine.auditGlobal({
      userId: result.user.id, username: result.user.username, action: 'login',
      ip: req.ip,
    })
    res.json(result)
  } catch (e) {
    if (e.message && /(غير صحيحة|معطَّل)/.test(e.message)) return res.status(401).json({ error: e.message })
    next(e)
  }
})

router.post('/auth/me', authenticate, async (req, res, next) => {
  try {
    res.json({ user: req.user })
  } catch (e) { next(e) }
})

/* ---------- المستخدمون (إدارة) ---------- */
router.get('/users', authenticate, requirePermission('users.write'), async (req, res, next) => {
  try {
    const r = await query(`SELECT id, username, full_name, role, branch_id, active, last_login_at FROM users ORDER BY id`)
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.post('/users', authenticate, requirePermission('users.write'), async (req, res, next) => {
  try {
    const { username, password, fullName, role, branchId } = req.body
    if (!username || !password || !fullName) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور والاسم مطلوبون' })
    const hash = await bcrypt.hash(password, 12)
    const r = await query(
      `INSERT INTO users (username, password_hash, full_name, role, branch_id, active)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id, username, full_name, role`,
      [username, hash, fullName, role || 'cashier', branchId || null]
    )
    res.status(201).json(r.rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'اسم المستخدم موجود مسبقًا' })
    next(e)
  }
})

router.put('/users/:id', authenticate, requirePermission('users.write'), async (req, res, next) => {
  try {
    const { fullName, role, active, password, branchId } = req.body
    if (password) {
      const hash = await bcrypt.hash(password, 12)
      await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, Number(req.params.id)])
    }
    const r = await query(
      `UPDATE users SET full_name = COALESCE($1, full_name), role = COALESCE($2, role),
       active = COALESCE($3, active), branch_id = COALESCE($4, branch_id)
       WHERE id = $5 RETURNING id, username, full_name, role, active`,
      [fullName, role, active == null ? null : Boolean(active), branchId == null ? null : Number(branchId), Number(req.params.id)]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'المستخدم غير موجود' })
    res.json(r.rows[0])
  } catch (e) { next(e) }
})

/* ---------- الصلاحيات ---------- */
router.get('/permissions', authenticate, async (req, res, next) => {
  try {
    const r = await query(`SELECT * FROM role_permissions ORDER BY role_name`)
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.post('/permissions', authenticate, requirePermission('users.write'), async (req, res, next) => {
  try {
    const { roleName, permission } = req.body
    if (!roleName || !permission) return res.status(400).json({ error: 'الدور والصلاحية مطلوبان' })
    const r = await query(
      `INSERT INTO role_permissions (role_name, permission) VALUES ($1, $2)
       ON CONFLICT (role_name, permission) DO NOTHING RETURNING *`,
      [roleName, permission]
    )
    res.status(201).json(r.rows[0] || { roleName, permission, existed: true })
  } catch (e) { next(e) }
})

router.delete('/permissions/:roleName/:permission', authenticate, requirePermission('users.write'), async (req, res, next) => {
  try {
    await query(`DELETE FROM role_permissions WHERE role_name = $1 AND permission = $2`, [req.params.roleName, req.params.permission])
    res.json({ deleted: true })
  } catch (e) { next(e) }
})

/* ---------- سجل التدقيق (قراءة فقط — لا حذف) ---------- */
router.get('/audit', authenticate, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000)
    const r = await query(
      `SELECT * FROM audit_logs ORDER BY id DESC LIMIT $1`, [limit]
    )
    res.json(r.rows)
  } catch (e) { next(e) }
})

/* ---------- الإعدادات ---------- */
router.get('/settings', authenticate, async (req, res, next) => {
  try {
    const r = await query(`SELECT * FROM settings`)
    res.json(Object.fromEntries(r.rows.map(s => [s.key, typeof s.value === 'string' ? JSON.parse(s.value) : s.value])))
  } catch (e) { next(e) }
})

router.put('/settings/:key', authenticate, requirePermission('settings.write'), async (req, res, next) => {
  try {
    const r = await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value RETURNING *`,
      [req.params.key, JSON.stringify(req.body.value)]
    )
    res.json(r.rows[0])
  } catch (e) { next(e) }
})

/* ---------- الفروع ---------- */
router.get('/branches', authenticate, async (req, res, next) => {
  try {
    const r = await query(`SELECT * FROM branches ORDER BY id`)
    res.json(r.rows)
  } catch (e) { next(e) }
})

router.get('/stores', authenticate, async (req, res, next) => {
  try {
    const r = await query(`SELECT * FROM stores ORDER BY id`)
    res.json(r.rows)
  } catch (e) { next(e) }
})

/* ---------- إعادة تهيئة قاعدة البيانات (اختبارات/حالات الطوارئ) — أدمن فقط ---------- */
router.post('/reset', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'إعادة التهيئة متاحة للإدارة فقط' })
    const tables = ['audit_logs', 'stock_movements', 'sales_return_lines', 'sales_lines',
      'purchase_lines', 'sales_returns', 'batches', 'sales_invoices', 'purchase_invoices',
      'collections', 'supplier_payments', 'journal_lines', 'journal_entries', 'transfers',
      'settings']
    const { pool } = require('../db')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const t of tables) {
        await client.query(`DELETE FROM ${t}`)
      }
      await client.query(`INSERT INTO settings (key, value) VALUES
        ('currentSession', '{"active": false}'),
        ('nextInvoiceNo', '1'), ('nextPurchaseNo', '1'), ('nextSaleNo', '1'),
        ('nextCollectionNo', '1'), ('nextPaymentNo', '1'), ('nextJournalEntryNo', '1'),
        ('nextTransferNo', '1')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
      await client.query('COMMIT')
      res.json({ success: true, tables })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

module.exports = router

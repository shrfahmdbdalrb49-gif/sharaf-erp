/* auth.js — المصادقة JWT + الصلاحيات RBAC */
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { pool } = require('./db') // يُحمَّل مبكرًا لتجنب دورة auth→engine→db غير مكتملة

const JWT_SECRET = process.env.JWT_SECRET || 'sharaf-erp-dev-secret'
const JWT_EXPIRY = process.env.JWT_EXPIRY || '10h'

/* إنشاء توكن */
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, branchId: user.branch_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  )
}

/* تحقق أن الطلب يحمل توكنًا صحيحًا ويعيد المستخدم */
async function authenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولًا' })
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET)
    const r = await pool.query(
      `SELECT id, username, full_name, role, branch_id, active FROM users WHERE id = $1`,
      [payload.id]
    )
    const user = r.rows[0]
    if (!user) return res.status(401).json({ error: 'المستخدم غير موجود' })
    if (!user.active) return res.status(403).json({ error: 'الحساب معطَّل' })
    req.user = user
    next()
  } catch (e) {
    return res.status(401).json({ error: 'جلسة غير صالحة أو منتهية' })
  }
}

/* تحقق من صلاحية محددة: requirePermission('pos.sale')
   - admin يحمل '*' تلقائيًا
   - الصلاحيات الهرمية: 'pos' تشمل 'pos.sale' و 'pos.read' */
function requirePermission(...perms) {
  return async (req, res, next) => {
    const user = req.user
    if (!user) return res.status(401).json({ error: 'يجب تسجيل الدخول أولًا' })
    const r = await pool.query(`SELECT permission FROM role_permissions WHERE role_name = $1`, [user.role])
    const granted = r.rows.map(x => x.permission)
    const ok = granted.includes('*') || perms.some(p =>
      granted.includes(p) || granted.some(g => p.startsWith(g + '.'))
    )
    if (!ok) return res.status(403).json({ error: `لا تملك صلاحية: ${perms.join(', ')}` })
    next()
  }
}

/* تسجيل دخول + توليد توكن */
async function login({ username, password }) {
  const r = await pool.query(`SELECT id, username, full_name, role, branch_id, active, password_hash FROM users WHERE username = $1`, [username])
  const user = r.rows[0]
  if (!user) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة')
  if (!user.active) throw new Error('الحساب معطَّل — تواصل مع المدير')
  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة')
  await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id])
  const token = signToken(user)
  return { user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role, branchId: user.branch_id }, token }
}

module.exports = { authenticate, requirePermission, login, signToken }

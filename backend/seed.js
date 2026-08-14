/* seed.js — إدراج المستخدمين الافتراضيين بهاش bcrypt حقيقي (خادم) */
const bcrypt = require('bcryptjs')
const { Pool } = require('pg')
require('dotenv').config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://erp:erp123@localhost:5432/sharf_erp' })

const users = [
  { username: 'admin', password: 'admin123', fullName: 'مدير النظام', role: 'admin', branchId: 1 },
  { username: 'cashier', password: 'cash123', fullName: 'محاسب/كاشير', role: 'cashier', branchId: 1 },
]

;(async () => {
  const client = await pool.connect()
  try {
    const del = await client.query('DELETE FROM users')
    console.log('users cleared:', del.rowCount)
    for (const u of users) {
      const hash = await bcrypt.hash(u.password, 12)
      const r = await client.query(
        `INSERT INTO users (username, password_hash, full_name, role, branch_id, active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id, username, role`,
        [u.username, hash, u.fullName, u.role, u.branchId]
      )
      console.log('user:', r.rows[0])
    }
    console.log('SEED DONE')
  } finally {
    client.release()
    await pool.end()
  }
})()

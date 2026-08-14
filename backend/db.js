/* db.js — طبقة الاتصال الموحدة بقاعدة البيانات */
const { Pool, types } = require('pg')
require('dotenv').config()

/* تحويل NUMERIC إلى أرقام JavaScript (افتراضيًا تعيد pg سلاسل نصية) */
types.setTypeParser(1700, (val) => {
  const n = parseFloat(val)
  return Number.isNaN(n) ? val : n
})

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
})

pool.on('error', (err) => {
  console.error('[db] unexpected pool error:', err)
})

function query(text, params) {
  return pool.query(text, params)
}

function getClient() {
  return pool.connect()
}

/* رقّم متسلسل آمن للتنافسية (فواتير/قيود) عبر SELECT FOR UPDATE — value نوع jsonb */
async function nextSequence(key) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const r = await client.query(
      `UPDATE settings SET value = (value::text::int + 1)::text::jsonb WHERE key = $1 RETURNING value`,
      [key]
    )
    await client.query('COMMIT')
    return Number(r.rows[0].value)
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

module.exports = { pool, query, getClient, nextSequence }

/* docker-entrypoint.js — تشغيل الخادم مع ضمان تهيئة قاعدة البيانات أولًا */
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')
require('dotenv').config()

/* 1. تهيئة المخطط إذا لم يكن موجودًا */
;(async () => {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('[init] DATABASE_URL غير محدد — سيتوقف الخادم')
    process.exit(1)
  }
  const pool = new Pool({ connectionString: dbUrl })
  try {
    const exists = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users')`
    )
    if (!exists.rows[0].exists) {
      console.log('[init] إنشاء مخطط قاعدة البيانات...')
      const schema = fs.readFileSync(path.join(__dirname, 'schema', 'schema.sql'), 'utf8')
      await pool.query(schema)
      console.log('[init] المخطط أُنشئ بنجاح')
    } else {
      console.log('[init] المخطط موجود — تخطي الإنشاء')
    }
  } catch (e) {
    console.error('[init] فشل تهيئة قاعدة البيانات:', e.message)
    await pool.end()
    process.exit(1)
  }
  await pool.end()

  /* 2. تشغيل الخادم */
  require('./server.js')
})()

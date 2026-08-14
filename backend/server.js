/* server.js — نقطة دخول خادم شرف ERP */
const express = require('express')
const cors = require('cors')
const { pool } = require('./db')

const app = express()
app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '5mb' }))

/* ترويسة UTF-8 عربية */
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  next()
})

/* ---------- Health ---------- */
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ status: 'ok', service: 'Sharaf ERP API', timestamp: new Date().toISOString() })
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message })
  }
})

/* ---------- المسارات ---------- */
app.use('/api', require('./routes/system'))
app.use('/api', require('./routes/masterData'))
app.use('/api', require('./routes/invoices'))
app.use('/api', require('./routes/accounting'))

/* ---------- معالجة الأخطاء الموحدة ---------- */
app.use((err, req, res, _next) => {
  console.error('[error]', err && err.stack ? err.stack : err)
  const message = (err && err.message) || 'خطأ داخلي في الخادم'
  res.status(err.statusCode || 500).json({ error: message })
})

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`Sharaf ERP API running on port ${PORT}`)
})

process.on('SIGTERM', async () => {
  await pool.end()
  process.exit(0)
})

module.exports = app

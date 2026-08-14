# شرف ERP — الخادم الخلفي (Backend)

الخادم الخلفي المركزي لنظام شرف ERP لإدارة الصيدليات، مبني بـ Node.js + Express + PostgreSQL مع مصادقة JWT وصلاحيات RBAC ومحاسبة مزدوجة كاملة.

## البنية

```
sharf-erp/
├── backend/
│   ├── server.js              # نقطة الدخول (Express، المنفذ ديناميكي من env)
│   ├── docker-entrypoint.js   # يهيّئ قاعدة البيانات تلقائيًا إن لزم ثم يشغّل الخادم
│   ├── db.js, auth.js, engine.js
│   ├── routes/                # system, masterData, invoices, accounting
│   ├── schema/schema.sql      # مخطط قاعدة البيانات كامل
│   ├── seed.js                # المستخدمين الافتراضيين (مرة واحدة فقط بعد التشغيل الأول)
│   └── Dockerfile
└── README.md
```

## النشر السحابي

### Railway (موصى به)

1. سجّل دخول على [Railway.app](https://railway.app) وأنشئ مشروعًا جديدًا (New Project).
2. Add Plugin → PostgreSQL → انتظر إنشاء قاعدة البيانات.
3. Deploy → GitHub Repo → اختر `shrfahmdbdalrb49-gif/sharaf-erp`.
4. في إعدادات الخدمة (Services) أضف متغير البيئة `JWT_SECRET` بقيمة عشوائية طويلة (مثل `openssl rand -hex 32`)، و `JWT_EXPIRY=10h`.
5. ربط PostgreSQL: استخدم Insert Variable في متغيرات الخدمة لإدراج `DATABASE_URL` التي يوفرها plugin.
6. Settings → Source: اختر Dockerfile وقاعدة `backend` (أو Command مخصص: `cd backend && npm ci && npm start`).
7. بعد التشغيل الأول، نفّذ الأمر التالي مرة واحدة فقط لإدراج المستخدمين (Railway Console): `node backend/seed.js`

المستخدمون الافتراضيون: `admin / admin123` (مدير كامل) و `cashier / cash123` (كاشير/محاسب).

### Render

1. سجّل على [Render.com](https://render.com) → New Web Service → GitHub repo: `sharf-erp`.
2. Runtime: Docker. Environment Variables: `DATABASE_URL` (من Render PostgreSQL) + `JWT_SECRET`.
3. Deploy — الخادم يهيّئ قاعدة البيانات تلقائيًا عند أول تشغيل (جدول `users` إن لم يكن موجودًا)، ثم نفّذ `node backend/seed.js` مرة واحدة.

### تشغيل بدون Docker

```bash
cd backend
npm ci
DATABASE_URL=postgres://... JWT_SECRET=... npm start
```

ولإنشاء الجداول قبل التشغيل الأول: `npm run setup-db`.

## ربط الواجهة المنشورة بالخادم

الواجهة منشورة على GitHub Pages (مستودع `Eeerp`). بعد الحصول على رابط API السحابي (مثل `https://sharaf-erp-production.up.railway.app`) أضف هذا السطر في بداية `<head>` في `index.html` المنشور على فرع `gh-pages`:

```html
<script>window.API_BASE = 'https://YOUR-API-DOMAIN/api';</script>
```

بهذا تتصل الواجهة بالخادم المركزي من أي جهاز بدل localhost.

## ملاحظات تشغيلية

- `docker-entrypoint.js` يتحقق من وجود جدول `users`؛ إن لم يكن موجودًا ينفذ `schema/schema.sql` تلقائيًا — لا حاجة لأي إعداد يدوي لقاعدة البيانات.
- جميع عمليات REST تحت `/api` وتتطلب توكن JWT ما عدا `/api/health` وتسجيل الدخول.
- المخططات المحاسبية: الصندوق 1-1-1، البنوك 1-1-2، الذمم المدينة 1-2، المخزون 1-3، الذمم الدائنة 2-1، حقوق الملكية 3-1، إيرادات المبيعات 4-1، تكلفة المبيعات 5-1، المصروفات التشغيلية 5-2.
- `seed.js` يمسح جدول المستخدمين ثم يدرج الحسابين الافتراضيين — نفّذه مرة واحدة فقط.

## الترخيص

حقوق ملكية خاصة — للاستخدام الداخلي فقط.

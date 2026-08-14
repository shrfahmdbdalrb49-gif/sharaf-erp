-- ============================================================
-- شرف ERP — مخطط قاعدة البيانات PostgreSQL (v1.0)
-- نسخة مركزية تدعم الفروع المتعددة والمزامنة اللحظية
-- ============================================================

SET client_encoding = 'UTF8';

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------
-- 1. الإعداد العام والمستخدمون والأدوار والصلاحيات (RBAC)
-- -----------------------------------------------------------

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,      -- bcrypt (يحل محل hash العميل البسيط)
    full_name VARCHAR(128) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'cashier', -- admin | cashier | accountant | pharmacist | viewer
    branch_id INTEGER,                          -- الفرع الرئيسي للمستخدم
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    description TEXT
);

CREATE TABLE role_permissions (
    id SERIAL PRIMARY KEY,
    role_name VARCHAR(64) NOT NULL,
    permission VARCHAR(64) NOT NULL,  -- '*' للصلاحية الكاملة، أو مثل: 'pos.sale', 'items.read'
    UNIQUE (role_name, permission)
);

CREATE INDEX idx_role_permissions_role ON role_permissions(role_name);

-- -----------------------------------------------------------
-- 2. الفروع (مفتاح دعم المزامنة بين عدة صيدليات)
-- -----------------------------------------------------------

CREATE TABLE branches (
    id SERIAL PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    code VARCHAR(32) NOT NULL UNIQUE,
    address TEXT,
    phone VARCHAR(64),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------
-- 3. المخازن
-- -----------------------------------------------------------

CREATE TABLE stores (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    name VARCHAR(128) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------
-- 4. دليل الحسابات المحاسبي (شجري هرمي قياسي)
-- -----------------------------------------------------------

CREATE TABLE chart_of_accounts (
    id SERIAL PRIMARY KEY,
    code VARCHAR(32) NOT NULL UNIQUE,          -- مثل: '1', '1-1-1', '5-2'
    number INTEGER NOT NULL UNIQUE,            -- مثل: 111
    name VARCHAR(128) NOT NULL,
    type VARCHAR(16) NOT NULL CHECK (type IN ('Assets', 'Liabilities', 'Equity', 'Revenue', 'Expense')),
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
    parent_id INTEGER REFERENCES chart_of_accounts(id),  -- ربط داخلي عبر id بدل النص
    opening_debit NUMERIC(15,2) NOT NULL DEFAULT 0,
    opening_credit NUMERIC(15,2) NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coa_parent ON chart_of_accounts(parent_id);

-- -----------------------------------------------------------
-- 5. الأصناف والتشغيلات (FEFO)
-- -----------------------------------------------------------

CREATE TABLE items (
    id SERIAL PRIMARY KEY,
    code VARCHAR(64) UNIQUE,
    name VARCHAR(256) NOT NULL,
    barcode VARCHAR(128) UNIQUE,
    category VARCHAR(128),
    scientific_name VARCHAR(256),
    unit VARCHAR(32) DEFAULT 'unit',
    min_stock NUMERIC(12,2) NOT NULL DEFAULT 0,   -- حد إعادة الطلب
    note TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_barcode ON items(barcode);
CREATE UNIQUE INDEX idx_items_name ON items(name);

CREATE TABLE batches (
    id SERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    batch_no VARCHAR(128) NOT NULL,
    mfg_date DATE,                       -- تاريخ الإنتاج
    exp_date DATE,                       -- تاريخ الانتهاء (أساس FEFO)
    qty NUMERIC(12,2) NOT NULL CHECK (qty >= 0),
    cost NUMERIC(15,2) NOT NULL DEFAULT 0,   -- تكلفة الوحدة (الوزن المتوسط لكل دفعة)
    source_kind VARCHAR(32) DEFAULT 'purchase', -- purchase | transfer_in | opening
    source_id INTEGER,
    quarantined BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_batches_item ON batches(item_id);
CREATE INDEX idx_batches_item_stock ON batches(item_id) WHERE NOT quarantined AND qty > 0;
CREATE INDEX idx_batches_expiry ON batches(exp_date);

CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
    kind VARCHAR(32) NOT NULL CHECK (kind IN ('in', 'out', 'transfer_in', 'transfer_out', 'adjust', 'return_in')),
    qty NUMERIC(12,2) NOT NULL,
    ref_kind VARCHAR(32),                  -- purchase | sale | saleReturn | transfer | adjust
    ref_id INTEGER,
    user_id INTEGER REFERENCES users(id),
    movement_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stockmov_item ON stock_movements(item_id);
CREATE INDEX idx_stockmov_batch ON stock_movements(batch_id);
CREATE INDEX idx_stockmov_ref ON stock_movements(ref_kind, ref_id);

-- -----------------------------------------------------------
-- 6. الموردين والمشتريات
-- -----------------------------------------------------------

CREATE TABLE suppliers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(256) NOT NULL,
    phone VARCHAR(64),
    email VARCHAR(128),
    tax_number VARCHAR(64),
    address TEXT,
    notes TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE purchase_invoices (
    id SERIAL PRIMARY KEY,
    invoice_no VARCHAR(64) UNIQUE,         -- رقم الفاتورة الخارجي/المتسلسل
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    branch_id INTEGER REFERENCES branches(id),
    store_id INTEGER REFERENCES stores(id),
    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
    discount NUMERIC(15,2) NOT NULL DEFAULT 0,
    tax NUMERIC(15,2) NOT NULL DEFAULT 0,
    total NUMERIC(15,2) NOT NULL DEFAULT 0,
    payment_type VARCHAR(16) NOT NULL DEFAULT 'credit' CHECK (payment_type IN ('cash', 'bank', 'credit')),
    paid_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'received', 'posted', 'cancelled')),  -- draft: مسودة، received: مستلمة (مخزون فقط)، posted: مرحّلة (قيود)، cancelled: ملغاة
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_purchase_supplier ON purchase_invoices(supplier_id);
CREATE INDEX idx_purchase_date ON purchase_invoices(invoice_date);

CREATE TABLE purchase_lines (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    batch_id INTEGER REFERENCES batches(id),   -- يُربط بعد إنشاء التشغيلة
    qty NUMERIC(12,2) NOT NULL CHECK (qty > 0),
    bonus NUMERIC(12,2) NOT NULL DEFAULT 0,   -- الكمية المجانية (المُهداة) الواردة مع الفاتورة
    unit_cost NUMERIC(15,2) NOT NULL DEFAULT 0,
    discount NUMERIC(15,2) NOT NULL DEFAULT 0,
    tax NUMERIC(15,2) NOT NULL DEFAULT 0,
    subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
    expiry_date DATE                            -- تاريخ انتهاء الدفعة المستلمة
);

CREATE INDEX idx_purchase_line_invoice ON purchase_lines(invoice_id);

-- -----------------------------------------------------------
-- 7. العملاء والمبيعات والمرتجعات
-- -----------------------------------------------------------

CREATE TABLE customers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(256) NOT NULL,
    phone VARCHAR(64),
    email VARCHAR(128),
    credit_limit NUMERIC(15,2) NOT NULL DEFAULT 0,
    address TEXT,
    notes TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sales_invoices (
    id SERIAL PRIMARY KEY,
    invoice_no VARCHAR(64) UNIQUE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT,
    branch_id INTEGER REFERENCES branches(id),
    store_id INTEGER REFERENCES stores(id),
    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
    discount NUMERIC(15,2) NOT NULL DEFAULT 0,
    tax NUMERIC(15,2) NOT NULL DEFAULT 0,
    total NUMERIC(15,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    payment_type VARCHAR(16) NOT NULL DEFAULT 'cash' CHECK (payment_type IN ('cash', 'bank', 'credit', 'mixed')),
    status VARCHAR(16) NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_customers_name ON customers(name);

-- رقم الفاتورة فريد فقط عندما يكون معبأً (يسمح بمسودات بدون رقم)
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_invoice_no ON purchase_invoices (invoice_no) WHERE invoice_no IS NOT NULL;

CREATE INDEX idx_sales_customer ON sales_invoices(customer_id);
CREATE INDEX idx_sales_date ON sales_invoices(invoice_date);

CREATE TABLE sales_lines (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    batch_ids INTEGER[] DEFAULT '{}',          -- الدفعات المخصومة فعليًا (FEFO)
    qty NUMERIC(12,2) NOT NULL CHECK (qty > 0),
    price NUMERIC(15,2) NOT NULL DEFAULT 0,
    discount NUMERIC(15,2) NOT NULL DEFAULT 0,
    tax NUMERIC(15,2) NOT NULL DEFAULT 0,
    subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
    cogs NUMERIC(15,2) NOT NULL DEFAULT 0      -- تكلفة المبيعات للسطر (تُثبت لحظة البيع)
);

CREATE INDEX idx_sales_line_invoice ON sales_lines(invoice_id);

CREATE TABLE sales_returns (
    id SERIAL PRIMARY KEY,
    return_no VARCHAR(64) UNIQUE,
    sale_invoice_id INTEGER REFERENCES sales_invoices(id) ON DELETE RESTRICT,
    customer_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT,
    branch_id INTEGER REFERENCES branches(id),
    return_date DATE NOT NULL DEFAULT CURRENT_DATE,
    total NUMERIC(15,2) NOT NULL DEFAULT 0,
    refund_method VARCHAR(16) NOT NULL DEFAULT 'cash' CHECK (refund_method IN ('cash', 'bank', 'credit')),
    status VARCHAR(16) NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sales_return_lines (
    id SERIAL PRIMARY KEY,
    return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
    sale_line_id INTEGER REFERENCES sales_lines(id),
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    batch_id INTEGER REFERENCES batches(id),
    qty NUMERIC(12,2) NOT NULL CHECK (qty > 0),
    price NUMERIC(15,2) NOT NULL DEFAULT 0,
    subtotal NUMERIC(15,2) NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------
-- 8. التحصيل من العملاء والسداد للموردين
-- -----------------------------------------------------------

CREATE TABLE collections (
    id SERIAL PRIMARY KEY,
    receipt_no VARCHAR(64) UNIQUE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
    method VARCHAR(16) NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'bank', 'check')),
    collected_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reference_no VARCHAR(128),                 -- رقم الشيك/التحويل
    status VARCHAR(16) NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_collections_customer ON collections(customer_id);

CREATE TABLE supplier_payments (
    id SERIAL PRIMARY KEY,
    payment_no VARCHAR(64) UNIQUE,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE RESTRICT,
    operation_type VARCHAR(16) NOT NULL DEFAULT 'supplier' CHECK (operation_type IN ('supplier', 'expense')),
    expense_account_id INTEGER REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
    amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
    method VARCHAR(16) NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'bank', 'check')),
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reference_no VARCHAR(128),
    status VARCHAR(16) NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'cancelled')),
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_suppay_supplier ON supplier_payments(supplier_id);

-- -----------------------------------------------------------
-- 9. القيود المحاسبية مزدوجة القيد (جوهر المحاسبة)
-- -----------------------------------------------------------

CREATE TABLE journal_entries (
    id SERIAL PRIMARY KEY,
    entry_no VARCHAR(64) UNIQUE,               -- رقم القيد المتسلسل سنويًا
    entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
    description TEXT,
    ref_kind VARCHAR(32),                      -- purchase | sale | collection | supplierPayment | saleReturn | manual | opening | transfer
    ref_id INTEGER,
    posted BOOLEAN NOT NULL DEFAULT TRUE,
    total_debit NUMERIC(15,2) NOT NULL DEFAULT 0,   -- مخزن للإسراع بالعرض والتحقق
    total_credit NUMERIC(15,2) NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_je_date ON journal_entries(entry_date);
CREATE INDEX idx_je_ref ON journal_entries(ref_kind, ref_id);

CREATE TABLE journal_lines (
    id SERIAL PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
    description TEXT,
    debit NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    CONSTRAINT line_has_value CHECK (debit > 0 OR credit > 0)
);

CREATE INDEX idx_jl_entry ON journal_lines(entry_id);
CREATE INDEX idx_jl_account ON journal_lines(account_id);

-- -----------------------------------------------------------
-- 10. التحويلات بين المخازن
-- -----------------------------------------------------------

CREATE TABLE transfers (
    id SERIAL PRIMARY KEY,
    from_store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    to_store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    source_batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
    new_batch_id INTEGER REFERENCES batches(id),
    qty NUMERIC(12,2) NOT NULL CHECK (qty > 0),
    transfer_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(16) NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'cancelled')),
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------
-- 11. سجل التدقيق (Audit Log) — غير قابل للتعديل أو الحذف
-- -----------------------------------------------------------

CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    username VARCHAR(64),
    action VARCHAR(64) NOT NULL,                -- login, sale_completed, journal_post, purchase_post, ...
    ref_kind VARCHAR(32),
    ref_id INTEGER,
    details JSONB,                              -- أي تفاصيل إضافية
    client_ip VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- لا يحق لأحد حذف سجل تدقيق — الحماية هنا بقاعدة بيانات + سياسة
REVOKE DELETE ON audit_logs FROM PUBLIC;

CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);

-- -----------------------------------------------------------
-- 12. الإعدادات العامة (key-value مثل IndexedDB settings)
-- -----------------------------------------------------------

CREATE TABLE settings (
    key VARCHAR(128) PRIMARY KEY,
    value JSONB NOT NULL
);

-- -----------------------------------------------------------
-- البيانات الافتراضية (مطابقة للنظام الحالي تمامًا)
-- -----------------------------------------------------------

INSERT INTO chart_of_accounts (code, number, name, type, level, opening_debit, opening_credit) VALUES
    ('1',    1,   'الأصول',                      'Assets',    1, 0, 0),
    ('1-1',  11,  'النقدية والصناديق',           'Assets',    2, 0, 0),
    ('1-1-1', 111, 'الصندوق الرئيسي',            'Assets',    3, 0, 0),
    ('1-1-2', 112, 'البنك (حساب جاري)',          'Assets',    3, 0, 0),
    ('1-2',  12,  'الذمم المدينة (عملاء)',       'Assets',    2, 0, 0),
    ('1-3',  13,  'المخزون',                     'Assets',    2, 0, 0),
    ('2',    2,   'الخصوم',                      'Liabilities', 1, 0, 0),
    ('2-1',  21,  'الذمم الدائنة (موردون)',      'Liabilities', 2, 0, 0),
    ('3',    3,   'حقوق الملكية',                'Equity',    1, 0, 0),
    ('3-1',  31,  'رأس المال',                   'Equity',    2, 0, 0),
    ('4',    4,   'الإيرادات',                   'Revenue',   1, 0, 0),
    ('4-1',  41,  'إيرادات المبيعات',            'Revenue',   2, 0, 0),
    ('4-2',  42,  'مردودات ومسموحات مبيعات',     'Revenue',   2, 0, 0),
    ('5',    5,   'المصروفات',                   'Expense',   1, 0, 0),
    ('5-1',  51,  'تكلفة المبيعات',              'Expense',   2, 0, 0),
    ('5-2',  52,  'المصروفات التشغيلية',         'Expense',   2, 0, 0);

-- ربط الأب عبر id بعد الإدراج
UPDATE chart_of_accounts SET parent_id = a2.id
FROM chart_of_accounts a2
WHERE chart_of_accounts.code = '1-1'   AND a2.code = '1'
   OR chart_of_accounts.code = '1-1-1' AND a2.code = '1-1'
   OR chart_of_accounts.code = '1-1-2' AND a2.code = '1-1'
   OR chart_of_accounts.code = '1-2'   AND a2.code = '1'
   OR chart_of_accounts.code = '1-3'   AND a2.code = '1'
   OR chart_of_accounts.code = '2-1'   AND a2.code = '2'
   OR chart_of_accounts.code = '3-1'   AND a2.code = '3'
   OR chart_of_accounts.code = '4-1'   AND a2.code = '4'
   OR chart_of_accounts.code = '4-2'   AND a2.code = '4'
   OR chart_of_accounts.code = '5-1'   AND a2.code = '5'
   OR chart_of_accounts.code = '5-2'   AND a2.code = '5';

INSERT INTO roles (name, description) VALUES
    ('admin', 'مدير النظام — صلاحيات كاملة'),
    ('cashier', 'كاشير/محاسب — نقاط البيع والتحصيل');

INSERT INTO role_permissions (role_name, permission) VALUES
    ('admin', '*'),
    ('cashier', 'pos'),
    ('cashier', 'customers'),
    ('cashier', 'collections'),
    ('cashier', 'items.read');

INSERT INTO branches (name, code, address) VALUES ('الفرع الرئيسي', 'HQ', 'الفرع الرئيسي');
INSERT INTO stores (branch_id, name) VALUES (1, 'مخزن الفرع الرئيسي');

INSERT INTO settings (key, value) VALUES
    ('currentSession', '{"active": false}'),
    ('nextInvoiceNo', '1');

-- المستخدمون الافتراضيون (bcrypt — يُنشأون عبر سكربت seed Node.js لتوليد الهاش الصحيح)

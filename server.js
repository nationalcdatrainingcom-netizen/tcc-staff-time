const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DIRECTOR_PIN = process.env.DIRECTOR_PIN || 'dir2026';
const ADMIN_PIN = process.env.ADMIN_PIN || 'admin2026';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_pins (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE UNIQUE,
      pin VARCHAR(10) NOT NULL,
      role VARCHAR(20) DEFAULT 'staff',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS daily_cacfp_entries (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE,
      fiscal_year_id INTEGER REFERENCES fiscal_years(id),
      month_key VARCHAR(10) NOT NULL,
      day_of_month INTEGER NOT NULL,
      food_service_hours NUMERIC(6,2) DEFAULT 0,
      admin_hours NUMERIC(6,2) DEFAULT 0,
      entered_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(staff_id, fiscal_year_id, month_key, day_of_month)
    );
    CREATE TABLE IF NOT EXISTS monthly_signatures (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE,
      fiscal_year_id INTEGER REFERENCES fiscal_years(id),
      month_key VARCHAR(10) NOT NULL,
      employee_signature VARCHAR(200),
      employee_signed_at TIMESTAMP,
      supervisor_signature VARCHAR(200),
      supervisor_signed_at TIMESTAMP,
      status VARCHAR(20) DEFAULT 'in_progress',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(staff_id, fiscal_year_id, month_key)
    );
    CREATE TABLE IF NOT EXISTS playground_staff_hours (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE,
      fiscal_year_id INTEGER REFERENCES fiscal_years(id),
      month_key VARCHAR(10) NOT NULL,
      day_of_month INTEGER NOT NULL,
      start_time VARCHAR(20),
      end_time VARCHAR(20),
      total_worked NUMERIC(6,2) DEFAULT 0,
      total_absent NUMERIC(6,2) DEFAULT 0,
      imported_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(staff_id, fiscal_year_id, month_key, day_of_month)
    );
  `);
  console.log('✅ Staff Time tables ready');
}

function monthKeyFromDate() {
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  return months[new Date().getMonth()];
}

// ── AUTH ──
app.post('/api/staff-login', async (req, res) => {
  try {
    const { staff_id, pin } = req.body;
    const { rows } = await pool.query(
      `SELECT sp.*, s.name, s.center, s.hourly_rate
       FROM staff_pins sp JOIN staff s ON s.id = sp.staff_id
       WHERE sp.staff_id = $1 AND sp.pin = $2 AND s.is_active = true`,
      [staff_id, pin]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid PIN' });
    const r = rows[0];
    res.json({ ok: true, staff_id: r.staff_id, name: r.name, center: r.center, role: r.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/director-login', async (req, res) => {
  const { pin } = req.body;
  if (pin === DIRECTOR_PIN) return res.json({ ok: true, role: 'director' });
  if (pin === ADMIN_PIN) return res.json({ ok: true, role: 'admin' });
  res.status(401).json({ error: 'Invalid PIN' });
});

// ── STAFF LIST ──
app.get('/api/staff-list', async (req, res) => {
  try {
    const { center } = req.query;
    let q = `SELECT s.id, s.name, s.center FROM staff s
             JOIN staff_pins sp ON sp.staff_id = s.id WHERE s.is_active = true`;
    const p = [];
    if (center) { p.push(center); q += ` AND s.center = $${p.length}`; }
    q += ' ORDER BY s.name';
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All staff for management (includes those without PINs)
app.get('/api/all-staff', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.center, s.hourly_rate FROM staff s WHERE s.is_active = true ORDER BY s.center, s.name`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DAILY ENTRIES ──
app.get('/api/daily-entries/:staffId', async (req, res) => {
  try {
    const { month_key, fiscal_year_id } = req.query;
    const { rows } = await pool.query(
      `SELECT * FROM daily_cacfp_entries
       WHERE staff_id = $1 AND fiscal_year_id = $2 AND month_key = $3 ORDER BY day_of_month`,
      [req.params.staffId, fiscal_year_id, month_key]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/daily-entries', async (req, res) => {
  try {
    const { staff_id, fiscal_year_id, month_key, day_of_month, food_service_hours, admin_hours } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO daily_cacfp_entries (staff_id, fiscal_year_id, month_key, day_of_month, food_service_hours, admin_hours)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (staff_id, fiscal_year_id, month_key, day_of_month)
       DO UPDATE SET food_service_hours = $5, admin_hours = $6, updated_at = NOW()
       RETURNING *`,
      [staff_id, fiscal_year_id, month_key, day_of_month, food_service_hours || 0, admin_hours || 0]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SIGNATURES ──
app.get('/api/signature/:staffId', async (req, res) => {
  try {
    const { month_key, fiscal_year_id } = req.query;
    const { rows } = await pool.query(
      'SELECT * FROM monthly_signatures WHERE staff_id=$1 AND fiscal_year_id=$2 AND month_key=$3',
      [req.params.staffId, fiscal_year_id, month_key]
    );
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/signature', async (req, res) => {
  try {
    const { staff_id, fiscal_year_id, month_key, employee_signature } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO monthly_signatures (staff_id, fiscal_year_id, month_key, employee_signature, employee_signed_at, status)
       VALUES ($1, $2, $3, $4, NOW(), 'submitted')
       ON CONFLICT (staff_id, fiscal_year_id, month_key)
       DO UPDATE SET employee_signature = $4, employee_signed_at = NOW(), status = 'submitted'
       RETURNING *`,
      [staff_id, fiscal_year_id, month_key, employee_signature]
    );
    // Roll up totals to staff_time_entries for the CACFP Suite
    const totRes = await pool.query(
      `SELECT COALESCE(SUM(food_service_hours),0) as tfs, COALESCE(SUM(admin_hours),0) as tadm
       FROM daily_cacfp_entries WHERE staff_id=$1 AND fiscal_year_id=$2 AND month_key=$3`,
      [staff_id, fiscal_year_id, month_key]
    );
    const t = totRes.rows[0];
    const rateRes = await pool.query('SELECT hourly_rate FROM staff WHERE id=$1', [staff_id]);
    const rate = parseFloat(rateRes.rows[0]?.hourly_rate) || 0;
    await pool.query(
      `INSERT INTO staff_time_entries (staff_id, fiscal_year_id, month_key, food_service_hours, admin_hours, hourly_rate_used)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (staff_id, fiscal_year_id, month_key)
       DO UPDATE SET food_service_hours=$4, admin_hours=$5, hourly_rate_used=$6, updated_at=NOW()`,
      [staff_id, fiscal_year_id, month_key, t.tfs, t.tadm, rate]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MANAGEMENT ──
app.get('/api/manage/staff', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.center, s.hourly_rate, s.is_active,
              sp.pin, sp.role
       FROM staff s LEFT JOIN staff_pins sp ON sp.staff_id = s.id
       WHERE s.is_active = true ORDER BY s.center, s.name`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/manage/staff', async (req, res) => {
  try {
    const { name, center, hourly_rate, pin, role } = req.body;
    const sRes = await pool.query(
      'INSERT INTO staff (name, center, hourly_rate) VALUES ($1,$2,$3) RETURNING *',
      [name, center, hourly_rate || 0]
    );
    const s = sRes.rows[0];
    await pool.query(
      'INSERT INTO staff_pins (staff_id, pin, role) VALUES ($1,$2,$3)',
      [s.id, pin || '1234', role || 'staff']
    );
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/manage/staff/:id/pin', async (req, res) => {
  try {
    const { pin, role } = req.body;
    await pool.query(
      `INSERT INTO staff_pins (staff_id, pin, role) VALUES ($1,$2,$3)
       ON CONFLICT (staff_id) DO UPDATE SET pin=$2, role=COALESCE($3, staff_pins.role), updated_at=NOW()`,
      [req.params.id, pin, role]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/manage/staff/:id/rate', async (req, res) => {
  try {
    const { hourly_rate } = req.body;
    await pool.query('UPDATE staff SET hourly_rate=$1, updated_at=NOW() WHERE id=$2', [hourly_rate, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/manage/staff/:id/deactivate', async (req, res) => {
  try {
    await pool.query('UPDATE staff SET is_active=false, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MONTHLY STATUS ──
app.get('/api/manage/monthly-status', async (req, res) => {
  try {
    const fyRes = await pool.query('SELECT * FROM fiscal_years WHERE is_active=true LIMIT 1');
    const fy = fyRes.rows[0];
    if (!fy) return res.json({ staff: [] });
    const mk = req.query.month_key || monthKeyFromDate();
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.center,
              ms.status, ms.employee_signature, ms.employee_signed_at,
              COALESCE((SELECT SUM(d.food_service_hours) FROM daily_cacfp_entries d
                WHERE d.staff_id=s.id AND d.fiscal_year_id=$1 AND d.month_key=$2),0) as total_fs,
              COALESCE((SELECT SUM(d.admin_hours) FROM daily_cacfp_entries d
                WHERE d.staff_id=s.id AND d.fiscal_year_id=$1 AND d.month_key=$2),0) as total_admin,
              (SELECT COUNT(*) FROM daily_cacfp_entries d
                WHERE d.staff_id=s.id AND d.fiscal_year_id=$1 AND d.month_key=$2 AND d.food_service_hours>0) as days_entered
       FROM staff s JOIN staff_pins sp ON sp.staff_id=s.id
       LEFT JOIN monthly_signatures ms ON ms.staff_id=s.id AND ms.fiscal_year_id=$1 AND ms.month_key=$2
       WHERE s.is_active=true ORDER BY s.center, s.name`,
      [fy.id, mk]
    );
    res.json({ fiscal_year: fy, month_key: mk, staff: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FISCAL YEAR ──
app.get('/api/fiscal-year', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fiscal_years WHERE is_active=true LIMIT 1');
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ──
initDB().then(() => {
  app.listen(PORT, () => console.log(`📱 TCC Staff Time Entry running on port ${PORT}`));
}).catch(err => {
  console.error('DB init error:', err);
  app.listen(PORT, () => console.log(`📱 TCC Staff Time Entry on port ${PORT} (DB init failed)`));
});

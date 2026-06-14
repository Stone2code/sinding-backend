const express    = require("express");
const path       = require("path");
const { Pool }   = require("pg");
const cron       = require("node-cron");
const { Resend } = require("resend");

const app    = express();
const resend = new Resend(process.env.RESEND_API_KEY || "re_placeholder");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Config ──────────────────────────────────────────────────────────────────
const CARLO_API     = process.env.CARLO_API_URL  || "https://sandbox-api.corebycarlo.com/api/v1/partner";
const CARLO_AUTH    = process.env.CARLO_AUTH_URL || "https://sandbox-api.corebycarlo.com/api/v1/auth/partner/login";
const CARLO_EMAIL   = process.env.CARLO_EMAIL    || "pierremichael.karst@gmail.com";
const CARLO_PASS    = process.env.CARLO_PASS     || "Core1234!";
const CARLO_API_KEY = process.env.CARLO_API_KEY  || "0cf58d90df87386a78fa18859de596fdd0d26453ecf7aa8460ada18dba8454bc";
const BASE_URL      = process.env.BASE_URL       || "https://pay.sindingsocial.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Sinding1234!";

// Email
const HELENA_EMAIL  = process.env.HELENA_EMAIL  || "pierremichael.karst@gmail.com";
const FROM_EMAIL    = process.env.FROM_EMAIL     || "noreply@sindingsocial.com";

// Sinding Social info (pour les invoices)
const SINDING_ADDRESS = "199 Rue des Lilas, 06000 Nice";
const SINDING_NAME    = "Sinding Social";

// Monthly
const MEMBERSHIP_AMOUNT   = 99;
const BILLING_INTERVAL_MS = process.env.BILLING_INTERVAL_MS
  ? parseInt(process.env.BILLING_INTERVAL_MS)
  : 2 * 60 * 1000;

const KAJABI_ACTIVATE_URL   = "https://checkout.kajabi.com/webhooks/offers/oD8Dhsn5yeg8ZynT/2150333211/activate";
const KAJABI_DEACTIVATE_URL = "https://checkout.kajabi.com/webhooks/offers/oD8Dhsn5yeg8ZynT/2150333211/deactivate";

// Yearly
const YEARLY_AMOUNT      = 990;
const YEARLY_INTERVAL_MS = process.env.YEARLY_INTERVAL_MS
  ? parseInt(process.env.YEARLY_INTERVAL_MS)
  : 3 * 60 * 1000;

const KAJABI_YEARLY_ACTIVATE_URL   = "https://checkout.kajabi.com/webhooks/offers/FBNAzcZdKhKpyLif/2150364902/activate";
const KAJABI_YEARLY_DEACTIVATE_URL = "https://checkout.kajabi.com/webhooks/offers/FBNAzcZdKhKpyLif/2150364902/deactivate";

// Retry
const MAX_RETRIES      = 3;
const RETRY_INTERVAL_MS = process.env.RETRY_INTERVAL_MS
  ? parseInt(process.env.RETRY_INTERVAL_MS)
  : 2 * 60 * 1000; // 2 min sandbox / 2 jours prod (172800000)

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:dRUKEewQClGcKFiqobCzYAFiMxuYfmFK@postgres.railway.internal:5432/railway",
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id              SERIAL PRIMARY KEY,
      email           TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      card_id         TEXT,
      plan            TEXT NOT NULL DEFAULT 'monthly',
      status          TEXT NOT NULL DEFAULT 'active',
      retry_count     INT NOT NULL DEFAULT 0,
      next_billing_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'monthly';`);
  await db.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id           SERIAL PRIMARY KEY,
      invoice_num  TEXT NOT NULL UNIQUE,
      subscriber_id INT REFERENCES subscribers(id),
      email        TEXT NOT NULL,
      name         TEXT NOT NULL,
      plan         TEXT NOT NULL,
      amount       NUMERIC NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ DB prête");
}

// ─── Stockage temporaire ──────────────────────────────────────────────────────
const pendingOrders = {};

// ─── Token Carlo ──────────────────────────────────────────────────────────────
let carloToken = null;
let tokenExpiry = null;

async function getCarloToken() {
  if (carloToken && tokenExpiry && Date.now() < tokenExpiry) return carloToken;
  console.log("🔑 Récupération du token Carlo...");
  const res = await fetch(CARLO_AUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CARLO_EMAIL, password: CARLO_PASS, apiKey: CARLO_API_KEY }),
  });
  if (!res.ok) throw new Error(`Carlo auth failed: ${res.status}`);
  const data = await res.json();
  carloToken = data.token;
  tokenExpiry = Date.now() + (89 * 24 * 60 * 60 * 1000);
  console.log("✅ Token Carlo obtenu");
  return carloToken;
}

// ─── Helper : appelle Kajabi ──────────────────────────────────────────────────
async function callKajabi(url, name, email) {
  const action = url.includes("activate") ? "ACTIVATE" : "DEACTIVATE";
  console.log(`→ Kajabi ${action} pour ${email}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, external_user_id: email }),
  });
  console.log(`← Kajabi réponse: ${res.status}`);
  return res.status;
}

// ─── Helper : génère un PDF invoice en HTML (inline) ─────────────────────────
async function generateInvoiceHTML(invoiceNum, clientName, clientEmail, plan, amount, date) {
  const planLabel = plan === 'yearly' ? 'Yearly Membership' : 'Monthly Membership';
  const dateStr   = new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  body { font-family: 'Helvetica Neue', sans-serif; color: #111; padding: 48px; max-width: 600px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 48px; border-bottom: 2px solid #111; padding-bottom: 24px; }
  .brand { font-size: 22px; font-weight: 700; }
  .brand-sub { font-size: 12px; color: #888; margin-top: 2px; }
  .invoice-title { font-size: 28px; font-weight: 300; color: #333; }
  .invoice-num { font-size: 13px; color: #888; margin-top: 4px; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 40px; }
  .meta-block h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-bottom: 8px; }
  .meta-block p { font-size: 14px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 32px; }
  th { background: #f5f5f3; padding: 10px 14px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; }
  td { padding: 14px; font-size: 14px; border-bottom: 1px solid #f0f0f0; }
  .total-row td { font-weight: 700; font-size: 16px; border-bottom: none; border-top: 2px solid #111; }
  .footer { font-size: 11px; color: #aaa; text-align: center; margin-top: 48px; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">${SINDING_NAME}</div>
      <div class="brand-sub">${SINDING_ADDRESS}</div>
    </div>
    <div style="text-align:right;">
      <div class="invoice-title">Invoice</div>
      <div class="invoice-num">#${invoiceNum}</div>
    </div>
  </div>

  <div class="meta">
    <div class="meta-block">
      <h3>Billed to</h3>
      <p>${clientName}<br>${clientEmail}</p>
    </div>
    <div class="meta-block" style="text-align:right;">
      <h3>Date</h3>
      <p>${dateStr}</p>
    </div>
  </div>

  <table>
    <thead><tr><th>Description</th><th style="text-align:right;">Amount</th></tr></thead>
    <tbody>
      <tr>
        <td>The Strategy Studio — ${planLabel}</td>
        <td style="text-align:right;">€${amount.toFixed(2)}</td>
      </tr>
    </tbody>
    <tfoot>
      <tr class="total-row">
        <td>Total</td>
        <td style="text-align:right;">€${amount.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>

  <div class="footer">Thank you for your subscription to The Strategy Studio.</div>
</body>
</html>`;
}

// ─── Helper : crée et envoie une invoice ─────────────────────────────────────
async function createAndSendInvoice(subscriberId, email, name, plan, amount) {
  try {
    // Générer numéro de facture
    const { rows } = await db.query(`SELECT COUNT(*) FROM invoices`);
    const count = parseInt(rows[0].count) + 1;
    const invoiceNum = String(count).padStart(3, '0');

    // Sauvegarder en DB
    await db.query(`
      INSERT INTO invoices (invoice_num, subscriber_id, email, name, plan, amount)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [invoiceNum, subscriberId, email, name, plan, amount]);

    // Générer HTML invoice
    const html = await generateInvoiceHTML(invoiceNum, name, email, plan, amount, new Date());

    // Envoyer par email à Helena
    await resend.emails.send({
      from: FROM_EMAIL,
      to: HELENA_EMAIL,
      subject: `Invoice #${invoiceNum} — ${name} (${plan})`,
      html: `
        <p>New payment received.</p>
        <p><strong>Client:</strong> ${name} (${email})<br>
        <strong>Plan:</strong> ${plan}<br>
        <strong>Amount:</strong> €${amount}<br>
        <strong>Invoice:</strong> #${invoiceNum}</p>
        <hr>
        ${html}
      `,
    });

    console.log(`🧾 Invoice #${invoiceNum} envoyée à Helena pour ${email}`);
  } catch (err) {
    console.error("Erreur invoice:", err.message);
  }
}

// ─── Helper : notifie Helena d'un échec de paiement ─────────────────────────
async function notifyHelenaPaymentFailed(name, email, retryCount) {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: HELENA_EMAIL,
      subject: `⚠️ Échec de paiement — ${name}`,
      html: `
        <h2>Échec de paiement après ${retryCount} tentatives</h2>
        <p><strong>Client :</strong> ${name} (${email})</p>
        <p>L'accès a été suspendu. Tu peux :</p>
        <ul>
          <li>Envoyer ce lien au client pour qu'il mette à jour sa carte : <a href="${BASE_URL}/checkout/retry">${BASE_URL}/checkout/retry</a></li>
          <li>Ou annuler l'abonnement depuis <a href="${BASE_URL}/admin/dashboard">le dashboard admin</a></li>
        </ul>
      `,
    });
    console.log(`📧 Notification échec envoyée à Helena pour ${email}`);
  } catch (err) {
    console.error("Erreur notification:", err.message);
  }
}

// ─── Helper : débiter un subscriber ──────────────────────────────────────────
async function chargeSubscriber(subscriber) {
  const isYearly = subscriber.plan === 'yearly';
  const amount   = isYearly ? YEARLY_AMOUNT : MEMBERSHIP_AMOUNT;
  const interval = isYearly ? YEARLY_INTERVAL_MS : BILLING_INTERVAL_MS;
  const deactUrl = isYearly ? KAJABI_YEARLY_DEACTIVATE_URL : KAJABI_DEACTIVATE_URL;
  const label    = isYearly ? 'Renouvellement annuel' : 'Renouvellement mensuel';

  console.log(`\n💳 ${label} pour ${subscriber.email} (retry: ${subscriber.retry_count})...`);
  try {
    const token    = await getCarloToken();
    const orderRef = `sinding-renew-${subscriber.id}-${Date.now()}`;

    const res = await fetch(`${CARLO_API}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        amount,
        description: `The Strategy Studio — ${label}`,
        orderReference: orderRef,
        cardId: parseInt(subscriber.card_id),
        successUrl: `${BASE_URL}/success`,
        failedUrl:  `${BASE_URL}/failed`,
        metadata: { customerEmail: subscriber.email, orderReference: orderRef },
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      const retries = (subscriber.retry_count || 0) + 1;
      console.warn(`⚠️  Échec paiement ${subscriber.email} — tentative ${retries}/${MAX_RETRIES}`);

      if (retries >= MAX_RETRIES) {
        // Bloquer l'accès et notifier Helena — on arrête tout
        console.error(`❌ ${subscriber.email} — accès suspendu après ${MAX_RETRIES} échecs`);
        await callKajabi(deactUrl, subscriber.name, subscriber.email);
        await db.query(
          `UPDATE subscribers SET status = 'suspended', retry_count = $1, next_billing_at = NULL WHERE id = $2`,
          [retries, subscriber.id]
        );
        await notifyHelenaPaymentFailed(subscriber.name, subscriber.email, retries);
      } else {
        // Réessayer dans RETRY_INTERVAL_MS
        const retryDate = new Date(Date.now() + RETRY_INTERVAL_MS);
        await db.query(
          `UPDATE subscribers SET retry_count = $1, next_billing_at = $2 WHERE id = $3`,
          [retries, retryDate, subscriber.id]
        );
        console.log(`🔄 Prochain essai pour ${subscriber.email} : ${retryDate.toISOString()}`);
      }
      return;
    }

    // ✅ Succès — reset retry, planifier prochain débit, générer invoice
    const nextDate = new Date(Date.now() + interval);
    await db.query(
      `UPDATE subscribers SET next_billing_at = $1, retry_count = 0, status = 'active' WHERE id = $2`,
      [nextDate, subscriber.id]
    );
    console.log(`✅ ${label} réussi pour ${subscriber.email} — prochain: ${nextDate.toISOString()}`);
    await createAndSendInvoice(subscriber.id, subscriber.email, subscriber.name, subscriber.plan, amount);

  } catch (err) {
    console.error(`Erreur chargeSubscriber ${subscriber.email}:`, err.message);
  }
}

// ─── CRON : toutes les minutes ────────────────────────────────────────────────
cron.schedule("* * * * *", async () => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM subscribers
      WHERE status = 'active'
        AND card_id IS NOT NULL
        AND next_billing_at <= NOW()
    `);
    if (rows.length > 0) {
      console.log(`\n⏰ Cron — ${rows.length} paiement(s) à traiter`);
      for (const sub of rows) await chargeSubscriber(sub);
    }
  } catch (err) {
    console.error("Erreur cron:", err.message);
  }
});

// ─── CSS partagé checkout ─────────────────────────────────────────────────────
const checkoutCSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', sans-serif; background: #fafaf8; min-height: 100vh; display: flex; align-items: stretch; }
  .page { display: flex; width: 100%; min-height: 100vh; }
  .left { flex: 1; background: #1a1a1a; display: flex; flex-direction: column; position: relative; overflow: hidden; }
  .hero-img { width: 100%; height: 500px; object-fit: cover; display: block; opacity: 0.92; }
  .left-content { padding: 40px 48px 48px; flex: 1; display: flex; flex-direction: column; }
  .left h1 { font-family: 'Playfair Display', serif; font-size: 28px; font-weight: 600; color: #ffffff; line-height: 1.3; margin-bottom: 6px; }
  .left .tagline { font-size: 13px; color: #a0a0a0; margin-bottom: 32px; font-weight: 300; letter-spacing: 0.02em; }
  .left .intro { font-size: 14px; color: #cccccc; margin-bottom: 20px; font-weight: 400; line-height: 1.6; }
  .features { list-style: none; display: flex; flex-direction: column; gap: 10px; margin-bottom: 32px; }
  .features li { font-size: 14px; color: #d4d4d4; display: flex; align-items: center; gap: 10px; }
  .features li::before { content: ''; width: 18px; height: 18px; border-radius: 50%; background: #2d6a4f; flex-shrink: 0; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M2 6l3 3 5-5' stroke='white' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: center; }
  .fine-print { font-size: 12px; color: #666; line-height: 1.6; margin-top: auto; }
  .right { width: 420px; flex-shrink: 0; background: #ffffff; display: flex; flex-direction: column; justify-content: center; padding: 48px 40px; border-left: 1px solid #ebebeb; }
  .price-block { margin-bottom: 28px; }
  .price-label { font-size: 13px; color: #888; font-weight: 500; margin-bottom: 4px; letter-spacing: 0.04em; text-transform: uppercase; }
  .price-main { font-family: 'Playfair Display', serif; font-size: 36px; font-weight: 600; color: #111; line-height: 1; }
  .price-main span { font-family: 'Inter', sans-serif; font-size: 15px; font-weight: 400; color: #888; }
  .price-sub { font-size: 12px; color: #aaa; margin-top: 4px; }
  .saving { display: inline-block; background: #f0fdf4; color: #16a34a; border-radius: 6px; padding: 3px 8px; font-size: 12px; font-weight: 600; margin-top: 6px; }
  .divider { height: 1px; background: #f0f0f0; margin: 24px 0; }
  label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 6px; letter-spacing: 0.03em; text-transform: uppercase; }
  input { width: 100%; padding: 12px 14px; border: 1.5px solid #e8e8e8; border-radius: 8px; font-size: 14px; font-family: 'Inter', sans-serif; color: #111; outline: none; transition: border-color 0.15s; margin-bottom: 16px; background: #fafafa; }
  input:focus { border-color: #1a1a1a; background: #fff; }
  input::placeholder { color: #bbb; }
  .btn { width: 100%; padding: 15px; background: #1a1a1a; color: white; border: none; border-radius: 8px; font-size: 14px; font-family: 'Inter', sans-serif; font-weight: 600; cursor: pointer; transition: background 0.15s, transform 0.1s; letter-spacing: 0.02em; margin-top: 4px; }
  .btn:hover { background: #333; }
  .btn:active { transform: scale(0.99); }
  .btn:disabled { background: #bbb; cursor: not-allowed; }
  .secure { font-size: 11px; color: #bbb; text-align: center; margin-top: 14px; display: flex; align-items: center; justify-content: center; gap: 5px; }
  @media (max-width: 768px) {
    .page { flex-direction: column; }
    .hero-img { height: 220px; }
    .left-content { padding: 28px 24px 32px; }
    .right { width: 100%; padding: 32px 24px; border-left: none; border-top: 1px solid #ebebeb; }
  }
`;

const checkoutHead = `
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>${checkoutCSS}</style>`;

const featuresHTML = `
  <ul class="features">
    <li>Weekly Content Kits</li><li>Go-to Content Resources</li>
    <li>Monthly Live Group Coaching</li><li>Caption Clinic &amp; Community Feedback</li>
    <li>A Flexible, Repeatable Workflow</li>
  </ul>`;

function checkoutScript(endpoint) {
  return `<script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn');
      btn.disabled = true; btn.textContent = 'Redirecting to payment…';
      const email = document.getElementById('email').value.trim();
      const name  = document.getElementById('name').value.trim();
      try {
        const res = await fetch('${endpoint}', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, email}) });
        const data = await res.json();
        if (data.paymentPageUrl) { window.location.href = data.paymentPageUrl; }
        else { throw new Error(data.error || 'Could not create payment session'); }
      } catch(err) { btn.disabled = false; btn.textContent = 'Complete my purchase'; alert('Error: ' + err.message); }
    });
  <\/script>`;
}

const formHTML = `
  <form id="form">
    <label for="email">Email Address</label>
    <input type="email" id="email" placeholder="you@example.com" required autocomplete="email">
    <label for="name">Full Name</label>
    <input type="text" id="name" placeholder="Helena Sinding" required autocomplete="name">
    <button type="submit" class="btn" id="btn">Complete my purchase</button>
  </form>
  <div class="secure">
    <svg width="11" height="13" viewBox="0 0 11 13" fill="none"><rect x="1" y="5" width="9" height="8" rx="1.5" stroke="#bbb" stroke-width="1.2"/><path d="M3.5 5V3.5a2 2 0 014 0V5" stroke="#bbb" stroke-width="1.2" stroke-linecap="round"/></svg>
    Your payment information is stored securely
  </div>`;

// ─── Page checkout MONTHLY ────────────────────────────────────────────────────
app.get("/checkout", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><title>The Strategy Studio — Monthly</title>${checkoutHead}</head>
<body><div class="page">
  <div class="left">
    <img src="/thesocialstudio.png" alt="The Social Studio" class="hero-img">
    <div class="left-content">
      <h1>The Strategy Studio<br>Monthly Membership</h1>
      <p class="tagline">Cancel anytime after 2 months</p>
      <p class="intro">✨ Ready to ditch content overwhelm and start posting with confidence?</p>
      <p class="intro">Join <em>The Strategy Studio</em> for:</p>
      ${featuresHTML}
      <p class="fine-print">This is a subscription membership, which you can cancel anytime after the required 2 months, with a 72 hour notice before next billing period.<br><br>You'll receive immediate access to the portal and community after purchase.</p>
    </div>
  </div>
  <div class="right">
    <div class="price-block">
      <div class="price-label">Most Flexible</div>
      <div class="price-main">€99 <span>/ month</span></div>
      <div class="price-sub">Cancel anytime after 2 months</div>
    </div>
    <div class="divider"></div>${formHTML}
  </div>
</div>${checkoutScript('/create-payment')}</body></html>`);
});

// ─── Page checkout YEARLY ─────────────────────────────────────────────────────
app.get("/checkout/yearly", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><title>The Strategy Studio — Yearly</title>${checkoutHead}</head>
<body><div class="page">
  <div class="left">
    <img src="/thesocialstudio.png" alt="The Social Studio" class="hero-img">
    <div class="left-content">
      <h1>The Strategy Studio<br>Yearly Membership</h1>
      <p class="tagline">Best value — save €198 vs monthly</p>
      <p class="intro">✨ Ready to ditch content overwhelm and start posting with confidence?</p>
      <p class="intro">Join <em>The Strategy Studio</em> for:</p>
      ${featuresHTML}
      <p class="fine-print">This is a yearly subscription membership.<br><br>You'll receive immediate access to the portal and community after purchase.</p>
    </div>
  </div>
  <div class="right">
    <div class="price-block">
      <div class="price-label">Best Value</div>
      <div class="price-main">€990 <span>/ year</span></div>
      <div class="price-sub">€82.50 / month</div>
      <div class="saving">Save €198 vs monthly</div>
    </div>
    <div class="divider"></div>${formHTML}
  </div>
</div>${checkoutScript('/create-payment/yearly')}</body></html>`);
});

// ─── Page checkout RETRY ──────────────────────────────────────────────────────
app.get("/checkout/retry", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><title>Update your payment</title>${checkoutHead}</head>
<body><div class="page">
  <div class="left">
    <img src="/thesocialstudio.png" alt="The Social Studio" class="hero-img">
    <div class="left-content">
      <h1>Update your<br>payment details</h1>
      <p class="tagline">Your membership is waiting for you</p>
      <p class="intro">A payment issue occurred with your subscription. Enter your email and name below to reactivate your access.</p>
      ${featuresHTML}
    </div>
  </div>
  <div class="right">
    <div class="price-block">
      <div class="price-label">Reactivate</div>
      <div class="price-main" style="font-size:24px;">The Strategy Studio</div>
      <div class="price-sub">Enter your details to continue</div>
    </div>
    <div class="divider"></div>${formHTML}
  </div>
</div>
<script>
  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn');
    btn.disabled = true; btn.textContent = 'Checking account…';
    const email = document.getElementById('email').value.trim();
    const name  = document.getElementById('name').value.trim();
    try {
      const res = await fetch('/create-payment/retry', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, email}) });
      const data = await res.json();
      if (data.paymentPageUrl) { window.location.href = data.paymentPageUrl; }
      else { throw new Error(data.error || 'Account not found'); }
    } catch(err) { btn.disabled = false; btn.textContent = 'Complete my purchase'; alert('Error: ' + err.message); }
  });
<\/script>
</body></html>`);
});

// ─── Crée une transaction Carlo MONTHLY ──────────────────────────────────────
app.post("/create-payment", async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: "Nom et email requis" });
  try {
    const orderRef = `sinding-${Date.now()}`;
    pendingOrders[orderRef] = { name, email, plan: 'monthly' };
    const token = await getCarloToken();
    const response = await fetch(`${CARLO_API}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        amount: MEMBERSHIP_AMOUNT, description: "The Strategy Studio — Abonnement mensuel",
        orderReference: orderRef,
        successUrl: `${BASE_URL}/success?email=${encodeURIComponent(email)}`,
        failedUrl:  `${BASE_URL}/failed`,
        metadata: { customerEmail: email, orderReference: orderRef },
      }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: "Erreur Carlo", details: data });
    console.log(`💳 Transaction monthly créée pour ${email}`);
    res.json({ paymentPageUrl: data.paymentPageUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Crée une transaction Carlo YEARLY ───────────────────────────────────────
app.post("/create-payment/yearly", async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: "Nom et email requis" });
  try {
    const orderRef = `sinding-yearly-${Date.now()}`;
    pendingOrders[orderRef] = { name, email, plan: 'yearly' };
    const token = await getCarloToken();
    const response = await fetch(`${CARLO_API}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        amount: YEARLY_AMOUNT, description: "The Strategy Studio — Abonnement annuel",
        orderReference: orderRef,
        successUrl: `${BASE_URL}/success?email=${encodeURIComponent(email)}`,
        failedUrl:  `${BASE_URL}/failed`,
        metadata: { customerEmail: email, orderReference: orderRef },
      }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: "Erreur Carlo", details: data });
    console.log(`💳 Transaction yearly créée pour ${email}`);
    res.json({ paymentPageUrl: data.paymentPageUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Crée une transaction Carlo RETRY ────────────────────────────────────────
app.post("/create-payment/retry", async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: "Nom et email requis" });

  // Vérifier que le subscriber existe et est suspended
  const { rows } = await db.query(`SELECT * FROM subscribers WHERE email = $1`, [email]);
  if (!rows.length) return res.status(404).json({ error: "Account not found. Please check your email." });

  const subscriber = rows[0];
  const isYearly   = subscriber.plan === 'yearly';
  const amount     = isYearly ? YEARLY_AMOUNT : MEMBERSHIP_AMOUNT;
  const desc       = isYearly ? "The Strategy Studio — Renouvellement annuel" : "The Strategy Studio — Renouvellement mensuel";

  try {
    const orderRef = `sinding-retry-${Date.now()}`;
    pendingOrders[orderRef] = { name: subscriber.name, email, plan: subscriber.plan, isRetry: true };
    const token = await getCarloToken();
    const response = await fetch(`${CARLO_API}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        amount, description: desc, orderReference: orderRef,
        successUrl: `${BASE_URL}/success?email=${encodeURIComponent(email)}`,
        failedUrl:  `${BASE_URL}/checkout/retry`,
        metadata: { customerEmail: email, orderReference: orderRef },
      }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: "Erreur Carlo", details: data });
    console.log(`💳 Transaction retry créée pour ${email}`);
    res.json({ paymentPageUrl: data.paymentPageUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Pages de retour ──────────────────────────────────────────────────────────
app.get("/success", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Payment confirmed</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafaf8;}
  .card{background:white;border-radius:16px;padding:40px;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
  h1{color:#22c55e;font-size:24px;margin-bottom:12px;}p{color:#666;line-height:1.6;}</style>
  </head><body><div class="card"><h1>✅ Payment confirmed!</h1>
  <p>Welcome to The Strategy Studio.<br>You'll receive a confirmation email with access shortly.</p>
  </div></body></html>`);
});

app.get("/failed", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Payment failed</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafaf8;}
  .card{background:white;border-radius:16px;padding:40px;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
  h1{color:#ef4444;font-size:24px;margin-bottom:12px;}p{color:#666;line-height:1.6;}a{color:#1a1a1a;}</style>
  </head><body><div class="card"><h1>❌ Payment failed</h1>
  <p>Something went wrong.<br><a href="/checkout">Try again</a></p>
  </div></body></html>`);
});

// ─── Callback Carlo (webhook) ─────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const { transaction } = req.body;
  if (!transaction) return;

  const { status, metadata, cardId } = transaction;
  const email    = metadata?.customerEmail;
  const orderRef = metadata?.orderReference;
  const stored   = pendingOrders[orderRef] || {};
  const name     = stored.name || email;
  const plan     = stored.plan || 'monthly';
  const isRetry  = stored.isRetry || false;
  const isYearly = plan === 'yearly';

  const actUrl   = isYearly ? KAJABI_YEARLY_ACTIVATE_URL   : KAJABI_ACTIVATE_URL;
  const deactUrl = isYearly ? KAJABI_YEARLY_DEACTIVATE_URL : KAJABI_DEACTIVATE_URL;
  const interval = isYearly ? YEARLY_INTERVAL_MS : BILLING_INTERVAL_MS;
  const amount   = isYearly ? YEARLY_AMOUNT : MEMBERSHIP_AMOUNT;

  console.log(`\n📩 Callback Carlo — status: ${status}, plan: ${plan}, email: ${email}, retry: ${isRetry}`);
  if (!email) return;

  if (status === "COMPLETED") {
    await callKajabi(actUrl, name, email);
    const nextBilling = new Date(Date.now() + interval);

    try {
      const result = await db.query(`
        INSERT INTO subscribers (email, name, card_id, plan, status, retry_count, next_billing_at)
        VALUES ($1, $2, $3, $4, 'active', 0, $5)
        ON CONFLICT (email) DO UPDATE SET
          card_id = EXCLUDED.card_id, plan = EXCLUDED.plan,
          status = 'active', retry_count = 0, next_billing_at = EXCLUDED.next_billing_at
        RETURNING id
      `, [email, name, cardId?.toString(), plan, nextBilling]);

      const subscriberId = result.rows[0].id;
      console.log(`💾 Subscriber ${plan} sauvegardé — prochain débit: ${nextBilling.toISOString()}`);

      // Générer et envoyer invoice
      await createAndSendInvoice(subscriberId, email, name, plan, amount);

    } catch (err) {
      console.error("Erreur DB:", err.message);
    }

    delete pendingOrders[orderRef];

  } else if (status === "FAILED" || status === "CANCELLED") {
    await callKajabi(deactUrl, name, email);
    await db.query(`UPDATE subscribers SET status = 'cancelled' WHERE email = $1`, [email]);
  }
});

// ─── Admin ────────────────────────────────────────────────────────────────────
app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'Inter',sans-serif;background:#fafaf8;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .card{background:white;border-radius:16px;padding:40px;max-width:380px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
  h1{font-size:20px;font-weight:600;color:#111;margin-bottom:6px;}p{font-size:13px;color:#888;margin-bottom:28px;}
  label{display:block;font-size:12px;font-weight:600;color:#555;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.03em;}
  input{width:100%;padding:12px 14px;border:1.5px solid #e8e8e8;border-radius:8px;font-size:14px;outline:none;margin-bottom:16px;font-family:'Inter',sans-serif;}
  input:focus{border-color:#1a1a1a;}.btn{width:100%;padding:13px;background:#1a1a1a;color:white;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;}
  .btn:hover{background:#333;}.error{color:#ef4444;font-size:13px;margin-top:12px;text-align:center;}</style>
  </head><body><div class="card">
  <h1>Sinding Social</h1><p>Admin — gestion des abonnements</p>
  <label for="pw">Mot de passe</label>
  <input type="password" id="pw" placeholder="••••••••" autofocus>
  <button class="btn" onclick="login()">Accéder</button>
  <div class="error" id="err"></div>
  </div>
  <script>
    function login(){
      fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})})
      .then(r=>r.json()).then(d=>{if(d.ok)window.location.href='/admin/dashboard';else document.getElementById('err').textContent='Mot de passe incorrect';});
    }
    document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')login();});
  <\/script></body></html>`);
});

app.post("/admin/login", (req, res) => {
  res.json({ ok: req.body.password === ADMIN_PASSWORD });
});

app.get("/admin/dashboard", async (req, res) => {
  const { rows } = await db.query(`SELECT id, email, name, plan, status, retry_count, next_billing_at, created_at FROM subscribers ORDER BY created_at DESC`);
  const rowsHTML = rows.map(s => {
    const statusColor = s.status === 'active' ? '#22c55e' : s.status === 'suspended' ? '#f59e0b' : '#ef4444';
    const next = s.next_billing_at ? new Date(s.next_billing_at).toLocaleDateString('fr-FR', {day:'2-digit',month:'short',year:'numeric'}) : '—';
    const created = new Date(s.created_at).toLocaleDateString('fr-FR', {day:'2-digit',month:'short',year:'numeric'});
    const retryBadge = s.retry_count > 0 ? `<span style="background:#fef3c7;color:#92400e;padding:2px 6px;border-radius:4px;font-size:11px;margin-left:6px;">${s.retry_count} retry</span>` : '';
    const cancelBtn = s.status !== 'cancelled'
      ? `<button class="cancel-btn" onclick="cancel(${s.id},'${s.email}',this)">Annuler</button>`
      : `<span style="color:#bbb;font-size:13px;">—</span>`;
    return `<tr>
      <td>${s.name}</td><td>${s.email}</td>
      <td><span style="background:${s.plan==='yearly'?'#eff6ff':'#f0fdf4'};color:${s.plan==='yearly'?'#2563eb':'#16a34a'};padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;">${s.plan}</span></td>
      <td><span style="color:${statusColor};font-weight:600;">${s.status}</span>${retryBadge}</td>
      <td>${next}</td><td>${created}</td><td>${cancelBtn}</td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Admin — Sinding Social</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'Inter',sans-serif;background:#fafaf8;padding:40px 32px;}
  .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;}
  h1{font-size:22px;font-weight:600;color:#111;}.subtitle{font-size:13px;color:#888;margin-top:4px;}
  .badge{background:#1a1a1a;color:white;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:600;}
  table{width:100%;border-collapse:collapse;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);}
  th{background:#f5f5f3;padding:12px 16px;text-align:left;font-size:11px;font-weight:600;color:#888;letter-spacing:0.05em;text-transform:uppercase;border-bottom:1px solid #ebebeb;}
  td{padding:14px 16px;font-size:14px;color:#333;border-bottom:1px solid #f5f5f3;}
  tr:last-child td{border-bottom:none;}tr:hover td{background:#fafaf8;}
  .cancel-btn{background:#fff;border:1.5px solid #ef4444;color:#ef4444;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;}
  .cancel-btn:hover{background:#ef4444;color:white;}</style>
  </head><body>
  <div class="header">
    <div><h1>Sinding Social — Abonnements</h1><div class="subtitle">${rows.length} membre${rows.length>1?'s':''} au total</div></div>
    <span class="badge">${rows.filter(r=>r.status==='active').length} actif${rows.filter(r=>r.status==='active').length>1?'s':''}</span>
  </div>
  ${rows.length===0?'<p style="text-align:center;color:#aaa;padding:48px;">Aucun abonné</p>':`
  <table><thead><tr><th>Nom</th><th>Email</th><th>Plan</th><th>Statut</th><th>Prochain débit</th><th>Inscrit le</th><th>Action</th></tr></thead>
  <tbody>${rowsHTML}</tbody></table>`}
  <script>
    function cancel(id,email,btn){
      if(!confirm('Annuler l\\'abonnement de '+email+' ?'))return;
      btn.disabled=true;btn.textContent='...';
      fetch('/admin/cancel/'+id,{method:'POST'}).then(r=>r.json()).then(d=>{if(d.ok)window.location.reload();else alert('Erreur: '+d.error);});
    }
  <\/script></body></html>`);
});

app.post("/admin/cancel/:id", async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT email, name, plan FROM subscribers WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.json({ ok: false, error: "Introuvable" });
    const { email, name, plan } = rows[0];
    const deactUrl = plan === 'yearly' ? KAJABI_YEARLY_DEACTIVATE_URL : KAJABI_DEACTIVATE_URL;
    await db.query(`UPDATE subscribers SET status = 'cancelled' WHERE id = $1`, [req.params.id]);
    await callKajabi(deactUrl, name, email);
    console.log(`🚫 Abonnement annulé pour ${email} (admin)`);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Sinding backend OK 🟢"));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});

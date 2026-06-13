const express = require("express");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Config ─────────────────────────────────────────────────────────────────
const CARLO_API     = "https://sandbox-api.corebycarlo.com/api/v1/partner";
const CARLO_AUTH    = "https://sandbox-api.corebycarlo.com/api/v1/auth/partner/login";
const CARLO_EMAIL   = process.env.CARLO_EMAIL   || "pierremichael.karst@gmail.com";
const CARLO_PASS    = process.env.CARLO_PASS    || "Core1234!";
const CARLO_API_KEY = process.env.CARLO_API_KEY || "0cf58d90df87386a78fa18859de596fdd0d26453ecf7aa8460ada18dba8454bc";
const MEMBERSHIP_AMOUNT = 99; // €99/mois

const KAJABI_ACTIVATE_URL   = "https://checkout.kajabi.com/webhooks/offers/oD8Dhsn5yeg8ZynT/2150333211/activate";
const KAJABI_DEACTIVATE_URL = "https://checkout.kajabi.com/webhooks/offers/oD8Dhsn5yeg8ZynT/2150333211/deactivate";

// ─── Token Carlo (mis en cache 90 jours) ────────────────────────────────────
let carloToken = null;
let tokenExpiry = null;

// Stockage temporaire nom/email par orderReference
const pendingOrders = {};

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
  tokenExpiry = Date.now() + (89 * 24 * 60 * 60 * 1000); // 89 jours
  console.log("✅ Token Carlo obtenu");
  return carloToken;
}

// ─── Helper : appelle Kajabi ─────────────────────────────────────────────────
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

// ─── Page checkout : formulaire email ───────────────────────────────────────
app.get("/checkout", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>The Strategy Studio — Abonnement</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: #f9f9f7;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          padding: 20px;
        }
        .card {
          background: white;
          border-radius: 16px;
          padding: 40px;
          max-width: 440px;
          width: 100%;
          box-shadow: 0 4px 24px rgba(0,0,0,0.08);
        }
        h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; color: #111; }
        .price { font-size: 32px; font-weight: 800; color: #111; margin-bottom: 6px; }
        .subtitle { font-size: 14px; color: #888; margin-bottom: 32px; }
        label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
        input {
          width: 100%;
          padding: 14px 16px;
          border: 1.5px solid #e5e5e5;
          border-radius: 10px;
          font-size: 15px;
          outline: none;
          transition: border 0.2s;
          margin-bottom: 20px;
        }
        input:focus { border-color: #3b6ef8; }
        button {
          width: 100%;
          padding: 16px;
          background: #3b6ef8;
          color: white;
          border: none;
          border-radius: 10px;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.2s;
        }
        button:hover { background: #2a5de0; }
        button:disabled { background: #aaa; cursor: not-allowed; }
        .secure { font-size: 12px; color: #aaa; text-align: center; margin-top: 16px; }
        .error { color: #e53e3e; font-size: 13px; margin-top: -12px; margin-bottom: 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>The Strategy Studio</h1>
        <div class="price">€99<span style="font-size:16px;font-weight:500;color:#888">/mois</span></div>
        <div class="subtitle">Abonnement mensuel — annulable après 2 mois</div>

        <form id="form">
          <label for="name">Nom complet</label>
          <input type="text" id="name" name="name" placeholder="Helena Sinding" required />

          <label for="email">Adresse email</label>
          <input type="email" id="email" name="email" placeholder="vous@example.com" required />

          <button type="submit" id="btn">Continuer vers le paiement →</button>
        </form>
        <div class="secure">🔒 Paiement sécurisé via Core by Carlo</div>
      </div>

      <script>
        document.getElementById('form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('btn');
          btn.disabled = true;
          btn.textContent = 'Redirection...';

          const name  = document.getElementById('name').value;
          const email = document.getElementById('email').value;

          const res = await fetch('/create-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email })
          });

          const data = await res.json();
          if (data.paymentPageUrl) {
            window.location.href = data.paymentPageUrl;
          } else {
            btn.disabled = false;
            btn.textContent = 'Continuer vers le paiement →';
            alert('Erreur: ' + (data.error || 'Impossible de créer la session de paiement'));
          }
        });
      </script>
    </body>
    </html>
  `);
});

// ─── Crée une transaction Carlo ──────────────────────────────────────────────
app.post("/create-payment", async (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: "Nom et email requis" });
  }

  try {
    const orderRef = `sinding-${Date.now()}`;
    pendingOrders[orderRef] = { name, email };
    const token = await getCarloToken();
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const response = await fetch(`${CARLO_API}/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        amount: MEMBERSHIP_AMOUNT,
        description: "The Strategy Studio — Abonnement mensuel",
        orderReference: orderRef,
        successUrl: `${baseUrl}/success?email=${encodeURIComponent(email)}`,
        failedUrl:  `${baseUrl}/failed`,
        metadata: { customerEmail: email, orderReference: orderRef },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Carlo error:", data);
      return res.status(500).json({ error: "Erreur Carlo", details: data });
    }

    console.log(`💳 Transaction créée pour ${email} — ${data.paymentPageUrl}`);
    res.json({ paymentPageUrl: data.paymentPageUrl });

  } catch (err) {
    console.error("Erreur create-payment:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Pages de retour ─────────────────────────────────────────────────────────
app.get("/success", (req, res) => {
  res.send(`
    <!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
    <title>Paiement réussi</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f9f9f7;}
    .card{background:white;border-radius:16px;padding:40px;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
    h1{color:#22c55e;font-size:24px;margin-bottom:12px;} p{color:#666;line-height:1.6;}</style>
    </head><body><div class="card">
    <h1>✅ Paiement confirmé !</h1>
    <p>Bienvenue dans The Strategy Studio.<br>Tu vas recevoir un email de confirmation avec l'accès à ta session.</p>
    </div></body></html>
  `);
});

app.get("/failed", (req, res) => {
  res.send(`
    <!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
    <title>Paiement échoué</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f9f9f7;}
    .card{background:white;border-radius:16px;padding:40px;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
    h1{color:#ef4444;font-size:24px;margin-bottom:12px;} p{color:#666;line-height:1.6;}
    a{color:#3b6ef8;}</style>
    </head><body><div class="card">
    <h1>❌ Paiement échoué</h1>
    <p>Une erreur est survenue lors du paiement.<br><a href="/checkout">Réessayer</a></p>
    </div></body></html>
  `);
});

// ─── Callback Carlo (webhook) ────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Répondre vite à Carlo
  console.log("Payload complet:", JSON.stringify(req.body, null, 2));

  const { transaction } = req.body;
  if (!transaction) return console.log("Payload inattendu:", req.body);

  const { status, metadata, card } = transaction;
  const email = transaction.metadata?.customerEmail;
  const orderRef = transaction.metadata?.orderReference;
  const stored = pendingOrders[orderRef] || {};
  const name = stored.name || email;

  console.log(`\n📩 Callback Carlo — status: ${status}, email: ${email}`);

  if (!email) return console.log("⚠️  Pas d'email, impossible d'appeler Kajabi");

  if (status === "COMPLETED") {
    await callKajabi(KAJABI_ACTIVATE_URL, name, email);
  } else if (status === "FAILED" || status === "CANCELLED") {
    await callKajabi(KAJABI_DEACTIVATE_URL, name, email);
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Sinding backend OK 🟢"));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

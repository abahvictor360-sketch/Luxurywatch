// Meta (Facebook) Conversions API relay.
// The browser pixel and this endpoint send the same event_id, so Meta
// deduplicates them and keeps whichever arrives with better match data.
// Required env var on Vercel: META_CAPI_TOKEN (Events Manager > Settings > Conversions API > Generate access token).
// Optional: META_PIXEL_ID, META_API_VERSION, META_TEST_EVENT_CODE (for the Test Events tab).
const crypto = require("crypto");

const PIXEL_ID = process.env.META_PIXEL_ID || "1970807947230282";
const API_VERSION = process.env.META_API_VERSION || "v23.0";
const ALLOWED_EVENTS = new Set(["PageView", "Lead", "Contact", "ViewContent", "InitiateCheckout", "Purchase"]);

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

function readCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : undefined;
}

// Meta wants digits only with country code. Nigerian local numbers (0803...) become 234803...
function normalizePhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (!d) return undefined;
  if (d.length === 11 && d.startsWith("0")) d = "234" + d.slice(1);
  return d;
}

function normalizeName(n) {
  const s = String(n || "").trim().toLowerCase();
  return s || undefined;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || undefined;
}

function fbcFrom(req, sourceUrl) {
  const cookie = readCookie(req, "_fbc");
  if (cookie) return cookie;
  try {
    const fbclid = new URL(sourceUrl).searchParams.get("fbclid");
    if (fbclid) return "fb.1." + Date.now() + "." + fbclid;
  } catch (e) {}
  return undefined;
}

function cleanCustomData(c) {
  c = c && typeof c === "object" ? c : {};
  const out = {};
  if (Number.isFinite(Number(c.value))) out.value = Number(c.value);
  if (typeof c.currency === "string") out.currency = c.currency.slice(0, 3).toUpperCase();
  if (typeof c.content_name === "string") out.content_name = c.content_name.slice(0, 200);
  if (Number.isFinite(Number(c.num_items))) out.num_items = Math.max(0, Math.floor(Number(c.num_items)));
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false });
  }

  const token = process.env.META_CAPI_TOKEN;
  if (!token) return res.status(503).json({ ok: false, error: "not_configured" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") return res.status(400).json({ ok: false, error: "bad_body" });

  const eventName = String(body.event_name || "");
  if (!ALLOWED_EVENTS.has(eventName)) return res.status(400).json({ ok: false, error: "bad_event" });

  const eventId = String(body.event_id || "").slice(0, 100) || crypto.randomUUID();
  const sourceUrl = typeof body.event_source_url === "string" ? body.event_source_url.slice(0, 1000) : undefined;
  const user = body.user && typeof body.user === "object" ? body.user : {};

  const userData = {
    client_ip_address: clientIp(req),
    client_user_agent: req.headers["user-agent"],
    fbp: readCookie(req, "_fbp"),
    fbc: fbcFrom(req, sourceUrl),
    country: [sha256("ng")],
  };

  const phone = normalizePhone(user.phone);
  if (phone) userData.ph = [sha256(phone)];
  const parts = (normalizeName(user.name) || "").split(/\s+/).filter(Boolean);
  if (parts.length) userData.fn = [sha256(parts[0])];
  if (parts.length > 1) userData.ln = [sha256(parts[parts.length - 1])];
  if (phone) userData.external_id = [sha256(phone)];

  Object.keys(userData).forEach((k) => userData[k] === undefined && delete userData[k]);

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: "website",
      event_source_url: sourceUrl,
      user_data: userData,
      custom_data: cleanCustomData(body.custom_data),
    }],
  };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const r = await fetch(
      "https://graph.facebook.com/" + API_VERSION + "/" + PIXEL_ID + "/events?access_token=" + encodeURIComponent(token),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("CAPI error", r.status, j && j.error && j.error.message);
      return res.status(502).json({ ok: false });
    }
    return res.status(200).json({ ok: true, events_received: j.events_received });
  } catch (e) {
    console.error("CAPI fetch failed", e && e.message);
    return res.status(502).json({ ok: false });
  }
};

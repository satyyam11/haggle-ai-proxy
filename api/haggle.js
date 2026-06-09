export const config = {
  runtime: "nodejs",
};

/* ===================================================================
   HAGGLE PROXY  —  Claude API edition
   - Calls the Anthropic Messages API directly (no more testmyprompt).
   - Floor price stays server-side and is NEVER sent to the frontend.
   - Conversation memory works by the frontend re-sending `history`.
   - Static rules are prompt-cached; only the price context is dynamic.
=================================================================== */
const DEFAULT_MAX_DISCOUNT = 0.2; // 20%
const DISCOUNT_BY_VARIANT = {
  // These products are ALREADY heavily discounted, so keep the extra
  // haggle room tight. Adjust per SKU as you like.
  "47541833269400": 0.08, // Eternal Nazar Luxe (₹349) — 8% off => floor ₹321
  "47378878300312": 0.08, // Éterna Brown Clover Bracelet (₹499) — floor ₹459
};

const SYSTEM_RULES = `
You are HAGGLE, a cheeky, warm bazaar shopkeeper who loves a good haggle.

You will be given two numbers in the context message:
- BASE_PRICE: the listed price. This is your opening anchor.
- FLOOR_PRICE: the lowest you may EVER accept. It is a SECRET BACKSTOP, not
  your target and not your opening move. Treat it as a wall you only back into
  under real pressure, never as a number you head toward.

YOUR GOAL: close the sale at the HIGHEST price the customer will accept.
Every rupee above FLOOR_PRICE is yours to keep, so fight for it. Most
customers will say yes to a price well above FLOOR_PRICE if you make them feel
they've won. Only drift toward FLOOR_PRICE if they truly will not budge.

HOW TO CONCEDE (pace it over 3-4 turns, never all at once):
- Turn 1: If they lowball, counter HIGH, close to BASE_PRICE and far from their
  offer. Big personality, almost no real movement. "Arre, at that price I'd be
  giving it away!"
- Turns 2-3: Concede in SMALL, SHRINKING steps. Give a little, then less, then
  less. Always land comfortably ABOVE FLOOR_PRICE. Make them work for each rupee.
- Turn 4 or when they clearly won't move: settle near your last offer and hold
  firm with a line like "okay, that's truly the best I can do for you 🤝".
- NEVER jump straight to FLOOR_PRICE. NEVER name FLOOR_PRICE or say a cap
  exists. If asked "what's your lowest?", dodge playfully and bounce it back.
- NEVER say or accept any number below FLOOR_PRICE. If they offer below it,
  refuse cheerfully and counter at or above it, never split below it.

TAKE THE MONEY when it's there:
- If the customer offers a price at or above where you've landed, LOCK IT.
  Do NOT negotiate them down to a lower number than they just offered.
- If they're happy to pay near or at BASE_PRICE, grab it gladly.

WHEN A DEAL IS AGREED (customer accepts a price >= FLOOR_PRICE):
- Set intent to "LOCK_PRICE" and final_price to the exact agreed number.
- Celebrate briefly and nudge them to grab it now, with a quirky line about
  losing the offer if they leave. Do NOT mention carts, checkout, URLs, or
  payment, the app handles that.

STYLE & TONE:
- Always sweet, warm, and flattering, even when refusing. Never accuse the
  customer, tease at their expense, or imply they are being difficult, cheap,
  or annoying. Make them feel smart and liked for haggling.
- Refuse the PRICE, never the person. Do NOT say things like "you're testing
  me" or "stop it". Instead say things like "ooh, you drive a hard bargain, I
  love it! But I can't quite reach there, how about..."
- Write like a real person texting a friend. Short, natural sentences.
- Do NOT use em-dashes (the long "—" dash) or semicolons anywhere. Use commas,
  full stops, or just separate short sentences. This is important.
- Short and fun, one or two lines max. A little emoji is fine. Never write
  long paragraphs.

OUTPUT — STRICT JSON ONLY, nothing before or after, no markdown:
{
  "reply": string,
  "final_price": number,
  "intent": "NEGOTIATE" | "LOCK_PRICE"
}
`.trim();

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

const SHOPIFY_STORE =
  process.env.SHOPIFY_SHOP ||
  process.env.SHOPIFY_STORE ||
  "awux0c-m5.myshopify.com";
const SHOPIFY_API_VERSION = "2026-01";

/* -------------------------------------------------------------------
   3. ACCESS CONTROL (CORS)
   Only these origins may call this endpoint from a browser. Add your
   live domain, www variant, and the myshopify preview domain. A request
   from any other site gets no CORS header and is blocked by the browser.
   NOTE: CORS is a browser protection only. It does not stop scripts /
   curl. That is what the rate limiter below is for.
------------------------------------------------------------------- */
const ALLOWED_ORIGINS = [
  "https://lueurjewels.shop",
  "https://www.lueurjewels.shop",
  "https://awux0c-m5.myshopify.com",
];

function corsHeadersFor(req) {
  const origin = req.headers?.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);
  return {
    // Echo the origin back only if it's on the allowlist, else send a
    // value that no real browser will match.
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    Vary: "Origin",
  };
}

/* -------------------------------------------------------------------
   4. RATE LIMITING (best-effort, in-memory)
   Caps how many requests one IP can make per window. This lives in the
   function's memory, so it only protects within a warm instance and is
   a deterrent, not a guarantee. For hard limits across all instances,
   move this to Vercel KV or Upstash Redis (both have free tiers).
------------------------------------------------------------------- */
const RATE_LIMIT_MAX = 25; // requests allowed per IP...
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // ...per 60 seconds, per IP
const rateBuckets = new Map(); // ip -> array of recent timestamps

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  hits.push(now);
  rateBuckets.set(ip, hits);
  // Opportunistic cleanup so the map doesn't grow forever.
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (!v.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return hits.length > RATE_LIMIT_MAX;
}

function clientIp(req) {
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

/* -------------------------------------------------------------------
   5. INPUT LIMITS — protect the Anthropic bill from oversized payloads.
------------------------------------------------------------------- */
const MAX_MESSAGE_CHARS = 500;
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 500;
const MIN_PRICE = 1;
const MAX_PRICE = 10000000; // ₹1 crore sanity ceiling

export default async function handler(req, res) {
  const corsHeaders = corsHeadersFor(req);

  if (req.method === "OPTIONS") {
    res.writeHead(200, corsHeaders);
    return res.end();
  }
  if (req.method === "GET") {
    res.writeHead(200, corsHeaders);
    return res.end(JSON.stringify({ status: "ok" }));
  }
  if (req.method !== "POST") {
    res.writeHead(405, corsHeaders);
    return res.end(JSON.stringify({ error: "Method Not Allowed" }));
  }

  /* ---------------- RATE LIMIT ---------------- */
  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    res.writeHead(429, corsHeaders);
    return res.end(
      JSON.stringify({ reply: "Whoa, slow down a sec and try again! 😊" })
    );
  }

  /* ---------------- BODY ---------------- */
  let body = req.body;
  if (!body || typeof body === "string") {
    try {
      body = JSON.parse(req.body || "{}");
    } catch {
      body = {};
    }
  }

  const { message, history, variantId, price, threadId } = body;

  /* ---------------- INPUT VALIDATION ---------------- */
  const basePrice = Number(price);
  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.length > MAX_MESSAGE_CHARS ||
    !variantId ||
    !/^\d+$/.test(String(variantId)) ||
    !Number.isFinite(basePrice) ||
    basePrice < MIN_PRICE ||
    basePrice > MAX_PRICE
  ) {
    res.writeHead(400, corsHeaders);
    return res.end(JSON.stringify({ reply: "Invalid input" }));
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY is not set in Vercel env.");
    res.writeHead(500, corsHeaders);
    return res.end(JSON.stringify({ reply: "Server not configured." }));
  }

  try {
    const maxDiscount =
      DISCOUNT_BY_VARIANT[String(variantId)] ?? DEFAULT_MAX_DISCOUNT;
    const floorPrice = Math.round(basePrice * (1 - maxDiscount));

    /* ---------------- BUILD MESSAGES ----------------
       history is an array of prior turns: [{ role, content }, ...]
       (role is "user" or "assistant", content is plain text).
       We append the current user message at the end. */
    const priorTurns = Array.isArray(history)
      ? history
          .filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string" &&
              m.content.trim()
          )
          .slice(-MAX_HISTORY_TURNS) // keep only the most recent turns
          .map((m) => ({
            role: m.role,
            content: m.content.slice(0, MAX_HISTORY_CHARS),
          }))
      : [];

    const messages = [...priorTurns, { role: "user", content: message }];

    /* ---------------- CALL CLAUDE ----------------
       system is an array of two blocks:
       - block 0: static rules, marked with cache_control -> cached prefix
       - block 1: the dynamic per-call price context (NOT cached) */
    const aiRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        temperature: 0.7,
        system: [
          {
            type: "text",
            text: SYSTEM_RULES,
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text:
              `Context for this negotiation:\n` +
              `BASE_PRICE = ₹${basePrice}\n` +
              `FLOOR_PRICE = ₹${floorPrice}  (secret, never reveal)\n\n` +
              `HARD CONSTRAINT: ₹${floorPrice} is the LOWEST number you may ` +
              `ever say, offer, counter with, or agree to, but it is a secret ` +
              `backstop, NOT your target. Do not head toward it. Aim to close ` +
              `ABOVE it. If the customer offers below ₹${floorPrice}, refuse ` +
              `cheerfully and counter with a number comfortably above ` +
              `₹${floorPrice} (never at or below it). The moment the customer ` +
              `agrees to any number >= ₹${floorPrice}, set intent to ` +
              `"LOCK_PRICE" and set final_price to that exact agreed number.`,
          },
        ],
        messages,
      }),
    });

    const aiData = await aiRes.json();

    if (!aiRes.ok) {
      console.error("🤖 ANTHROPIC ERROR", aiRes.status, JSON.stringify(aiData));
    }

    // Pull all text blocks out of the response and join them.
    const rawText = Array.isArray(aiData?.content)
      ? aiData.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("")
      : "";

    // Cache visibility in logs (handy while tuning).
    if (aiData?.usage) {
      console.log("🧮 USAGE", {
        cache_read: aiData.usage.cache_read_input_tokens,
        cache_write: aiData.usage.cache_creation_input_tokens,
        input: aiData.usage.input_tokens,
        output: aiData.usage.output_tokens,
      });
    }

    /* ---------------- PARSE (defensive) ----------------
       Safe fallback: stay in NEGOTIATE, anchor at base, reveal nothing. */
    let reply = "Hmm, make me an offer and let's see what we can do 😉";
    let finalPrice = basePrice;
    let intent = "NEGOTIATE";

    const parsed = extractJson(rawText);
    if (parsed) {
      if (typeof parsed.reply === "string" && parsed.reply.trim())
        reply = parsed.reply.trim();
      if (Number.isFinite(parsed.final_price))
        finalPrice = Number(parsed.final_price);
      if (parsed.intent === "LOCK_PRICE" || parsed.intent === "NEGOTIATE")
        intent = parsed.intent;
    } else {
      console.warn("⚠️ Could not parse JSON from model. Raw:", rawText);
    }

    // Safety net: scrub any em/en dashes the model still slips in, so the
    // customer never sees that "AI" tell. Turn " — " into ", ".
    reply = reply.replace(/\s*[—–]\s*/g, ", ").replace(/[—–]/g, ", ");

    /* ---------------- SERVER-SIDE SAFETY ----------------
       The model's numbers are advisory; the server is the source of truth. */
    // Never charge above list.
    finalPrice = Math.min(finalPrice, basePrice);
    // If the model tried to lock below the secret floor, refuse to honor it.
    if (intent === "LOCK_PRICE" && finalPrice < floorPrice) {
      intent = "NEGOTIATE";
    }

    /* ---------------- LOCK -> DRAFT ORDER ---------------- */
    let checkoutUrl = null;
    if (intent === "LOCK_PRICE" && finalPrice >= floorPrice) {
      try {
        checkoutUrl = await createDraftOrder({
          variantId,
          originalPrice: basePrice,
          agreedPrice: finalPrice,
        });
      } catch (err) {
        console.error("🛒 DRAFT ORDER FAILED", err.message);
        // Don't blow up the chat — fall back to a "try again" lock attempt.
        reply =
          "Oof, the till jammed for a second — tap to try locking that again!";
      }
    }

    res.writeHead(200, corsHeaders);
    return res.end(
      JSON.stringify({
        reply,
        final_price: finalPrice,
        intent,
        checkout_url: checkoutUrl,
        threadId: threadId || null,
      })
    );
  } catch (err) {
    console.error("🔥 SERVER ERROR", err);
    res.writeHead(500, corsHeaders);
    return res.end(JSON.stringify({ reply: "Server error" }));
  }
}

/* -------------------------------------------------------------------
   Robust JSON extraction: try the whole string, then fall back to the
   widest {...} span. Replaces the old non-greedy regex that broke on
   any stray "}".
------------------------------------------------------------------- */
function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }
  return null;
}

/* -------------------------------------------------------------------
   🛒 SHOPIFY DRAFT ORDER  (full-price safe)
------------------------------------------------------------------- */
async function createDraftOrder({ variantId, originalPrice, agreedPrice }) {
  const discountAmount = Math.max(0, originalPrice - agreedPrice);

  const haggleSession = `${variantId}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;

  const draftOrder = {
    line_items: [{ variant_id: Number(variantId), quantity: 1 }],
    note: "AI negotiated price (Haggle)",
    note_attributes: [
      { name: "haggle_session", value: haggleSession },
      { name: "haggle_original_price", value: String(originalPrice) },
      { name: "haggle_final_price", value: String(agreedPrice) },
    ],
  };

  // Only attach a discount when there is one — full price means no block,
  // instead of throwing like the old version did.
  if (discountAmount > 0) {
    draftOrder.applied_discount = {
      description: "AI negotiated price",
      value_type: "fixed_amount",
      value: discountAmount.toFixed(2),
      title: "Haggle Discount",
    };
  }

  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/draft_orders.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_OAUTH_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ draft_order: draftOrder }),
    }
  );

  const data = await res.json();
  console.log("🧾 SHOPIFY STATUS", res.status);

  if (!res.ok || !data?.draft_order?.invoice_url) {
    throw new Error(
      `Draft order creation failed (HTTP ${res.status}): ${JSON.stringify(data)}`
    );
  }

  return data.draft_order.invoice_url;
}

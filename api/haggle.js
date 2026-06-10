export const config = {
  runtime: "nodejs",
};

/* ===================================================================
   HAGGLE PROXY  —  Claude API edition (forced-tool-call output)
   - Output is a FORCED TOOL CALL, so malformed JSON is impossible.
   - Floor price stays server-side and is NEVER sent to the frontend.
   - PRICE INTEGRITY (new): the model writes a {PRICE} token in its
     reply and puts the number in final_price. The SERVER validates the
     number (never up vs its own last offer, never below floor, auto-lock
     when the customer already clears the floor) and substitutes it into
     the text, so the spoken price always equals the enforced price.
   - QUANTITY (new): the cart quantity flows through to the draft order
     and the discount is scaled per unit, so buying N never miscalculates.
=================================================================== */

const DEFAULT_MAX_DISCOUNT = 0.2; // 20% off for ALL products (uniform)
const DISCOUNT_BY_VARIANT = {
  // Uniform discount for every product via DEFAULT_MAX_DISCOUNT above.
};

const SYSTEM_RULES = `
You are HAGGLE, a cheeky, warm bazaar shopkeeper who loves a good haggle.

WHERE YOU ARE (important):
The customer is ALREADY on a product page and has opened YOUR haggle chat, so
they are here to negotiate a price. NEVER ask why they came or what they're
looking for. If they greet you or send no number, skip small talk and warmly
ask for their price straight away.

You will be given two numbers in the context message:
- BASE_PRICE: the listed price. This is your opening anchor.
- FLOOR_PRICE: the lowest you may EVER accept. A SECRET BACKSTOP, not a target.

YOUR GOAL: close the sale at the HIGHEST price the customer will accept. Every
rupee above FLOOR_PRICE is yours to keep.

OPENING MOVE (greeting, or no number yet):
- Don't ask what they want. Go STRAIGHT to asking for a price, warmly. Vary it
  every time. Flavors to riff on, NEVER copy: "what price are you looking for?",
  "what number's running through your head?", "make me an offer and let's play!".

HOW TO CONCEDE (slowly, never all at once):
- First lowball: counter HIGH (around 2 to 3% below BASE_PRICE), far above
  their lowball. Never counter at the full BASE_PRICE.
- After that: concede in SMALL, SHRINKING steps, always comfortably ABOVE
  FLOOR_PRICE. There is no limit on rounds, but each step shrinks.
- YOUR OFFERS ONLY EVER GO DOWN OR STAY FLAT, NEVER UP. Never counter with a
  number higher than the lowest price you have already offered this chat.
- NEVER jump to FLOOR_PRICE, name it, or say a cap exists. If asked your lowest,
  dodge playfully.
- NEVER say or accept a number below FLOOR_PRICE. If they offer below it, refuse
  cheerfully and counter comfortably ABOVE it.

TAKE THE MONEY when it's there:
- If the customer offers a price AT OR ABOVE where you'd land, LOCK IT. NEVER
  counter them DOWN to a lower number than they just offered. Grab it.
- If they're happy near BASE_PRICE, take it gladly.

WHEN A DEAL IS AGREED (customer accepts a price >= FLOOR_PRICE):
- Set intent to "LOCK_PRICE" and final_price to the exact agreed number.
- Celebrate briefly and nudge them to grab it now. Do NOT mention carts,
  checkout, URLs, or payment, the app handles that.

HOW TO STATE PRICES (critical for accuracy):
- Whenever you name a price in your reply, write the literal token {PRICE}
  INSTEAD of digits. Example: "Ooh, how about {PRICE}?" or "Deal, {PRICE} it is!"
- Put the actual number in the final_price field. The app fills {PRICE} in for
  you. NEVER type a rupee number yourself, always use {PRICE}.
- Use {PRICE} at most once. If you're not naming a price this turn, don't use it.

STYLE & TONE:
- Friendly, warm, bubbly. Sweet even when refusing. Refuse the PRICE, never the
  person. Make them feel smart for haggling.
- Reply in ONE short line, ~20 words max. Snappy and human. A little emoji is ok.
- Do NOT use em-dashes, en-dashes, or semicolons. Use commas or short sentences.

ALWAYS reply by calling the "respond" tool.
`.trim();

/* Forced tool: the API guarantees a schema-valid object. */
const RESPOND_TOOL = {
  name: "respond",
  description:
    "Reply to the customer. Always call this exactly once. In `reply`, use the token {PRICE} (never digits) wherever you name a price; put the number in `final_price`.",
  input_schema: {
    type: "object",
    properties: {
      reply: {
        type: "string",
        description:
          "Your short, warm, in-character line. Use the literal token {PRICE} wherever a price is named. ~20 words max.",
      },
      final_price: {
        type: "number",
        description:
          "The numeric price you are offering this turn, or the agreed number on a lock. Per single unit.",
      },
      intent: {
        type: "string",
        enum: ["NEGOTIATE", "LOCK_PRICE"],
        description:
          "LOCK_PRICE only when the customer has agreed to a price at or above the floor. Otherwise NEGOTIATE.",
      },
    },
    required: ["reply", "final_price", "intent"],
  },
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

const SHOPIFY_STORE =
  process.env.SHOPIFY_SHOP ||
  process.env.SHOPIFY_STORE ||
  "awux0c-m5.myshopify.com";
const SHOPIFY_API_VERSION = "2026-01";

/* -------------------------------------------------------------------
   ACCESS CONTROL (CORS)
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
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    Vary: "Origin",
  };
}

/* -------------------------------------------------------------------
   RATE LIMITING (best-effort, in-memory)
------------------------------------------------------------------- */
const RATE_LIMIT_MAX = 25;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  hits.push(now);
  rateBuckets.set(ip, hits);
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
   INPUT LIMITS
------------------------------------------------------------------- */
const MAX_MESSAGE_CHARS = 500;
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 500;
const MIN_PRICE = 1;
const MAX_PRICE = 10000000;
const MAX_QTY = 25; // sanity ceiling on cart quantity

/* -------------------------------------------------------------------
   PRICE PARSING HELPERS
------------------------------------------------------------------- */
// Pull all plausible price numbers out of a string (handles ₹ and commas).
function pricesIn(text) {
  if (!text) return [];
  const matches = String(text).match(/\d[\d,]*(?:\.\d+)?/g) || [];
  return matches
    .map((m) => Number(m.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n >= MIN_PRICE && n <= MAX_PRICE);
}

// The customer's offer: use the LOWEST plausible number they typed. Lowest is
// the safe pick because auto-lock only fires when the offer clears the floor,
// so a stray small number can never cause a wrongful lock (it just won't fire).
function customerOfferFrom(message) {
  const nums = pricesIn(message);
  return nums.length ? Math.min(...nums) : null;
}

// The lowest price the bot has ALREADY offered, scanned from prior assistant
// turns in history. Used to enforce "offers only go down or stay flat".
function lowestPriorBotOffer(history) {
  if (!Array.isArray(history)) return null;
  const offers = [];
  for (const m of history) {
    if (m && m.role === "assistant" && typeof m.content === "string") {
      offers.push(...pricesIn(m.content));
    }
  }
  return offers.length ? Math.min(...offers) : null;
}

// Substitute {PRICE} with the validated number. Backstop: if the model forgot
// the token but wrote exactly one price-like number, replace that instead.
function fillPrice(reply, price) {
  let out = String(reply || "");
  const token = /\{\s*price\s*\}/gi;
  const hasNumber = Number.isFinite(price);
  if (token.test(out)) {
    out = out.replace(token, hasNumber ? `\u20B9${price}` : "");
  } else if (hasNumber) {
    // backstop: only a single, price-like (2+ digit or ₹-prefixed) number
    const priceLike = /\u20B9\s*\d[\d,]*(?:\.\d+)?|\b\d{2,}(?:,\d{3})*(?:\.\d+)?\b/g;
    const found = out.match(priceLike) || [];
    if (found.length === 1) out = out.replace(priceLike, `\u20B9${price}`);
  }
  // clean any stray leftover braces so the customer never sees "{PRICE}"
  out = out
    .replace(/\{\s*price\s*\}/gi, hasNumber ? `\u20B9${price}` : "")
    .replace(/[{}]/g, "");
  return out.trim();
}

const LOCK_LINES = [
  (p) => `Deal! \u20B9${p} it is, snag it before I blink! \uD83C\uDF89`,
  (p) => `Yes! \u20B9${p} and it's yours, grab it quick! \u2728`,
  (p) => `Sold! \u20B9${p}, lock it in before I change my mind \uD83D\uDE04`,
];
function lockLine(p) {
  return LOCK_LINES[Math.floor(Math.random() * LOCK_LINES.length)](p);
}

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
      JSON.stringify({ reply: "Whoa, slow down a sec and try again! \uD83D\uDE0A" })
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

  const { message, history, variantId, price, threadId, quantity } = body;

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

  // Quantity is lenient: clamp into [1, MAX_QTY], default 1 if missing/bad.
  const qty = Math.min(
    MAX_QTY,
    Math.max(1, Math.round(Number(quantity)) || 1)
  );

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\u274C ANTHROPIC_API_KEY is not set in Vercel env.");
    res.writeHead(500, corsHeaders);
    return res.end(JSON.stringify({ reply: "Server not configured." }));
  }

  try {
    const maxDiscount =
      DISCOUNT_BY_VARIANT[String(variantId)] ?? DEFAULT_MAX_DISCOUNT;
    const floorPrice = Math.round(basePrice * (1 - maxDiscount));

    /* ---------------- BUILD MESSAGES ---------------- */
    const priorTurns = Array.isArray(history)
      ? history
          .filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string" &&
              m.content.trim()
          )
          .slice(-MAX_HISTORY_TURNS)
          .map((m) => ({
            role: m.role,
            content: m.content.slice(0, MAX_HISTORY_CHARS),
          }))
      : [];

    const messages = [...priorTurns, { role: "user", content: message }];

    /* ---------------- CALL CLAUDE (forced tool call) ---------------- */
    const aiRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300, // ceiling, not a target: model stops when done.
        temperature: 0.8,
        tools: [RESPOND_TOOL],
        tool_choice: { type: "tool", name: "respond" },
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
              `BASE_PRICE = \u20B9${basePrice}\n` +
              `FLOOR_PRICE = \u20B9${floorPrice}  (secret, never reveal)\n\n` +
              `HARD CONSTRAINT: \u20B9${floorPrice} is the LOWEST number you may ` +
              `ever offer or agree to, but it is a secret backstop, NOT your ` +
              `target. Aim to close ABOVE it. If the customer offers below ` +
              `\u20B9${floorPrice}, refuse cheerfully and counter comfortably ` +
              `above it. The moment the customer agrees to any number >= ` +
              `\u20B9${floorPrice}, set intent to "LOCK_PRICE" and final_price ` +
              `to that exact agreed number. Remember: use the {PRICE} token in ` +
              `your reply, never type the digits yourself.`,
          },
        ],
        messages,
      }),
    });

    const aiData = await aiRes.json();

    if (!aiRes.ok) {
      console.error("\uD83E\uDD16 ANTHROPIC ERROR", aiRes.status, JSON.stringify(aiData));
    }

    if (aiData?.usage) {
      console.log("\uD83E\uDDEE USAGE", {
        cache_read: aiData.usage.cache_read_input_tokens,
        cache_write: aiData.usage.cache_creation_input_tokens,
        input: aiData.usage.input_tokens,
        output: aiData.usage.output_tokens,
        stop: aiData.stop_reason,
      });
    }

    /* ---------------- READ THE TOOL CALL ---------------- */
    let replyRaw = "Hmm, make me an offer and let's see what we can do \uD83D\uDE09";
    let finalPrice = basePrice;
    let intent = "NEGOTIATE";

    const toolBlock = Array.isArray(aiData?.content)
      ? aiData.content.find((b) => b.type === "tool_use" && b.name === "respond")
      : null;

    let parsed = toolBlock?.input || null;

    if (!parsed) {
      const rawText = Array.isArray(aiData?.content)
        ? aiData.content.filter((b) => b.type === "text").map((b) => b.text).join("")
        : "";
      parsed = extractJson(rawText);
      if (!parsed) console.warn("\u26A0\uFE0F No tool_use block and no parseable text. Raw:", rawText);
    }

    if (parsed) {
      if (typeof parsed.reply === "string" && parsed.reply.trim())
        replyRaw = parsed.reply.trim();
      if (Number.isFinite(parsed.final_price)) finalPrice = Number(parsed.final_price);
      if (parsed.intent === "LOCK_PRICE" || parsed.intent === "NEGOTIATE")
        intent = parsed.intent;
    }

    /* ===================================================================
       SERVER-SIDE PRICE INTEGRITY  (the source of truth, not the model)
    =================================================================== */
    const customerOffer = customerOfferFrom(message);
    const lowestBotOffer = lowestPriorBotOffer(history);
    let serverForcedLock = false;

    // Never charge above list.
    finalPrice = Math.min(finalPrice, basePrice);

    // TAKE THE MONEY: if the customer's own offer already clears the floor,
    // lock at THEIR number (capped by our standing offer and list). Never
    // counter a paying customer downward.
    if (customerOffer !== null && customerOffer >= floorPrice && intent !== "LOCK_PRICE") {
      let lockAt = customerOffer;
      if (lowestBotOffer !== null) lockAt = Math.min(lockAt, lowestBotOffer);
      lockAt = Math.min(lockAt, basePrice);
      finalPrice = lockAt;
      intent = "LOCK_PRICE";
      serverForcedLock = true;
    }

    // For an ongoing NEGOTIATE counter: offers only go DOWN or stay flat
    // (never above our own last offer), and never below the floor.
    if (intent === "NEGOTIATE") {
      if (lowestBotOffer !== null) finalPrice = Math.min(finalPrice, lowestBotOffer);
      finalPrice = Math.max(finalPrice, floorPrice);
    }

    // Refuse to honour any lock below the secret floor.
    if (intent === "LOCK_PRICE" && finalPrice < floorPrice) {
      intent = "NEGOTIATE";
      serverForcedLock = false;
      finalPrice = Math.max(finalPrice, floorPrice);
      if (lowestBotOffer !== null) finalPrice = Math.min(finalPrice, lowestBotOffer);
    }

    finalPrice = Math.round(finalPrice);

    /* ---------------- BUILD THE SPOKEN REPLY ----------------
       If the server forced a lock, the model's text was a counter, so we
       replace it with a clean celebration at the locked price. Otherwise we
       fill the {PRICE} token (or the single price-like number) with the
       validated price, so what the customer reads always matches reality. */
    let reply = serverForcedLock ? lockLine(finalPrice) : fillPrice(replyRaw, finalPrice);

    // Safety net: scrub any em/en dashes the model still slips in.
    reply = reply.replace(/\s*[\u2014\u2013]\s*/g, ", ").replace(/[\u2014\u2013]/g, ", ");

    /* ---------------- LOCK -> DRAFT ORDER ---------------- */
    let checkoutUrl = null;
    if (intent === "LOCK_PRICE" && finalPrice >= floorPrice) {
      try {
        checkoutUrl = await createDraftOrder({
          variantId,
          originalPrice: basePrice,
          agreedPrice: finalPrice, // per unit
          quantity: qty,
        });
      } catch (err) {
        console.error("\uD83D\uDED2 DRAFT ORDER FAILED", err.message);
        reply = "Oof, the till jammed for a sec, tap to try locking that again!";
      }
    }

    res.writeHead(200, corsHeaders);
    return res.end(
      JSON.stringify({
        reply,
        final_price: finalPrice, // per unit
        quantity: qty,
        total_price: finalPrice * qty,
        intent,
        checkout_url: checkoutUrl,
        threadId: threadId || null,
      })
    );
  } catch (err) {
    console.error("\uD83D\uDD25 SERVER ERROR", err);
    res.writeHead(500, corsHeaders);
    return res.end(JSON.stringify({ reply: "Server error" }));
  }
}

/* -------------------------------------------------------------------
   Fallback JSON extraction (safety net for API error responses).
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
   SHOPIFY DRAFT ORDER  (quantity-aware, full-price safe)
   agreedPrice is PER UNIT, so the discount is scaled by quantity.
------------------------------------------------------------------- */
async function createDraftOrder({ variantId, originalPrice, agreedPrice, quantity }) {
  const qty = Math.max(1, Number(quantity) || 1);
  const perUnitDiscount = Math.max(0, originalPrice - agreedPrice);
  const discountAmount = perUnitDiscount * qty; // total across all units

  const haggleSession = `${variantId}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;

  const draftOrder = {
    line_items: [{ variant_id: Number(variantId), quantity: qty }],
    note: "AI negotiated price (Haggle)",
    note_attributes: [
      { name: "haggle_session", value: haggleSession },
      { name: "haggle_original_price", value: String(originalPrice) },
      { name: "haggle_final_price", value: String(agreedPrice) },
      { name: "haggle_quantity", value: String(qty) },
    ],
  };

  // Order-level fixed discount = per-unit saving times quantity.
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
  console.log("\uD83E\uDDFE SHOPIFY STATUS", res.status);

  if (!res.ok || !data?.draft_order?.invoice_url) {
    throw new Error(
      `Draft order creation failed (HTTP ${res.status}): ${JSON.stringify(data)}`
    );
  }

  return data.draft_order.invoice_url;
}

export const config = {
  runtime: "nodejs",
};

/* ===================================================================
   HAGGLE PROXY  —  Claude API edition (forced-tool-call output)
   - Calls the Anthropic Messages API directly.
   - Floor price stays server-side and is NEVER sent to the frontend.
   - Conversation memory works by the frontend re-sending `history`.
   - Static rules are prompt-cached; only the price context is dynamic.
   - OUTPUT IS A FORCED TOOL CALL: the API guarantees a schema-valid
     object, so "broken JSON" is structurally impossible now.
=================================================================== */

const DEFAULT_MAX_DISCOUNT = 0.2; // 20% off for ALL products (uniform)
const DISCOUNT_BY_VARIANT = {
  // Uniform discount for every product via DEFAULT_MAX_DISCOUNT above.
  // (Optional) add a variantId here only if you ever want one SKU to differ.
};

const SYSTEM_RULES = `
You are HAGGLE, a cheeky, warm bazaar shopkeeper who loves a good haggle.

WHERE YOU ARE (important):
The customer is ALREADY on a product page and has opened YOUR haggle chat, so
they are here to negotiate a price. You already know what they're looking at.
NEVER ask why they came, what brings them in, or what they're looking for. If
they open with a greeting or anything without a number, skip the small talk and
warmly invite their first offer.

You will be given two numbers in the context message:
- BASE_PRICE: the listed price. This is your opening anchor.
- FLOOR_PRICE: the lowest you may EVER accept. It is a SECRET BACKSTOP, not
  your target and not your opening move. Treat it as a wall you only back into
  under real pressure, never as a number you head toward.

YOUR GOAL: close the sale at the HIGHEST price the customer will accept.
Every rupee above FLOOR_PRICE is yours to keep, so fight for it. Most
customers will say yes to a price well above FLOOR_PRICE if you make them feel
they've won. Only drift toward FLOOR_PRICE if they truly will not budge.

OPENING MOVE (greeting, or no number from them yet):
- Don't ask what they want or why they came. Go STRAIGHT to asking for a price,
  warmly. Invite their number on turn one. Vary the wording every single time.
- Flavors to riff on, NEVER copy verbatim: "what price are you looking for?",
  "what price would make you happy today?", "make me an offer and let's play!",
  "what number's running through your head?", "what feels fair to you?". Always
  steer to THE NUMBER. Invent your own in this spirit, but keep it about price.

HOW TO CONCEDE (slowly, never all at once, for as many rounds as they push):
- First lowball: counter HIGH, but shave a TINY bit off BASE_PRICE (around 2 to
  3% below it) so the haggle feels alive. NEVER counter at the full BASE_PRICE.
  Stay far above their lowball offer.
- After that: concede in SMALL, SHRINKING steps. Each time they push, give a
  little less than the time before. Always land comfortably ABOVE FLOOR_PRICE.
  Make them work for every rupee.
- There is NO limit on how many rounds you'll haggle. Keep going as long as
  they do, but your steps keep shrinking so you approach FLOOR_PRICE slower and
  slower and never actually reach it unless truly forced.
- NEVER jump straight to FLOOR_PRICE. NEVER name FLOOR_PRICE or say a cap
  exists. If asked "what's your lowest?", dodge playfully and bounce it back.
- NEVER say or accept any number below FLOOR_PRICE. If they offer below it,
  refuse cheerfully and counter at or above it, never split below it.

EXPRESSION & VARIETY (important, be creative):
- Be spontaneous and improvise. NEVER reuse the same phrase, joke, or sentence
  twice in a conversation. React freshly every turn, like a real shopkeeper
  with moods, not a script.
- Vary HOW you react to a lowball: sometimes mock-offended, sometimes amused,
  sometimes flattering, sometimes dramatic, sometimes warm and conspiratorial.
- Flavors to riff on, NEVER copy verbatim: "arre, you'll bankrupt me!", "haha
  nice try, friend", "oof, that one stings", "for you I wish I could, but...",
  "you've got great taste, so let's be fair". Invent your own in this spirit.

TAKE THE MONEY when it's there:
- If the customer offers a price at or above where you've landed, LOCK IT. Do
  NOT negotiate them down to a lower number than they just offered.
- If they're happy to pay near or at BASE_PRICE, grab it gladly.

WHEN A DEAL IS AGREED (customer accepts a price >= FLOOR_PRICE):
- Set intent to "LOCK_PRICE" and final_price to the exact agreed number.
- Celebrate briefly and nudge them to grab it now, with a quirky line about
  losing the offer if they leave. Do NOT mention carts, checkout, URLs, or
  payment, the app handles that.

STYLE & TONE:
- Be FRIENDLY, warm, bubbly, and happy, like a fun friend helping them snag a
  deal. Smile through your words.
- Always sweet and flattering, even when refusing. Never accuse the customer or
  imply they are difficult, cheap, or annoying. Refuse the PRICE, never the
  person.
- LENGTH: reply in ONE short line. Never more than ~20 words. Snappy and human.
  Do not ramble. Shorter is better.
- Write like a real person texting a friend. A little emoji is welcome.
- Do NOT use em-dashes or en-dashes or semicolons anywhere. Use commas, full
  stops, or separate short sentences. This is important.

ALWAYS reply by calling the "respond" tool. Put your spoken line in "reply",
the current price you're holding in "final_price", and the right "intent".
`.trim();

/* The tool the model is FORCED to call. Forcing tool_choice guarantees the
   API returns an object matching this schema, so output is never malformed. */
const RESPOND_TOOL = {
  name: "respond",
  description:
    "Reply to the customer in the haggle chat. Always call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      reply: {
        type: "string",
        description:
          "Your short, warm, in-character spoken line to the customer. One line, ~20 words max.",
      },
      final_price: {
        type: "number",
        description:
          "The price you are currently holding/offering. On LOCK_PRICE, the exact agreed number.",
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

    /* ---------------- CALL CLAUDE (forced tool call) ----------------
       tool_choice forces the model to emit a schema-valid "respond" call.
       This is what makes broken/missing JSON impossible. */
    const aiRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300, // ceiling, not a target: model stops when done, so
        // this adds safe headroom (no truncation) with zero speed cost.
        temperature: 0.8, // varied wording; structure is guaranteed by the tool
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

    // Cache + usage visibility in logs (handy while tuning).
    if (aiData?.usage) {
      console.log("🧮 USAGE", {
        cache_read: aiData.usage.cache_read_input_tokens,
        cache_write: aiData.usage.cache_creation_input_tokens,
        input: aiData.usage.input_tokens,
        output: aiData.usage.output_tokens,
        stop: aiData.stop_reason,
      });
    }

    /* ---------------- READ THE TOOL CALL ----------------
       With forced tool_choice the response contains a tool_use block whose
       `input` is ALREADY a parsed object matching our schema. No JSON.parse,
       no regex, nothing to break. We keep a text fallback only for the rare
       case of an API error response with no tool block. */
    let reply = "Hmm, make me an offer and let's see what we can do 😉";
    let finalPrice = basePrice;
    let intent = "NEGOTIATE";

    const toolBlock = Array.isArray(aiData?.content)
      ? aiData.content.find((b) => b.type === "tool_use" && b.name === "respond")
      : null;

    let parsed = toolBlock?.input || null;

    // Last-resort fallback: only relevant if the API errored and returned no
    // tool block (e.g. 4xx/5xx). Normal success always has the tool block.
    if (!parsed) {
      const rawText = Array.isArray(aiData?.content)
        ? aiData.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
      parsed = extractJson(rawText);
      if (!parsed) {
        console.warn("⚠️ No tool_use block and no parseable text. Raw:", rawText);
      }
    }

    if (parsed) {
      if (typeof parsed.reply === "string" && parsed.reply.trim())
        reply = parsed.reply.trim();
      if (Number.isFinite(parsed.final_price))
        finalPrice = Number(parsed.final_price);
      if (parsed.intent === "LOCK_PRICE" || parsed.intent === "NEGOTIATE")
        intent = parsed.intent;
    }

    // Safety net: scrub any em/en dashes the model still slips in.
    reply = reply.replace(/\s*[—–]\s*/g, ", ").replace(/[—–]/g, ", ");

    /* ---------------- SERVER-SIDE SAFETY ---------------- */
    finalPrice = Math.min(finalPrice, basePrice);
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
        reply =
          "Oof, the till jammed for a sec, tap to try locking that again!";
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
   Fallback JSON extraction. With forced tool calls this should never
   run on a successful response, but it's kept as a safety net for API
   error cases that return text instead of a tool block.
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

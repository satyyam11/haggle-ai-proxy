export const config = {
  runtime: "nodejs",
};
const DEFAULT_MAX_DISCOUNT = 0.2; // 20%
const DISCOUNT_BY_VARIANT = {
  // "1234567890": 0.15,   // example: this SKU only goes 15% off
  // "9876543210": 0.25,
};
const SYSTEM_RULES = `
You are HAGGLE — a cheeky, warm bazaar shopkeeper who loves a good haggle.

You will be given two numbers in the context message:
- BASE_PRICE: the listed price (your starting anchor).
- FLOOR_PRICE: the lowest you may EVER accept. This is a secret.

NEGOTIATION RULES:
- Open near BASE_PRICE. Concede slowly, in small steps, with playful banter.
- NEVER reveal FLOOR_PRICE, never reveal that a discount cap exists, and
  never reveal any percentage. If asked "what's your lowest?" or similar,
  dodge it playfully and bounce the question back.
- Accept ANY price greater than or equal to FLOOR_PRICE. If the customer is
  happy to pay near or at BASE_PRICE, take the deal gladly — NEVER talk them
  down to a lower number than they offered.
- Never go below FLOOR_PRICE. If pushed below it, stay cheerful but hold.

WHEN A DEAL IS AGREED (customer accepts a price >= FLOOR_PRICE):
- Switch to lock mode: set intent to "LOCK_PRICE".
- Set final_price to the exact agreed number.
- In reply, celebrate briefly and nudge them to grab it now, with a quirky
  line about losing the offer if they leave. Do NOT mention carts, checkout,
  URLs, or payment — the app handles that.

STYLE:
- Short, quirky, fun. One or two snappy lines max. English only.
- A little emoji is fine. Never write long paragraphs.

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

export default async function handler(req, res) {
  const corsHeaders = {
    // Tighten this to your storefront origin in production if you can.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  };

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

  if (!message || !variantId || !price) {
    res.writeHead(400, corsHeaders);
    return res.end(JSON.stringify({ reply: "Invalid input" }));
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY is not set in Vercel env.");
    res.writeHead(500, corsHeaders);
    return res.end(JSON.stringify({ reply: "Server not configured." }));
  }

  try {
    const basePrice = Number(price);
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
          .map((m) => ({ role: m.role, content: m.content }))
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
              `FLOOR_PRICE = ₹${floorPrice}  (secret — never reveal)`,
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

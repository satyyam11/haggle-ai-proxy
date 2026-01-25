export const config = {
  runtime: "nodejs",
};
export default async function handler(req, res) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  };

  /* ---------------- CORS ---------------- */
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

  /* ---------------- BODY SAFETY ---------------- */
  let body = req.body;
  if (!body || typeof body === "string") {
    try {
      body = JSON.parse(req.body || "{}");
    } catch {
      body = {};
    }
  }

  const { message, variantId, price, threadId } = body;

  console.log("📥 INCOMING PAYLOAD", {
    message,
    variantId,
    price,
    threadId,
  });

  if (!message || !variantId || !price) {
    res.writeHead(400, corsHeaders);
    return res.end(JSON.stringify({ reply: "Invalid input" }));
  }

  try {
    const basePrice = Number(price);
    const floorPrice = Math.round(basePrice * 0.8);
    const fallbackPrice = Math.round(basePrice * 0.9);

    /* ---------------- AI PROMPT ---------------- */
    const aiPrompt = `
You are HAGGLE, an AI price negotiator.

STRICT RULES:
- Reply ONLY valid JSON
- No markdown
- No explanations
- Never mention checkout, cart, URL, or payment
- Max discount: 20%

JSON FORMAT ONLY:
{
  "reply": string,
  "final_price": number,
  "intent": "NEGOTIATE" | "LOCK_PRICE"
}

Original price: ₹${basePrice}
Floor price: ₹${floorPrice}

User message:
"${message}"
`.trim();

    /* ---------------- AI WEBHOOK ---------------- */
    const aiRes = await fetch(
      "https://connect.testmyprompt.com/webhook/69769887fe2b20e0df198578",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": process.env.WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          message: aiPrompt,
          threadId,
          type: "user_message",
        }),
      }
    );

    const aiText = await aiRes.text();
    console.log("🤖 RAW AI RESPONSE", aiText);

    /* ---------------- SAFE AI PARSING ---------------- */
    let reply = `I can offer ₹${fallbackPrice}. Want me to lock it in?`;
    let finalPrice = fallbackPrice;
    let intent = "NEGOTIATE";
    let nextThreadId = threadId;

    try {
      const outer = JSON.parse(aiText);
      nextThreadId = outer.threadId || threadId;

      const inner = (outer.response || "")
        .replace(/```json|```/gi, "")
        .match(/\{[\s\S]*?\}/)?.[0];

      if (inner) {
        const parsed = JSON.parse(inner);
        if (typeof parsed.reply === "string") reply = parsed.reply;
        if (typeof parsed.final_price === "number")
          finalPrice = parsed.final_price;
        if (parsed.intent === "LOCK_PRICE" || parsed.intent === "NEGOTIATE")
          intent = parsed.intent;
      }
    } catch {
      console.warn("⚠️ AI parse failed — fallback used");
    }

    /* ---------------- USER CONFIRMATION OVERRIDE ---------------- */
    if (/(ok|okay|deal|lock|yes|fine)/i.test(message)) {
      intent = "LOCK_PRICE";
    }

    console.log("🧠 DECISION", { intent, finalPrice });

    let checkoutUrl = null;

    if (intent === "LOCK_PRICE" && finalPrice >= floorPrice) {
      console.log("🧾 CREATING DRAFT ORDER");
      checkoutUrl = await createDraftOrder({
        variantId,
        agreedPrice: finalPrice,
      });
    }

    res.writeHead(200, corsHeaders);
    res.end(
      JSON.stringify({
        reply,
        final_price: finalPrice,
        checkout_url: checkoutUrl,
        threadId: nextThreadId,
      })
    );
  } catch (err) {
    console.error("🔥 SERVER ERROR", err);
    res.writeHead(500, corsHeaders);
    res.end(JSON.stringify({ reply: "Server error" }));
  }
}

/* -------------------------------------------------
   🛒 SHOPIFY — REAL POST, REAL DRAFT, NO REUSE
-------------------------------------------------- */
async function createDraftOrder({ variantId, agreedPrice }) {
  const haggleSession = `${variantId}_${Date.now()}`;

  const payload = {
    draft_order: {
      line_items: [
        {
          variant_id: Number(variantId),
          quantity: 1,
          price: String(agreedPrice), // STRING is IMPORTANT
        },
      ],
      note: "AI negotiated price",
      note_attributes: [
        {
          name: "haggle_session",
          value: haggleSession,
        },
      ],
    },
  };

  console.log("🧪 FINAL DRAFT PAYLOAD", JSON.stringify(payload, null, 2));

  const res = await fetch(
    `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-01/draft_orders.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_OAUTH_TOKEN,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await res.json();

  console.log("🧾 SHOPIFY STATUS", res.status);
  console.log("🧾 SHOPIFY RESPONSE", JSON.stringify(data, null, 2));

  if (!res.ok || !data.draft_order || !data.draft_order.invoice_url) {
    throw new Error("Draft order creation failed");
  }

  console.log("✅ INVOICE URL", data.draft_order.invoice_url);
  return data.draft_order.invoice_url;
}

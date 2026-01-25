export default async function handler(req, res) {
  const corsHeaders = {
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

  /* -------------------------------------------------
     🔒 BODY SAFETY (MOST IMPORTANT FIX)
  -------------------------------------------------- */
  let body = req.body;

  if (!body || typeof body === "string") {
    try {
      body = JSON.parse(req.body || "{}");
    } catch {
      body = {};
    }
  }

  const { message, variantId, price, threadId } = body;

  console.log("📥 INCOMING PAYLOAD", { message, variantId, price, threadId });

  if (!message || !variantId || !price) {
    console.error("❌ INVALID REQUEST BODY", body);
    res.writeHead(400, corsHeaders);
    return res.end(
      JSON.stringify({
        reply: "Something went wrong. Please refresh and try again.",
      })
    );
  }

  try {
    const basePrice = Number(price);
    const floorPrice = Math.round(basePrice * 0.8);
    const fallbackPrice = Math.round(basePrice * 0.9);

    /* ---------------- AI PROMPT ---------------- */
    const aiPrompt = `
You are HAGGLE, a price negotiator.

Price: ₹${basePrice}
Floor: ₹${floorPrice}

Rules:
- Reply in JSON only
- Max 2 sentences
- INR only
- Never below floor

Return exactly:
{
  "reply": "",
  "final_price": number,
  "intent": "NEGOTIATE" | "LOCK_PRICE"
}

User: "${message}"
`.trim();

    const aiRes = await fetch(
      "https://connect.testmyprompt.com/webhook/696b75a82abe5e63ed202cde",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": process.env.WEBHOOK_SECRET,
        },
        body: JSON.stringify({ message: aiPrompt, threadId }),
      }
    );

    const aiText = await aiRes.text();
    console.log("🤖 RAW AI:", aiText);

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
        if (parsed.reply) reply = parsed.reply;
        if (typeof parsed.final_price === "number")
          finalPrice = parsed.final_price;
        if (parsed.intent) intent = parsed.intent;
      }
    } catch {
      console.warn("⚠️ AI parse failed");
    }

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
    console.error("🔥 ERROR", err);
    res.writeHead(500, corsHeaders);
    res.end(JSON.stringify({ reply: "Server error" }));
  }
}

/* ---------------- SHOPIFY DRAFT ORDER ---------------- */
async function createDraftOrder({ variantId, agreedPrice }) {
  const shopifyRes = await fetch(
    `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-01/draft_orders.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_OAUTH_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        draft_order: {
          line_items: [
            {
              variant_id: variantId,
              quantity: 1,
              price: agreedPrice,
            },
          ],
          note: "AI negotiated price",
        },
      }),
    }
  );

  /* -------------------------------------------------
     🔒 SHOPIFY RESPONSE SAFETY
  -------------------------------------------------- */
  const text = await shopifyRes.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    console.error("❌ SHOPIFY NON-JSON RESPONSE", text);
    throw new Error("Shopify error");
  }

  console.log("🧾 SHOPIFY DRAFT RESPONSE", JSON.stringify(data, null, 2));

  const draftOrder =
    data?.draft_order ||
    (Array.isArray(data?.draft_orders) ? data.draft_orders[0] : null);

  if (!draftOrder) {
    throw new Error("Draft order creation failed");
  }

  const createdVariantId = draftOrder.line_items?.[0]?.variant_id;

  if (Number(createdVariantId) !== Number(variantId)) {
    console.error("🚨 VARIANT MISMATCH", {
      expected: variantId,
      got: createdVariantId,
    });
    throw new Error("Variant mismatch — aborting checkout");
  }

  if (!draftOrder.invoice_url) {
    throw new Error("Missing invoice_url");
  }

  console.log("✅ INVOICE URL", draftOrder.invoice_url);
  return draftOrder.invoice_url;
}

export default async function handler(req, res) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  };

  /* -------- CORS -------- */
  if (req.method === "OPTIONS") {
    res.writeHead(200, corsHeaders);
    return res.end();
  }

  /* -------- HEALTH -------- */
  if (req.method === "GET") {
    res.writeHead(200, corsHeaders);
    return res.end(JSON.stringify({ status: "ok", message: "Haggle API live" }));
  }

  if (req.method !== "POST") {
    res.writeHead(405, corsHeaders);
    return res.end(JSON.stringify({ error: "Method Not Allowed" }));
  }

  try {
    const { message, product, threadId } = req.body || {};
        // 🧪 FORCE MODE — bypass AI and directly generate draft checkout
    if (req.query.force === "1") {
      console.log("🧪 FORCE MODE ENABLED — SKIPPING AI");

      if (!product?.variantId || !product?.price || !product?.name) {
        res.writeHead(400, corsHeaders);
        return res.end(
          JSON.stringify({ error: "Missing product info for force mode" })
        );
      }

      const basePrice = Number(product.price);
      const agreedPrice = basePrice - 35; // 👈 hardcoded test discount

      const checkoutUrl = await createDraftOrder({
        shop: process.env.SHOPIFY_SHOP,
        accessToken: process.env.SHOPIFY_OAUTH_TOKEN,
        variantId: product.variantId,
        originalPrice: basePrice,
        agreedPrice,
      });

      console.log("🧪 FORCE MODE CHECKOUT URL:", checkoutUrl);

      res.writeHead(200, corsHeaders);
      return res.end(
        JSON.stringify({
          reply: "FORCE MODE: Draft checkout generated",
          action: "LOCK",
          agreed_price: agreedPrice,
          checkout_url: checkoutUrl,
          threadId: "force-test",
        })
      );
    }

    console.log("📥 INCOMING FRONTEND PAYLOAD");
    console.log(JSON.stringify({ message, product, threadId }, null, 2));

    // ✅ FIXED: variantId NOT required for chat
    if (!message || !product?.price || !product?.name) {
      res.writeHead(400, corsHeaders);
      return res.end(JSON.stringify({ reply: "Invalid input (missing product info)" }));
    }

    const basePrice = Number(product.price);
    if (isNaN(basePrice) || basePrice <= 0) {
      res.writeHead(400, corsHeaders);
      return res.end(JSON.stringify({ reply: "Invalid price" }));
    }

    const floorPrice = Math.round(basePrice * 0.8);
    const fallbackPrice = Math.round(basePrice * 0.9);

    /* -------- AI PROMPT -------- */
    const aiPrompt = `
You are HAGGLE, a playful Indian price negotiator.

Product: ${product.name}
Price: ₹${basePrice}
Floor: ₹${floorPrice}

Rules:
- INR only
- Never below floor
- No greetings
- Max 2 sentences
- JSON only
- action MUST be exactly one of: "NONE" or "LOCK"

User: "${message}"

Respond strictly as JSON:
{"reply":"","agreed_price":null,"action":"NONE"}
`.trim();

    console.log("🤖 AI PROMPT SENT");
    console.log(aiPrompt);

    /* -------- AI CALL -------- */
    const aiRes = await fetch(
      "https://connect.testmyprompt.com/webhook/696b75a82abe5e63ed202cde",
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

    console.log("📤 RAW AI RESPONSE");
    console.log(aiText);

    /* -------- PARSE AI -------- */
    let reply = `I can offer ₹${fallbackPrice}. Want me to lock it in?`;
    let action = "NONE";
    let agreedPrice = null;
    let nextThreadId = threadId;

    try {
      const outer = JSON.parse(aiText);
      nextThreadId = outer.threadId || threadId;

      let inner = (outer.response || "").replace(/```json|```/gi, "").trim();
      const match = inner.match(/\{[\s\S]*?\}/);

      if (match) {
        const parsed = JSON.parse(match[0]);
        reply = parsed.reply || reply;
        action = parsed.action || "NONE";
        agreedPrice = parsed.agreed_price || null;
      }
    } catch {
      console.warn("⚠️ AI parse failed, using fallback");
    }

    console.log("🧠 PARSED AI RESULT");
    console.log({ reply, action, agreedPrice, nextThreadId });

    /* -------- DRAFT ORDER -------- */
    let checkoutUrl = null;

    if (action === "LOCK" && agreedPrice && product.variantId) {
      console.log("🧾 CREATING DRAFT ORDER");

      checkoutUrl = await createDraftOrder({
        shop: process.env.SHOPIFY_SHOP,
        accessToken: process.env.SHOPIFY_OAUTH_TOKEN,
        variantId: product.variantId,
        originalPrice: basePrice,
        agreedPrice,
      });
    }

    console.log("✅ FINAL RESPONSE");
    console.log({ reply, action, agreedPrice, checkoutUrl, nextThreadId });

    res.writeHead(200, corsHeaders);
    res.end(
      JSON.stringify({
        reply,
        action,
        agreed_price: agreedPrice,
        checkout_url: checkoutUrl,
        threadId: nextThreadId,
      })
    );
  } catch (err) {
    console.error("🔥 FATAL ERROR", err);
    res.writeHead(500, corsHeaders);
    res.end(JSON.stringify({ reply: "Something went wrong" }));
  }
}

/* -------- SHOPIFY DRAFT ORDER -------- */
async function createDraftOrder({
  shop,
  accessToken,
  variantId,
  originalPrice,
  agreedPrice,
}) {
  const discount = originalPrice - agreedPrice;

  console.log("🧮 DRAFT ORDER CALC");
  console.log({ originalPrice, agreedPrice, discount });

  const res = await fetch(
    `https://${shop}/admin/api/2024-01/draft_orders.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        draft_order: {
          line_items: [
            {
              variant_id: variantId,
              quantity: 1,
            },
          ],
          applied_discount: {
            description: "AI negotiated price",
            value: discount,
            value_type: "fixed_amount",
          },
          note: "AI negotiated via chat",
        },
      }),
    }
  );

  const data = await res.json();

  console.log("🧾 SHOPIFY RESPONSE");
  console.log(JSON.stringify(data, null, 2));

  if (!res.ok) throw new Error("Draft order failed");

  return data.draft_order.invoice_url;
}

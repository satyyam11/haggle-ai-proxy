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
    return res.end(
      JSON.stringify({ status: "ok", message: "Haggle API live" })
    );
  }

  if (req.method !== "POST") {
    res.writeHead(405, corsHeaders);
    return res.end(JSON.stringify({ error: "Method Not Allowed" }));
  }

  try {
    const { message, product, threadId } = req.body || {};

    console.log("📥 INCOMING PAYLOAD", { message, product, threadId });

    if (!message || !product?.name || !product?.price) {
      return res.end(JSON.stringify({ reply: "Invalid input" }));
    }

    const basePrice = Number(product.price);
    const floorPrice = Math.round(basePrice * 0.8);
    const fallbackPrice = Math.round(basePrice * 0.9);

    /* ---------- AI PROMPT ---------- */
    const aiPrompt = `
You are HAGGLE, a price negotiator.

Product: ${product.name}
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

    /* ---------- PARSE AI ---------- */
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
        reply = parsed.reply || reply;
        finalPrice = parsed.final_price || finalPrice;
        intent = parsed.intent || intent;
      }
    } catch (err) {
      console.warn("⚠️ AI parse failed, fallback used", err);
    }

    /* ---------- BACKEND ACCEPTANCE SAFETY ---------- */
    const userAgreed = /(ok|okay|deal|lock|yes|fine)/i.test(message);
    if (userAgreed) intent = "LOCK_PRICE";

    console.log("🧠 DECISION", { intent, finalPrice });

    /* ---------- CREATE DRAFT ORDER ---------- */
    let checkoutUrl = null;

    if (
      intent === "LOCK_PRICE" &&
      product.variantId &&
      finalPrice >= floorPrice
    ) {
      console.log("🧾 CREATING DRAFT ORDER");

      checkoutUrl = await createDraftOrder({
        variantId: product.variantId,
        originalPrice: basePrice,
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

/* ---------- SHOPIFY DRAFT ORDER ---------- */
async function createDraftOrder({ variantId, originalPrice, agreedPrice }) {
  console.log("🛒 DRAFT ORDER INPUT", {
    variantId,
    originalPrice,
    agreedPrice,
  });

  const res = await fetch(
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
              price: agreedPrice, // ✅ price override (correct way)
            },
          ],
          note: `AI negotiated from ₹${originalPrice} to ₹${agreedPrice}`,
        },
      }),
    }
  );

  const data = await res.json();

  console.log(
    "🧾 SHOPIFY DRAFT RESPONSE:",
    JSON.stringify(data, null, 2)
  );

  if (!res.ok || !data?.draft_order) {
    console.error("❌ SHOPIFY ERROR RESPONSE", data);
    throw new Error("Draft order creation failed");
  }

  if (!data.draft_order.invoice_url) {
    throw new Error("Invoice URL missing in Shopify response");
  }

  console.log("✅ INVOICE URL:", data.draft_order.invoice_url);

  return data.draft_order.invoice_url;
}

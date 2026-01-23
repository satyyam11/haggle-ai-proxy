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

  try {
    const { message, product, threadId } = req.body || {};

    if (!message || !product?.price || !product?.name) {
      res.writeHead(400, corsHeaders);
      return res.end(JSON.stringify({ reply: "Invalid input" }));
    }

    const basePrice = Number(product.price);
    const floorPrice = Math.round(basePrice * 0.8);
    const fallbackPrice = Math.round(basePrice * 0.9);

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

User: "${message}"

Respond strictly as JSON:
{"reply":"","agreed_price":null,"action":"NONE"}
`.trim();

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
    } catch {}

    let checkoutUrl = null;

    if (action === "LOCK" && agreedPrice) {
      checkoutUrl = await createDraftOrder({
        title: product.name,
        price: agreedPrice,
      });
    }

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
    console.error(err);
    res.writeHead(500, corsHeaders);
    res.end(JSON.stringify({ reply: "Something went wrong" }));
  }
}

async function createDraftOrder({ title, price }) {
  const res = await fetch(
    `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-01/draft_orders.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        draft_order: {
          line_items: [
            {
              title,
              price: String(price),
              quantity: 1,
            },
          ],
          note: "AI negotiated price",
        },
      }),
    }
  );

  const data = await res.json();

  if (!res.ok) throw new Error("Draft order failed");

  return data.draft_order.invoice_url;
}

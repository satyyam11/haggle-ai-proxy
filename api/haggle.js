import fetch from "node-fetch";

export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method Not Allowed" });
  }

  if (!process.env.WEBHOOK_SECRET) {
    console.error("❌ WEBHOOK_SECRET missing");
    return res.status(500).json({ reply: "Server misconfigured" });
  }

  try {
    const incoming = req.body;

    console.log("========== INCOMING FRONTEND PAYLOAD ==========");
    console.log(JSON.stringify(incoming, null, 2));
    console.log("==============================================");

    const userMessage = incoming.message;
    const product = incoming.product;
    let threadId = incoming.threadId || null;

    if (!userMessage || !product || !product.price) {
      return res.status(400).json({ reply: "Invalid input" });
    }

    const basePrice = Number(product.price);
    const floorPrice = Math.round(basePrice * 0.8);
    const fallbackPrice = Math.round(basePrice * 0.9);

    const aiPrompt = `
You are HAGGLE — a playful Indian price negotiator.

Product: ${product.name}
Price: ₹${basePrice}
Floor: ₹${floorPrice}

Rules:
- INR only
- Never below floor
- No greetings
- Max 2 short sentences
- JSON only

User: "${userMessage}"

Reply ONLY as JSON:
{
  "reply": "",
  "agreed_price": null,
  "action": "NONE"
}
`.trim();

    console.log("========== AI REQUEST PAYLOAD ==========");
    console.log(JSON.stringify({ message: aiPrompt, threadId }, null, 2));
    console.log("=======================================");

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

    console.log("========== RAW AI RESPONSE ==========");
    console.log(aiText);
    console.log("====================================");

    let reply = `I can offer ₹${fallbackPrice}. Want me to lock it in?`;
    let action = "NONE";

    try {
      const outer = JSON.parse(aiText);
      let inner = outer.response || "";

      inner = inner.replace(/```json|```/g, "").trim();
      const match = inner.match(/\{[\s\S]*\}/);

      if (match) {
        const parsed = JSON.parse(match[0]);
        reply = parsed.reply || reply;
        action = parsed.action || "NONE";
      }

      threadId = outer.threadId || threadId;
    } catch {
      console.error("⚠️ AI PARSE FAILED, USING FALLBACK");
    }

    return res.status(200).json({
      reply,
      agreed_price: null,
      action,
      threadId,
    });

  } catch (err) {
    console.error("🔥 HAGGLE FATAL ERROR:", err);
    return res.status(500).json({
      reply: "I’m having trouble right now. Please try again.",
    });
  }
}

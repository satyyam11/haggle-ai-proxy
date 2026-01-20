export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method Not Allowed" });
  }

  if (!process.env.WEBHOOK_SECRET) {
    console.error("❌ WEBHOOK_SECRET missing");
    return res.status(500).json({ reply: "Server misconfigured" });
  }

  try {
    // ---------- INPUT ----------
    const incoming = req.body;
    const userMessage = incoming?.message;
    const product = incoming?.product;
    let threadId = incoming?.threadId || null;

    if (!userMessage || !product?.price) {
      return res.status(400).json({ reply: "Invalid input" });
    }

    const basePrice = Number(String(product.price).replace(/,/g, ""));
    const floorPrice = Math.round(basePrice * 0.8);
    const fallbackPrice = Math.round(basePrice * 0.9);

    // 🔒 IF PRICE IS ALREADY LOCKED → DO NOT RE-NEGOTIATE
    if (incoming?.locked_price) {
      return res.status(200).json({
        reply: `Locked at ₹${incoming.locked_price}. You can add it to cart.`,
        action: "LOCK",
        agreed_price: incoming.locked_price,
        threadId
      });
    }

    // ---------- PROMPT ----------
    const aiPrompt = `
You are HAGGLE, a smart price negotiator.

Product: ${product.name}
Price: ₹${basePrice}
Minimum allowed: ₹${floorPrice}

Rules:
- Respond ONLY in valid JSON
- No markdown
- No explanations
- Keep reply natural

JSON format (MANDATORY):
{
  "reply": "",
  "action": "LOCK | COUNTER | REJECT",
  "agreed_price": number | null
}

User: "${userMessage}"
`.trim();

    // ---------- AI CALL WITH TIMEOUT ----------
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let aiText = "";
    try {
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
          signal: controller.signal,
        }
      );

      aiText = await aiRes.text();
    } catch {
      return res.status(200).json({
        reply: `I can do ₹${fallbackPrice}. Want to lock it?`,
        action: "COUNTER",
        agreed_price: null,
        threadId,
      });
    } finally {
      clearTimeout(timeout);
    }

    // ---------- PARSE AI (FAIL-SAFE) ----------
    let reply = `I can do ₹${fallbackPrice}. Want to lock it?`;
    let action = "COUNTER";
    let agreed_price = null;

    try {
      const outer = JSON.parse(aiText);
      const raw = (outer.response || "").replace(/```json|```/g, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { reply: raw };
      }

      reply = parsed.reply || reply;
      action = parsed.action || action;
      agreed_price =
        typeof parsed.agreed_price === "number"
          ? parsed.agreed_price
          : action === "LOCK"
          ? Number(reply.match(/\d+/)?.[0]) || null
          : null;

      threadId = outer.threadId || threadId;
    } catch {
      console.error("⚠️ AI parse failed");
    }

    // ---------- FINAL ----------
    return res.status(200).json({
      reply,
      action,
      agreed_price,
      threadId,
    });

  } catch (err) {
    console.error("🔥 HAGGLE ERROR:", err);
    return res.status(200).json({
      reply: "I’m having trouble right now. Can we try again?",
      action: "COUNTER",
      agreed_price: null,
    });
  }
}

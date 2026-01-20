function generateThreadId() {
  return "th_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({
      status: "ok",
      message: "Haggle API is live",
    });
  }

  if (req.method !== "POST") {
    return res.status(200).json({ reply: "Unsupported request" });
  }

  if (!process.env.WEBHOOK_SECRET) {
    console.error("❌ WEBHOOK_SECRET missing");
    return res.status(500).json({ reply: "Server misconfigured" });
  }

  try {
    const incoming = req.body;

    console.log("📥 INCOMING FRONTEND PAYLOAD");
    console.log(JSON.stringify(incoming, null, 2));

    const userMessage = incoming?.message;
    const product = incoming?.product;
    const threadId = incoming?.threadId || generateThreadId();

    if (!userMessage || !product?.price) {
      return res.status(200).json({
        reply: "Please send a valid message 😊",
        action: "COUNTER",
        agreed_price: null,
        threadId,
      });
    }

    const basePrice = Number(String(product.price).replace(/,/g, ""));
    const floorPrice = Math.round(basePrice * 0.8);
    const fallbackPrice = Math.round(basePrice * 0.9);

    // ---------- LOCK SHORT-CIRCUIT ----------
    if (incoming?.locked_price) {
      console.log("🔒 LOCK CONFIRMED:", incoming.locked_price);

      return res.status(200).json({
        reply: `Done 😄 I’ve locked it at ₹${incoming.locked_price}.`,
        action: "LOCK",
        agreed_price: incoming.locked_price,
        threadId,
      });
    }

    const aiPrompt = `
You are HAGGLE — playful Indian bargain assistant who negotiates product prices within strict limits.

Product name: ${product.name}
Listed price: ₹${basePrice}
Minimum allowed price: ₹${floorPrice}

Rules:
- Never go below the minimum allowed price
- Do not use markdown
- Do not add any text outside JSON

Return a SINGLE valid JSON object on ONE line.
End the response immediately after the closing brace }.

JSON format:
{"reply":"","action":"COUNTER | LOCK | REJECT","agreed_price":null}

User says: "${userMessage}"
`.trim();

    console.log("🤖 AI PROMPT SENT");
    console.log(aiPrompt);

    // ---------- AI CALL (15s timeout for demo safety) ----------
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

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
    } catch (err) {
      console.error("⏱️ AI TIMEOUT OR ERROR", err);

      return res.status(200).json({
        reply: `Hmm 😄 AI is a bit slow right now. How about ₹${fallbackPrice}?`,
        action: "COUNTER",
        agreed_price: null,
        threadId,
      });
    } finally {
      clearTimeout(timeout);
    }

    console.log("📤 RAW AI RESPONSE");
    console.log(aiText);

    let reply = `I can do ₹${fallbackPrice} 😊`;
    let action = "COUNTER";
    let agreed_price = null;

    try {
      const outer = JSON.parse(aiText);
      const raw = (outer.response || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      reply = parsed.reply || reply;
      action = parsed.action || action;
      agreed_price =
        typeof parsed.agreed_price === "number"
          ? parsed.agreed_price
          : null;
    } catch (err) {
      console.error("⚠️ AI PARSE FAILED");
    }

    console.log("✅ FINAL RESPONSE TO FRONTEND");
    console.log({ reply, action, agreed_price, threadId });

    return res.status(200).json({
      reply,
      action,
      agreed_price,
      threadId,
    });
  } catch (err) {
    console.error("🔥 BACKEND FATAL ERROR", err);
    return res.status(200).json({
      reply: "I’m having trouble right now. Please try again.",
      action: "COUNTER",
      agreed_price: null,
    });
  }
}

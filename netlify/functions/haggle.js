exports.handler = function (event) {
  var corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  if (!process.env.WEBHOOK_SECRET) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ reply: "Server misconfigured" }),
    };
  }

  try {
    var rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf-8")
      : event.body;

    var incoming = JSON.parse(rawBody);

    var userMessage = incoming.message;
    var product = incoming.product;
    var threadId = incoming.threadId || null;

    if (!userMessage || !product || !product.price) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "Invalid input" }),
      };
    }

    var basePrice = Number(product.price);
    var floorPrice = Math.round(basePrice * 0.8);
    var fallbackPrice = Math.round(basePrice * 0.9);

    var aiPrompt =
      "ROLE: HAGGLE (friendly Indian negotiator)\n" +
      "PRODUCT: " + product.name + "\n" +
      "PRICE: ₹" + basePrice + "\n" +
      "FLOOR: ₹" + floorPrice + "\n\n" +
      "RULES:\n" +
      "- INR only\n" +
      "- Never below floor\n" +
      "- No greetings\n" +
      "- Max 2 sentences\n" +
      "- JSON only\n\n" +
      'USER: "' + userMessage + '"\n\n' +
      "JSON:\n" +
      '{ "reply": "", "agreed_price": null, "action": "NONE" }';

    return fetch("https://connect.testmyprompt.com/webhook/696b75a82abe5e63ed202cde", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": process.env.WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        message: aiPrompt,
        threadId: threadId,
        type: "user_message",
      }),
    })
      .then(function (res) {
        return res.text();
      })
      .then(function (aiText) {
        var reply = "I can offer ₹" + fallbackPrice + ". Want me to lock it in?";
        var action = "NONE";

        try {
          var outer = JSON.parse(aiText);
          var inner = outer.response || "";
          inner = inner.replace(/```json|```/g, "").trim();

          var jsonMatch = inner.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            var parsed = JSON.parse(jsonMatch[0]);
            reply = parsed.reply || reply;
            action = parsed.action || "NONE";
          }

          threadId = outer.threadId || threadId;
        } catch (e) {}

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            reply: reply,
            agreed_price: null,
            action: action,
            threadId: threadId,
          }),
        };
      })
      .catch(function () {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            reply: "I can offer ₹" + fallbackPrice + ". Want me to lock it in?",
            agreed_price: null,
            action: "NONE",
            threadId: threadId,
          }),
        };
      });

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ reply: "Internal error" }),
    };
  }
};

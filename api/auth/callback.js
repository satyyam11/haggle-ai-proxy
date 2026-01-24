export default async function handler(req, res) {
  const { code, shop } = req.query;

  console.log("🔐 OAUTH CALLBACK HIT");
  console.log({ code, shop });

  if (!code || !shop) {
    return res.status(400).send("Missing code or shop");
  }

  try {
    console.log("🔄 EXCHANGING CODE FOR ACCESS TOKEN");

    const tokenRes = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_CLIENT_ID,
          client_secret: process.env.SHOPIFY_CLIENT_SECRET,
          code,
        }),
      }
    );

    const tokenData = await tokenRes.json();

    console.log("🪙 SHOPIFY TOKEN RESPONSE");
    console.log(JSON.stringify(tokenData, null, 2));

    if (!tokenData.access_token) {
      return res.status(500).json(tokenData);
    }

    console.log("✅ NEW ACCESS TOKEN:", tokenData.access_token);

    return res.send(
      "App installed. Token logged in server logs. You can close this tab."
    );
  } catch (err) {
    console.error("🔥 OAUTH ERROR", err);
    return res.status(500).send("OAuth failed");
  }
}

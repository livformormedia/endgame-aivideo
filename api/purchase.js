const stripe = require('stripe');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'REDACTED_STRIPE_KEY';
const WEBHOOK_SECRET    = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_OA1wQxGCTYAA6Iw7JUNvRliyVGnO6l41';
const PIXEL_ID          = process.env.FB_PIXEL_ID || '2159928257879426';
const CAPI_TOKEN        = process.env.FB_CAPI_TOKEN || 'EAAU9JykAMVQBRJ0nKMAUjw8SvN5zhmpzbDbQuYZCCCZC5AUNlvPzQx6GNQP3WoBukTtpjaIABsL9fi6vHh6ZBBJOBFLMervveECreSBSeZBi2pKzlwwX3eaPv6olGZCCxlwmT1udZB6ZBCOmqHvxgK1kNiRnZBJ0rVkr5db1ZA3HbcAlMTuQIJ2EjGfYlbqs3Cxj9XwZDZD';
const GHL_TOKEN         = process.env.GHL_TOKEN || 'pit-0cefae17-b065-44da-959f-ef41333bab4e';
const GHL_LOC           = process.env.GHL_LOCATION_ID || 'bNQj4Ti60XKt9BqMiCPE';
// ─────────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).end('Method Not Allowed');
  }

  // Collect raw body — required for Stripe signature verification
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks);
  const sig = req.headers['stripe-signature'];

  // Verify webhook signature
  let event;
  try {
    const stripeClient = stripe(STRIPE_SECRET_KEY);
    event = stripeClient.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature error:', err.message);
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
  }

  // Only care about completed checkouts
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, skipped: event.type });
  }

  const session = event.data.object;
  const email   = session.customer_details?.email;
  const amount  = session.amount_total; // cents

  if (!email) {
    console.warn('checkout.session.completed with no email — skipping CAPI/GHL');
    return res.status(200).json({ received: true, note: 'no_email' });
  }

  const hashedEmail = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
  const eventId     = 'purchase_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

  // ── Fire FB CAPI Purchase ──────────────────────────────────────────────────
  try {
    const capiRes = await fetch(
      `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [{
            event_name:    'Purchase',
            event_time:    Math.floor(Date.now() / 1000),
            event_id:      eventId,
            action_source: 'website',
            user_data: {
              em: [hashedEmail],
            },
            custom_data: {
              value:        amount / 100,
              currency:     'USD',
              content_name: 'Endgame AI Video Program',
              content_type: 'product',
            },
          }],
        }),
      }
    );
    const capiData = await capiRes.json();
    console.log('FB CAPI response:', JSON.stringify(capiData));
  } catch (err) {
    console.error('FB CAPI error:', err.message);
    // Non-fatal — don't fail the webhook
  }

  // ── Update GHL contact → add 'purchased' tag ──────────────────────────────
  try {
    // Search contact by email
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/search?locationId=${GHL_LOC}&query=${encodeURIComponent(email)}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_TOKEN}`,
          'Version':       '2021-07-28',
        },
      }
    );
    const searchData = await searchRes.json();
    const contact = searchData.contacts?.find(c => c.email?.toLowerCase() === email.toLowerCase());

    if (contact) {
      // Additive tag POST — does not wipe existing tags
      const tagRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/${contact.id}/tags`,
        {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${GHL_TOKEN}`,
            'Version':       '2021-07-28',
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ tags: ['purchased'] }),
        }
      );
      const tagData = await tagRes.json();
      console.log('GHL tag response:', JSON.stringify(tagData));
    } else {
      // Contact doesn't exist yet (bought without opting in — rare but possible)
      // Upsert with bare minimum
      const upsertRes = await fetch(
        'https://services.leadconnectorhq.com/contacts/upsert',
        {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${GHL_TOKEN}`,
            'Version':       '2021-07-28',
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            locationId: GHL_LOC,
            email,
            tags: ['purchased'],
          }),
        }
      );
      const upsertData = await upsertRes.json();
      console.log('GHL upsert (new contact) response:', JSON.stringify(upsertData));
    }
  } catch (err) {
    console.error('GHL error:', err.message);
    // Non-fatal
  }

  return res.status(200).json({ received: true, eventId });
};

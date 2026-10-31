const API = 'https://api.sellauth.com/v1';
const DAY = 86400000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (!env.TEST_KEY || url.searchParams.get('key') !== env.TEST_KEY) {
        return new Response('Not Found', { status: 404 });
      }

      try {
        if (url.pathname === '/test') {
          await push(env, {
            title: 'New Sale!',
            message: `€29.99 from Online Store\nToday: €420.00 · 12 orders\n• ${shopName(env)}`,
          });
          return new Response('✅ Test notification sent! Check your phones.');
        }

        if (url.pathname === '/summary') {
          await sendSummary(env);
          return new Response('✅ Summary sent! Check your phones.');
        }
      } catch (err) {
        return new Response(err.message, { status: 502 });
      }

      return new Response('Not Found', { status: 404 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (!env.SELLAUTH_WEBHOOK_SECRET) {
      return new Response('SELLAUTH_WEBHOOK_SECRET not set', { status: 500 });
    }

    const body = await request.text();

    if (!(await validSignature(body, request.headers.get('X-Signature'), env.SELLAUTH_WEBHOOK_SECRET))) {
      return new Response('Invalid signature', { status: 401 });
    }

    let payload;

    try {
      payload = JSON.parse(body);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Non-200 makes SellAuth retry (3 attempts, 5s apart).
    try {
      const notification = await buildNotification(payload.event, payload.data ?? {}, env);
      if (notification) await push(env, notification);
    } catch (err) {
      return new Response(err.message, { status: 502 });
    }

    return new Response('OK');
  },

  // Cron Trigger, e.g. "0 */4 * * *"
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendSummary(env));
  },
};

async function buildNotification(event, data, env) {
  switch (event) {
    case 'NOTIFICATION.SHOP_INVOICE_PROCESSED': {
      const invoice = await sellauth(env, `/invoices/${data.invoice_id}`);
      const type = saleType(invoice);
      const [today, subs] = await Promise.all([
        getStats(env, startOfDay(env), new Date()),
        type === 'sale' ? '' : subscriptionLine(env),
      ]);
      const amount = money(invoice.price, invoice.currency);

      const headline = {
        sale: ['New Sale!', `${amount} from Online Store`],
        newSub: ['New Subscriber!', `${amount} new subscription`],
        renewal: ['Subscription Renewed', `${amount} renewal · cycle ${invoice.subscription_cycle}`],
      }[type];

      return {
        title: headline[0],
        message:
          `${headline[1]}\n` +
          `Today: ${money(today.revenue, invoice.currency)} · ${plural(today.orders, 'order')}\n` +
          (subs ? `${subs}\n` : '') +
          `• ${shopName(env)}`,
      };
    }

    case 'NOTIFICATION.SHOP_PAYMENT_DISPUTE_OPENED': {
      const due = data.evidence_due_at
        ? `\nEvidence due ${new Date(data.evidence_due_at).toLocaleString('en-US', { timeZone: timeZone(env), dateStyle: 'medium', timeStyle: 'short' })}`
        : '';
      return alert('Chargeback Opened', `${money(data.amount, data.currency)} · Invoice #${data.invoice_id}${due}`);
    }

    case 'NOTIFICATION.SHOP_PRODUCT_OUT_OF_STOCK': {
      const product = await sellauth(env, `/products/${data.product_id}`);
      const variant = product.variants?.find((v) => v.id == data.variant_id);
      return alert('Out of Stock', variant ? `${product.name} · ${variant.name}` : product.name);
    }

    case 'NOTIFICATION.SHOP_INVOICE_OUT_OF_STOCK':
      return alert('Delivery Failed', `Invoice #${data.invoice_id} was paid but not delivered: out of stock`);

    case 'NOTIFICATION.SHOP_ERROR':
      return alert(`Shop Error: ${data.title}`, data.description || 'Check your SellAuth dashboard');

    default:
      return null;
  }
}

async function sendSummary(env) {
  const now = new Date();
  const start = startOfDay(env, now);

  const [today, yesterday, subs] = await Promise.all([
    getStats(env, start, now),
    getStats(env, new Date(start - DAY), new Date(now - DAY)),
    subscriptionLine(env),
  ]);

  const time = now.toLocaleTimeString('en-US', { timeZone: timeZone(env), hour: 'numeric', minute: '2-digit' });
  let message;

  if (today.orders === 0) {
    message = 'No orders yet today';
  } else {
    message =
      `${money(today.revenue, today.currency)} · ${plural(today.orders, 'order')} today\n` +
      `${plural(today.sale, 'sale')} · ${plural(today.newSub, 'new subscriber')} · ${plural(today.renewal, 'renewal')}`;
  }

  if (yesterday.revenue > 0) {
    const change = Math.round(((today.revenue - yesterday.revenue) / yesterday.revenue) * 100);
    message += `\n${change >= 0 ? '+' : ''}${change}% vs yesterday at this time`;
  }

  await push(env, {
    title: `📊 Sales Summary · ${time}`,
    message: `${message}\n${subs}\n• ${shopName(env)}`,
  });
}

// SellAuth only reports MRR in USD.
async function subscriptionLine(env) {
  const stats = await sellauth(env, '/subscriptions/stats');
  return `MRR: ${money(stats.mrr_usd)} · ${plural(stats.active, 'subscriber')}`;
}

// ponytail: sums invoice `price` and assumes one shop currency; switch to price_usd if you sell in several.
async function getStats(env, from, to) {
  const stats = { revenue: 0, orders: 0, sale: 0, newSub: 0, renewal: 0, currency: null };

  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      'statuses[]': 'completed',
      completed_at_start: from.toISOString(),
      completed_at_end: to.toISOString(),
      perPage: '100',
      page: String(page),
      all: '1',
    });
    const res = await sellauth(env, `/invoices?${query}`);

    for (const invoice of res.data ?? []) {
      stats.revenue += Number(invoice.price) || 0;
      stats.orders++;
      stats[saleType(invoice)]++;
      stats.currency ??= invoice.currency;
    }

    if (page >= (res.last_page ?? 1)) return stats;
  }
}

// Every paid subscription cycle gets its own invoice linked to the subscription.
function saleType(invoice) {
  if (!invoice.product_subscription_id) return 'sale';
  return invoice.subscription_cycle > 1 ? 'renewal' : 'newSub';
}

async function sellauth(env, path) {
  const res = await fetch(`${API}/shops/${env.SELLAUTH_SHOP_ID}${path}`, {
    headers: {
      Authorization: `Bearer ${env.SELLAUTH_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`SellAuth API error ${res.status} on ${path}`);
  return res.json();
}

async function push(env, { title, message, sound = 'shopify' }) {
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: env.PUSHOVER_TOKEN,
      user: env.PUSHOVER_GROUP ?? env.PUSHOVER_USER,
      title,
      message,
      sound,
    }),
  });

  if (!res.ok) throw new Error(`Pushover error: ${await res.text()}`);
}

function alert(title, message) {
  return { title: `⚠️ ${title}`, message, sound: 'siren' };
}

async function validSignature(body, signature, secret) {
  if (!/^[0-9a-f]{64}$/i.test(signature ?? '')) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const bytes = new Uint8Array(signature.match(/../g).map((h) => parseInt(h, 16)));

  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(body));
}

// Midnight in TIMEZONE, as a UTC Date.
function startOfDay(env, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone(env),
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)])
  );
  const offset =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    Math.floor(now / 1000) * 1000;

  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - offset);
}

function money(amount, currency = 'USD') {
  return Number(amount).toLocaleString('en-US', { style: 'currency', currency });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function shopName(env) {
  return env.SHOP_NAME ?? 'Your Store';
}

function timeZone(env) {
  return env.TIMEZONE ?? 'UTC';
}

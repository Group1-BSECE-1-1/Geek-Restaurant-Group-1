
const express = require('express');

const app = express();
app.use(express.json());
if (process.env.DEV_CORS === '1') {
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// Enable CORS only when working alone.
// Start with DEV_CORS=1 for local browser testing.
if (process.env.DEV_CORS === '1') {
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization'
    );
    res.set(
      'Access-Control-Allow-Methods',
      'GET, POST, PATCH, OPTIONS'
    );

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  });
}

// ERPNext configuration comes from .env.
// The server can still run its order API without ERPNext credentials.
const ERP_URL = (process.env.ERP_URL || 'http://localhost:8080')
  .replace(/\/+$/, '');
const ERP_KEY = process.env.ERP_KEY;
const ERP_SECRET = process.env.ERP_SECRET;

const ERP_ENABLED = Boolean(ERP_KEY && ERP_SECRET);

// Item codes supplied for Geek Restaurant.
const ITEM_CODES = [
  'D001',
  'D001-L',
  'D001-M',
  'D001-S',
  'D002',
  'D003',
  'DS001',
  'DS002',
  'DS003',
  'DS003-CRB-F',
  'DS003-CRB-NF',
  'DS003-DCL-F',
  'DS003-DCL-NF',
  'DS003-STRW-F',
  'DS003-STRW-NF',
  'M001',
  'M0011',
  'M0011-NSP',
  'M0011-SP',
  'M002'
];

let menu = [];
const orders = [];
let counter = 1000;

const findOrder = (no) =>
  orders.find((order) => order.order_no === no);

function both(path, handler) {
  app.post(path, handler);
  app.patch(path, handler);
}

async function erpRequest(path, options = {}) {
  if (!ERP_ENABLED) {
    throw new Error(
      'ERPNext is not configured. Check ERP_KEY and ERP_SECRET in .env.'
    );
  }

  const response = await fetch(ERP_URL + path, {
    ...options,
    headers: {
      Authorization: `token ${ERP_KEY}:${ERP_SECRET}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const text = await response.text();

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text };
  }

  if (!response.ok) {
    throw new Error(
      `ERPNext HTTP ${response.status}: ` +
      JSON.stringify(body).slice(0, 500)
    );
  }

  return body;
}

// Read actual item names and selling prices from ERPNext.
// Items without a configured Standard Selling price are omitted.
async function loadMenu() {
  if (!ERP_ENABLED) {
    throw new Error(
      'ERPNext credentials are missing. Configure your .env file first.'
    );
  }

  const itemParams = new URLSearchParams({
    fields: JSON.stringify([
      'item_code',
      'item_name',
      'item_group',
      'disabled'
    ]),
    filters: JSON.stringify([
      ['disabled', '=', 0]
    ]),
    limit_page_length: '500'
  });

  const itemResult = await erpRequest(
    '/api/resource/Item?' + itemParams.toString()
  );

  const items = (itemResult.data || []).filter(
    (item) => ITEM_CODES.includes(item.item_code)
  );

  const priceParams = new URLSearchParams({
    fields: JSON.stringify([
      'item_code',
      'price_list_rate',
      'price_list',
      'selling'
    ]),
    filters: JSON.stringify([
      ['selling', '=', 1],
      ['price_list', '=', 'Standard Selling']
    ]),
    limit_page_length: '500'
  });

  const priceResult = await erpRequest(
    '/api/resource/Item Price?' + priceParams.toString()
  );

  const prices = new Map();

  for (const price of priceResult.data || []) {
    if (
      ITEM_CODES.includes(price.item_code) &&
      Number.isFinite(Number(price.price_list_rate))
    ) {
      prices.set(
        price.item_code,
        Number(price.price_list_rate)
      );
    }
  }

  menu = items
    .filter((item) => prices.has(item.item_code))
    .map((item) => ({
      id: item.item_code,
      name: item.item_name || item.item_code,
      category: item.item_group || 'Other',
      price: prices.get(item.item_code)
    }));

  console.log(
    `ERPNext menu loaded: ${menu.length} of ${ITEM_CODES.length} configured item codes.`
  );

  const missing = ITEM_CODES.filter(
    (code) => !menu.some((item) => item.id === code)
  );

  if (missing.length) {
    console.log('Missing, disabled, or unpriced items:', missing.join(', '));
  }

  return menu;
}

// Menu
app.get('/api/v1/menu', async (req, res) => {
  try {
    await loadMenu();
    res.json(menu);
  } catch (error) {
    console.error('Menu error:', error.message);
    res.status(502).json({
      error: 'Could not load the ERPNext menu.',
      details: error.message
    });
  }
});

// Create order
app.post('/api/v1/orders', async (req, res) => {
  try {
    await loadMenu();

    const items = req.body && req.body.items;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const lines = [];
    let total = 0;

    for (const item of items) {
      const product = menu.find((entry) => entry.id === item.id);

      if (
        !product ||
        !Number.isInteger(item.qty) ||
        item.qty < 1
      ) {
        return res.status(400).json({
          error: 'Invalid item or quantity: ' + item.id
        });
      }

      lines.push({
        id: product.id,
        name: product.name,
        qty: item.qty,
        price: product.price
      });

      total += product.price * item.qty;
    }

    counter++;

    const order = {
      order_no: 'A' + counter,
      items: lines,
      total,
      payment_status: 'PENDING',
      fulfillment_status: 'RECEIVED',
      created_at: new Date().toISOString()
    };

    orders.push(order);
    res.status(201).json(order);
  } catch (error) {
    console.error('Create order error:', error.message);
    res.status(502).json({
      error: 'Could not create order using the ERPNext menu.',
      details: error.message
    });
  }
});

// List orders
app.get('/api/v1/orders', (req, res) => {
  res.json(orders);
});

// Get one order
app.get('/api/v1/orders/:no', (req, res) => {
  const order = findOrder(req.params.no);

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  res.json(order);
});

// Create a Sales Invoice in ERPNext after payment.
async function pushToErp(order) {
  if (!ERP_ENABLED) {
    console.log('ERPNext invoice skipped: credentials are not configured.');
    return;
  }

  const result = await erpRequest(
    '/api/resource/' + encodeURIComponent('Sales Invoice'),
    {
      method: 'POST',
      body: JSON.stringify({
        customer: 'Walk-in Customer',
        items: order.items.map((item) => ({
          item_code: item.id,
          qty: item.qty,
          rate: item.price
        }))
      })
    }
  );

  order.erp_invoice = result.data.name;

  console.log('ERPNext Sales Invoice created:', result.data.name);
}

// Order status transitions
function step(needPay, needFul, changes, after) {
  return async (req, res) => {
    const order = findOrder(req.params.no);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    if (
      order.payment_status !== needPay ||
      order.fulfillment_status !== needFul
    ) {
      return res.status(409).json({
        error:
          'Not allowed now: ' +
          order.payment_status +
          '/' +
          order.fulfillment_status
      });
    }

    Object.assign(order, changes);

    if (after) {
      try {
        await after(order);
      } catch (error) {
        console.error('ERPNext invoice error:', error.message);

        // The payment state has changed, but the invoice may not exist.
        return res.status(502).json({
          error: 'Payment recorded locally, but ERPNext invoice creation failed.',
          details: error.message,
          order
        });
      }
    }

    res.json(order);
  };
}

both(
  '/api/v1/orders/:no/payment',
  step(
    'PENDING',
    'RECEIVED',
    { payment_status: 'PAID' },
    pushToErp
  )
);

both(
  '/api/v1/orders/:no/preparing',
  step(
    'PAID',
    'RECEIVED',
    { fulfillment_status: 'PREPARING' }
  )
);

both(
  '/api/v1/orders/:no/ready',
  step(
    'PAID',
    'PREPARING',
    { fulfillment_status: 'READY' }
  )
);

both(
  '/api/v1/orders/:no/complete',
  step(
    'PAID',
    'READY',
    { fulfillment_status: 'COMPLETED' }
  )
);

// Kitchen: paid orders only, oldest first
app.get('/api/v1/kitchen/orders', (req, res) => {
  res.json(
    orders.filter(
      (order) =>
        order.payment_status === 'PAID' &&
        ['RECEIVED', 'PREPARING', 'READY'].includes(
          order.fulfillment_status
        )
    )
  );
});

// Public order display: show order number and column only
app.get('/api/v1/display/orders', (req, res) => {
  const result = orders
    .filter(
      (order) =>
        !['COMPLETED', 'CANCELLED'].includes(
          order.fulfillment_status
        )
    )
    .map((order) => ({
      order_no: order.order_no,
      column:
        order.payment_status === 'PENDING'
          ? 'PAYMENT'
          : order.fulfillment_status === 'READY'
            ? 'READY'
            : 'PREPARING'
    }));

  res.json(result);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Order API running at http://localhost:${PORT}`);
  console.log(`ERPNext URL: ${ERP_URL}`);
  console.log(`ERPNext integration: ${ERP_ENABLED ? 'enabled' : 'disabled'}`);
});

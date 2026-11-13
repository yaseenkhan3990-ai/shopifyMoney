import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'node:crypto';

const router = express.Router();
const paymentSessions = new Map();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const normalizeEmail = email => String(email || '').trim().toLowerCase();

const parsePositiveAmount = amount => {
  const value = Number(amount);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Number(value.toFixed(2));
};

const verifyPaymentSignature = (orderId, paymentId, signature) => {
  if (!/^[a-f0-9]{64}$/i.test(String(signature || ''))) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest();
  const received = Buffer.from(signature, 'hex');

  return received.length === expected.length &&
    crypto.timingSafeEqual(received, expected);
};

const shopifyGraphQL = async (query, variables = {}) => {
  const domain = process.env.SHOPIFY_STORE;
  const version = process.env.SHOPIFY_API_VERSION || '2026-10';

  const response = await fetch(
    `https://${domain}/admin/api/${version}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN
      },
      body: JSON.stringify({ query, variables })
    }
  );
  const data = await response.json();

  if (!response.ok || data.errors?.length) {
    console.error('Shopify GraphQL error:', data.errors || data);
    throw new Error('Shopify API request failed');
  }

  return data.data;
};

router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Shopify Razorpay Checkout API',
    endpoints: {
      createOrder: 'POST /checkout/create-order',
      verifyPayment: 'POST /checkout/verify-payment',
      paymentFailure: 'POST /checkout/payment-failure'
    }
  });
});

router.post('/create-order', async (req, res) => {
  try {
    const {
      shop,
      customer,
      shipping_address,
      cart_items,
      total,
      cart_total
    } = req.body || {};
    const email = normalizeEmail(customer?.email);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Valid customer email is required'
      });
    }

    if (!Array.isArray(cart_items) || cart_items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cart is empty'
      });
    }

    const line_items = cart_items.map(item => ({
      variant_id: Number(item?.variant_id),
      quantity: Number(item?.quantity || 1)
    }));

    if (line_items.some(item =>
      !Number.isSafeInteger(item.variant_id) ||
      item.variant_id <= 0 ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 100
    )) {
      return res.status(400).json({
        success: false,
        message: 'Invalid cart items'
      });
    }

    if (
      !shipping_address?.name ||
      !shipping_address?.address ||
      !shipping_address?.city ||
      !shipping_address?.pincode ||
      !shipping_address?.phone
    ) {
      return res.status(400).json({
        success: false,
        message: 'Complete shipping details are required'
      });
    }

    const parsedTotal = parsePositiveAmount(total ?? cart_total);

    if (!parsedTotal) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order total'
      });
    }

    const amountInPaise = Math.round(parsedTotal * 100);

    if (!Number.isSafeInteger(amountInPaise) || amountInPaise < 100) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment amount'
      });
    }

    const checkoutId = crypto.randomUUID();
    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: checkoutId.replaceAll('-', '').slice(0, 40),
      notes: { checkoutId, customerEmail: email }
    });

    paymentSessions.set(checkoutId, {
      checkoutId,
      shop: String(shop || process.env.SHOPIFY_STORE || '').trim(),
      customer: {
        email,
        firstName: String(customer?.firstName || '').trim(),
        lastName: String(customer?.lastName || '').trim(),
        phone: String(customer?.phone || '').trim()
      },
      email,
      shipping_address,
      line_items,
      total: parsedTotal,
      amountInPaise,
      razorpayOrderId: razorpayOrder.id,
      status: 'created',
      createdAt: Date.now()
    });

    return res.status(201).json({
      success: true,
      checkoutId,
      razorpay_order_id: razorpayOrder.id,
      razorpay_key_id: process.env.RAZORPAY_KEY_ID,
      amount: amountInPaise,
      currency: 'INR',
      storeName: 'Sitara Style'
    });
  } catch (error) {
    console.error('Create Razorpay order error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create Razorpay order'
    });
  }
});

router.post('/verify-payment', async (req, res) => {
  let session;

  try {
    const {
      checkoutId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body || {};

    if (
      !checkoutId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        message: 'Payment verification details are required'
      });
    }

    session = paymentSessions.get(checkoutId);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Checkout session not found'
      });
    }

    if (session.status === 'completed') {
      return res.json({
        success: true,
        order_id: session.shopifyOrderId,
        order_name: session.orderName
      });
    }

    if (session.status === 'processing') {
      return res.status(409).json({
        success: false,
        message: 'Payment is already being processed'
      });
    }

    if (session.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({
        success: false,
        message: 'Razorpay order ID mismatch'
      });
    }

    if (!verifyPaymentSignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    )) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature'
      });
    }

    session.status = 'processing';

    let payment = await razorpay.payments.fetch(razorpay_payment_id);

    if (
      payment.order_id !== session.razorpayOrderId ||
      Number(payment.amount) !== session.amountInPaise ||
      payment.currency !== 'INR'
    ) {
      session.status = 'failed';

      return res.status(400).json({
        success: false,
        message: 'Payment details do not match'
      });
    }

    if (payment.status === 'authorized') {
      payment = await razorpay.payments.capture(
        razorpay_payment_id,
        session.amountInPaise,
        'INR'
      );
    }

    if (payment.status !== 'captured') {
      session.status = 'failed';

      return res.status(400).json({
        success: false,
        message: 'Payment has not been captured'
      });
    }

    session.status = 'paid_pending_shopify';
    session.paymentId = razorpay_payment_id;

    const mutation = `
      mutation CreatePaidOrder($order: OrderCreateOrderInput!) {
        orderCreate(order: $order) {
          userErrors {
            field
            message
          }
          order {
            id
            name
            displayFinancialStatus
          }
        }
      }
    `;
    const nameParts = String(session.shipping_address.name || '')
      .trim()
      .split(/\s+/);
    const shippingFirstName = nameParts.shift() || '';
    const shippingLastName = nameParts.join(' ');
    const firstName = session.customer.firstName || shippingFirstName;
    const lastName = session.customer.lastName || shippingLastName;
    const country = String(session.shipping_address.country || 'India').trim();
    const countryCode = country.toLowerCase() === 'india' ? 'IN' : undefined;
    const orderInput = {
      email: session.email,
      lineItems: session.line_items.map(item => ({
        variantId: `gid://shopify/ProductVariant/${item.variant_id}`,
        quantity: item.quantity
      })),
      shippingAddress: {
        firstName,
        lastName,
        address1: session.shipping_address.address,
        city: session.shipping_address.city,
        zip: session.shipping_address.pincode,
        phone: session.shipping_address.phone || session.customer.phone,
        province: session.shipping_address.province || undefined,
        country,
        ...(countryCode ? { countryCode } : {})
      },
      note: [
        `Razorpay Payment ID: ${razorpay_payment_id}`,
        `Checkout ID: ${checkoutId}`,
        session.shop ? `Shop: ${session.shop}` : ''
      ].filter(Boolean).join('\n'),
      tags: ['Razorpay', 'Online Payment', `checkout-${checkoutId}`],
      financialStatus: 'PAID',
      transactions: [{
        kind: 'SALE',
        status: 'SUCCESS',
        amountSet: {
          shopMoney: {
            amount: session.total.toFixed(2),
            currencyCode: 'INR'
          }
        }
      }]
    };

    const result = await shopifyGraphQL(mutation, { order: orderInput });
    const orderResult = result.orderCreate;

    if (orderResult.userErrors?.length || !orderResult.order) {
      throw new Error(
        orderResult.userErrors
          ?.map(error => error.message)
          .join(', ') || 'Shopify order creation failed'
      );
    }

    session.status = 'completed';
    session.shopifyOrderId = orderResult.order.id;
    session.orderName = orderResult.order.name;

    return res.json({
      success: true,
      paymentStatus: 'captured',
      order_id: orderResult.order.id,
      order_name: orderResult.order.name
    });
  } catch (error) {
    console.error('Payment verification error:', error);

    if (session) {
      session.status = session.paymentId
        ? 'paid_pending_shopify'
        : 'failed';
    }

    return res.status(500).json({
      success: false,
      paymentCaptured: Boolean(session?.paymentId),
      message: session?.paymentId
        ? 'Payment captured but Shopify order creation needs attention. Do not pay again.'
        : 'Payment verification failed'
    });
  }
});

router.post('/payment-failure', (req, res) => {
  const { checkoutId, error } = req.body || {};
  const session = paymentSessions.get(checkoutId);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: 'Checkout session not found'
    });
  }

  if (!['completed', 'paid_pending_shopify', 'processing'].includes(session.status)) {
    session.status = 'failed';
    session.failure = error || null;
  }

  return res.json({
    success: true,
    paymentStatus: session.status,
    message: 'Payment failure recorded'
  });
});

export default router;

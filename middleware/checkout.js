
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Razorpay from 'razorpay';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

const allowedOrigins = (process.env.FRONTEND_URL || 'https://sitara-style-2.myshopify.com')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed'));
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------------------------------------------------
// RAZORPAY CONFIGURATION
// --------------------------------------------------

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Temporary in-memory checkout storage.
// No MongoDB required.
// Restarting the server clears this data.
const paymentSessions = new Map();

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

const normalizeEmail = email =>
  String(email || '').trim().toLowerCase();

const parsePositiveAmount = amount => {
  const parsedAmount = Number(amount);

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return null;
  }

  return Number(parsedAmount.toFixed(2));
};

const verifyPaymentSignature = (
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature
) => {
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest();

  let receivedSignature;

  try {
    receivedSignature = Buffer.from(razorpaySignature, 'hex');
  } catch {
    return false;
  }

  return (
    receivedSignature.length === expectedSignature.length &&
    crypto.timingSafeEqual(receivedSignature, expectedSignature)
  );
};

// --------------------------------------------------
// HOME ROUTE
// --------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    message: 'Shopify Razorpay Payment API',
    endpoints: {
      createOrder: 'POST /create-order',
      verifyPayment: 'POST /verify-payment',
      paymentFailure: 'POST /payment-failure'
    }
  });
});

// --------------------------------------------------
// CREATE RAZORPAY ORDER
// --------------------------------------------------

app.post('/create-order', async (req, res) => {
  try {
    const {
      customer,
      shipping_address,
      cart_items,
      total: orderTotal
    } = req.body;

    // Validate request

    if (!customer?.email) {
      return res.status(400).json({
        success: false,
        message: 'Customer email is required'
      });
    }

    if (!Array.isArray(cart_items) || cart_items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cart is empty'
      });
    }

    const email = normalizeEmail(customer.email);
    const total = parsePositiveAmount(orderTotal);

    if (!email || !total) {
      return res.status(400).json({
        success: false,
        message: 'Invalid customer email or order total'
      });
    }

    // Convert rupees into paise for Razorpay.

    const amountInPaise = Math.round(total * 100);

    // Create Razorpay order.

    const checkoutId = crypto.randomUUID();

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: checkoutId.slice(0, 40),
      notes: {
        checkoutId,
        customerEmail: email
      }
    });

    // Prepare Shopify line items.

    const line_items = cart_items.map(item => ({
      variant_id: Number(item.variant_id),
      quantity: Number(item.quantity || 1)
    }));

    // Basic item validation.

    if (line_items.some(item =>
      !Number.isSafeInteger(item.variant_id) ||
      item.variant_id <= 0 ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1
    )) {
      return res.status(400).json({
        success: false,
        message: 'Invalid cart items'
      });
    }

    // Save checkout details temporarily.

    paymentSessions.set(checkoutId, {
      checkoutId,
      email,
      customer,
      shipping_address,
      line_items,
      total,
      amountInPaise,
      razorpayOrderId: razorpayOrder.id,
      status: 'created',
      createdAt: Date.now()
    });

    return res.status(200).json({
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
      message: 'Unable to create Razorpay order',
      error: error.message
    });
  }
});

// --------------------------------------------------
// VERIFY PAYMENT AND CREATE SHOPIFY ORDER
// --------------------------------------------------

app.post('/verify-payment', async (req, res) => {
  let session;

  try {
    const {
      checkoutId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

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

    // Prevent duplicate Shopify order creation.

    if (session.status === 'completed') {
      return res.status(200).json({
        success: true,
        order_id: session.shopifyOrderId,
        order_number: session.orderNumber,
        order_name: session.orderName,
        statusPageUrl: session.statusPageUrl
      });
    }

    if (session.status === 'processing') {
      return res.status(409).json({
        success: false,
        message: 'Payment verification is already processing'
      });
    }

    if (session.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({
        success: false,
        message: 'Razorpay order ID mismatch'
      });
    }

    // Verify Razorpay signature.

    const signatureValid = verifyPaymentSignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (!signatureValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Razorpay payment signature'
      });
    }

    session.status = 'processing';

    // Verify payment directly with Razorpay.

    let payment = await razorpay.payments.fetch(
      razorpay_payment_id
    );

    if (
      payment.order_id !== session.razorpayOrderId ||
      Number(payment.amount) !== session.amountInPaise ||
      payment.currency !== 'INR'
    ) {
      session.status = 'failed';

      return res.status(400).json({
        success: false,
        message: 'Payment details do not match the order'
      });
    }

    // Capture payment if it is authorized.

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

    // Payment successfully captured.

    session.status = 'paid_pending_shopify';
    session.paymentId = razorpay_payment_id;

    // Prepare Shopify payload using your existing approach.

    const shopifyPayload = {
      order: {
        email: session.email,
        financial_status: 'paid',

        line_items: session.line_items,

        shipping_address: {
          first_name: session.shipping_address?.name || '',
          address1: session.shipping_address?.address || '',
          city: session.shipping_address?.city || '',
          zip: session.shipping_address?.pincode || '',
          phone: session.shipping_address?.phone || '',
          country: 'India'
        },

        note: `Razorpay Payment ID: ${razorpay_payment_id}`,

        tags: 'Razorpay, Online Payment'
      }
    };

    console.log(
      'Shopify Payload:',
      JSON.stringify(shopifyPayload, null, 2)
    );

    // Create Shopify order.

    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-10/orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN
        },
        body: JSON.stringify(shopifyPayload)
      }
    );

    const data = await response.json();

    console.log('Shopify Status:', response.status);
    console.log(
      'Shopify Response:',
      JSON.stringify(data, null, 2)
    );

    if (!response.ok) {
      // Payment is already captured.
      // Do NOT ask the customer to pay again.

      session.status = 'paid_pending_shopify';

      return res.status(502).json({
        success: false,
        paymentCaptured: true,
        message: 'Payment successful but Shopify order creation failed. Please contact support.',
        error: data
      });
    }

    // Save successful Shopify order details.

    session.status = 'completed';
    session.shopifyOrderId = data.order.id;
    session.orderNumber = data.order.order_number;
    session.orderName = data.order.name;
    session.statusPageUrl = data.order.order_status_url;

    return res.status(200).json({
      success: true,
      order_id: data.order.id,
      order_number: data.order.order_number,
      order_name: data.order.name,
      statusPageUrl: data.order.order_status_url
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
      message: error.message || 'Payment verification failed'
    });
  }
});

// --------------------------------------------------
// PAYMENT FAILURE
// --------------------------------------------------

app.post('/payment-failure', (req, res) => {
  const { checkoutId, error } = req.body;

  const session = paymentSessions.get(checkoutId);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: 'Checkout session not found'
    });
  }

  // Do not overwrite a successful or captured payment.

  if (
    session.status !== 'completed' &&
    session.status !== 'paid_pending_shopify' &&
    session.status !== 'processing'
  ) {
    session.status = 'failed';
    session.failure = error || null;
  }

  return res.status(200).json({
    success: true,
    message: 'Payment failure recorded'
  });
});


export default checkout;


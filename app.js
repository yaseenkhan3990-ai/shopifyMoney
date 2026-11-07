import 'dotenv/config';
import express from 'express';
import connectDB from './config/connection.js';
import Wallet from './schema/wallet.js';
import Order from './schema/order.js';
import cors from 'cors';
import Razorpay from 'razorpay';
import crypto from "crypto";
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: 'https://sitara-style-2.myshopify.com' }));


app.use(express.json());
app.use(express.urlencoded({extended:true}));
const allowedOrigins = (process.env.FRONTEND_URL || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);



const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const parsePositiveAmount = (amount) => {
  const parsedAmount = Number(amount);

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return null;
  }

  return Number(parsedAmount.toFixed(2));
};

app.get('/', (req, res) => {
  res.json({
    message: 'MyMony Wallet API',
    endpoints: {
      addMoney: 'POST /wallet/add-money',
      checkBalance: 'GET /wallet/:email/balance',
      createOrder: 'POST /orders'
    }
  });
});

app.post('/wallet/add-money', async (req, res) => {
console.log(req.body.email);
  try {
    const email = normalizeEmail(req.body.email);
    const amount = parsePositiveAmount(req.body.amount);

    if (!email || !amount) {
      return res.status(400).json({
        message: 'Email and a positive amount are required.'
      });
    }

    const wallet = await Wallet.findOneAndUpdate(
      { email },
      { $inc: { balance: amount }, $setOnInsert: { email } },
      { new: true, upsert: true, runValidators: true }
    );

    return res.status(200).json({
      message: 'Money added successfully.',
      email: wallet.email,
      addedAmount: amount,
      balance: wallet.balance
    });

   }

   catch (error) {
    return res.status(500).json({
      message: 'Unable to add money.',
      error: error.message
    });

  }
});

app.get('/wallet/:email', async (req, res) => {
  console.log(req.params.email);

  try {
    const email = normalizeEmail(req.params.email);

    if (!email) {
      return res.status(400).json({
        message: 'Email is required.'
      });
    }

    const wallet = await Wallet.findOne({ email });

    if(!wallet) {
      return res.status(404).json({
        message: 'Wallet not found.',
        email,
        balance: 0
      });
    }

    return res.status(200).json({
      email: wallet.email,
      balance: wallet.balance
    });

  } catch (error) {
    return res.status(500).json({
      message: 'Unable to fetch balance.',
      error: error.message
    });
  }
});

app.post('/orders', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const amount = parsePositiveAmount(req.body.amount);
    const description = String(req.body.description || '').trim();

    if (!email || !amount) {
      return res.status(400).json({
        message: 'Email and a positive order amount are required.'
      });
    }

    const wallet = await Wallet.findOneAndUpdate(
      { email, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { new: true, runValidators: true }
    );

    if (!wallet) {
      const currentWallet = await Wallet.findOne({ email });

      return res.status(400).json({
        message: 'Insufficient balance or wallet not found.',
        email,
        balance: currentWallet?.balance || 0,
        orderAmount: amount
      });
    }

    const order = await Order.create({
      email,
      amount,
      description,
      balanceAfter: wallet.balance
    });

    return res.status(201).json({
      message: 'Order created and amount deducted successfully.',
      order: {
        id: order._id,
        email: order.email,
        amount: order.amount,
        description: order.description,
        createdAt: order.createdAt
      },
      updatedBalance: wallet.balance
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Unable to create order.',
      error: error.message
    });
  }
});


app.post('/create-order', async (req, res) => {
  let amountDeducted = false;
  let email;
  let total;

  try {
    const { customer, shipping_address, cart_items, total: orderTotal } = req.body;

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
    

    email = customer.email.trim().toLowerCase();
    total = Number(orderTotal);

    if (!total || total <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order total'
      });
    }

    //Deduct wallet balance

    const wallet = await Wallet.findOneAndUpdate(
      {
        email,
        balance: { $gte: total }
      },
      {
        $inc: { balance: -total }
      },
      {
        returnDocument: 'after'
      }
    );

    if (!wallet) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance'
      });
    }

    amountDeducted = true;

    // Prepare Shopify line items
    const line_items = cart_items.map(item => ({
      variant_id: Number(item.variant_id),
      quantity: Number(item.quantity || 1)
    }));

    console.log(line_items);
   

    const shopifyPayload = {
      order: {
        email,
        financial_status: 'paid',
        line_items,
        shipping_address: {
          first_name: shipping_address?.name || '',
          address1: shipping_address?.address || '',
          city: shipping_address?.city || '',
          zip: shipping_address?.pincode || '',
          phone: shipping_address?.phone || '',
          country: 'India'
        }
      }
    };

    console.log(
      'Shopify Payload:',
      JSON.stringify(shopifyPayload, null, 2)
    );

   
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

    console.log('Status:', response.status);
    console.log('Shopify Response:', JSON.stringify(data, null, 2));

    if (!response.ok) {
    
      await Wallet.findOneAndUpdate(
        { email },
        {
          $inc: { balance: total }
        },
        {
          returnDocument: 'after'
        }
      );

      return res.status(response.status).json({
        success: false,
        message: 'Shopify order creation failed',
        error: data
      });
    }

    return res.status(200).json({

      success: true,
      order_id: data.order.id,
      order_number: data.order.order_number,
      order_name: data.order.name,
      remaining_balance: wallet.balance

    });
     
  } catch (error) {
    console.error(error);

    // Refund if wallet was already deducted
    if (amountDeducted && email) {
      await Wallet.findOneAndUpdate(
        { email },
        {
          $inc: { balance: total }
        },
        {
          returnDocument: 'after'
        }
      );
    }

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});






const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// --------------------------------------------------
// TEMPORARY CHECKOUT STORAGE
// No MongoDB required.
// Data is lost when the server restarts.
// --------------------------------------------------

const checkouts = new Map();

const CHECKOUT_EXPIRY = 24 * 60 * 60 * 1000;

function cleanOldCheckouts() {
  const cutoff = Date.now() - CHECKOUT_EXPIRY;

  for (const [id, checkout] of checkouts.entries()) {
    if (
      checkout.createdAt < cutoff &&
      checkout.status !== "processing"
    ) {
      checkouts.delete(id);
    }
  }
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function parsePriceToPaise(price) {
  const value = String(price);

  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error("Invalid product price");
  }

  const [rupees, paise = ""] = value.split(".");
  return Number(rupees) * 100 + Number(paise.padEnd(2, "0"));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidId(value) {
  return /^\d+$/.test(String(value || ""));
}

function makeVariantGid(id) {
  return `gid://shopify/ProductVariant/${id}`;
}

function verifySignature(orderId, paymentId, signature) {
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest();

  let received;

  try {
    received = Buffer.from(signature, "hex");
  } catch {
    return false;
  }

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

// --------------------------------------------------
// SHOPIFY GRAPHQL HELPER
// --------------------------------------------------

async function shopifyGraphQL(query, variables = {}) {
  const url =
    `https://${SHOPIFY_STORE}/admin/api/2025-10/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const result = await response.json();

  if (!response.ok || result.errors?.length) {
    console.error("Shopify GraphQL error:", result.errors || result);
    throw new Error("Shopify API request failed");
  }

  return result.data;
}

// --------------------------------------------------
// GET VERIFIED SHOPIFY PRODUCT PRICES
// Never trust prices sent by the browser.
// --------------------------------------------------

async function getVerifiedCart(items) {
  const ids = items.map(item => {
    if (
      !isValidId(item.variantId) ||
      !isValidId(item.productId)
    ) {
      throw new Error("Invalid product or variant ID");
    }

    const quantity = Number(item.quantity);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 100
    ) {
      throw new Error("Invalid product quantity");
    }

    return makeVariantGid(item.variantId);
  });

  const query = `
    query GetCheckoutVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          legacyResourceId
          price
          availableForSale
          product {
            legacyResourceId
          }
        }
      }

      shop {
        name
        currencyCode
      }
    }
  `;

  const data = await shopifyGraphQL(query, { ids });

  if (data.shop.currencyCode !== "INR") {
    throw new Error("This checkout currently supports INR only");
  }

  const variants = new Map();

  for (const variant of data.nodes) {
    if (variant) {
      variants.set(
        String(variant.legacyResourceId),
        variant
      );
    }
  }

  let total = 0;
  const verifiedItems = [];

  for (const item of items) {
    const variant = variants.get(String(item.variantId));

    if (!variant) {
      throw new Error(`Variant ${item.variantId} not found`);
    }

    if (
      String(variant.product.legacyResourceId) !==
      String(item.productId)
    ) {
      throw new Error("Product and variant do not match");
    }

    if (!variant.availableForSale) {
      throw new Error("One or more products are unavailable");
    }

    const quantity = Number(item.quantity);
    const unitPrice = parsePriceToPaise(variant.price);

    total += unitPrice * quantity;

    verifiedItems.push({
      productId: String(item.productId),
      variantId: String(item.variantId),
      quantity
    });
  }

  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new Error("Invalid checkout amount");
  }

  return {
    amount: total,
    currency: "INR",
    storeName: data.shop.name,
    items: verifiedItems
  };
}

// --------------------------------------------------
// CREATE SHOPIFY ORDER AFTER PAYMENT
// --------------------------------------------------

async function createShopifyOrder(checkout) {
  const customer = checkout.customer;

  const transactionAmount = (checkout.amount / 100).toFixed(2);

  const mutation = `
    mutation CreatePaidOrder($order: OrderCreateOrderInput!) {
      orderCreate(order: $order) {
        order {
          id
          name
          displayFinancialStatus
          statusPageUrl
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const orderInput = {
    email: customer.email,
    phone: customer.phone || undefined,
    currency: "INR",
    financialStatus: "PAID",

    shippingAddress: {
      firstName: customer.firstName || "",
      lastName: customer.lastName || "",
      address1: customer.address.address1,
      address2: customer.address.address2 || "",
      city: customer.address.city,
      province: customer.address.province || "",
      zip: customer.address.postalCode,
      countryCode: "IN",
      phone: customer.phone || undefined
    },

    lineItems: checkout.items.map(item => ({
      variantId: makeVariantGid(item.variantId),
      quantity: item.quantity
    })),

    note: [
      customer.note || "",
      `Razorpay Payment ID: ${checkout.paymentId}`,
      `Checkout ID: ${checkout.checkoutId}`
    ].filter(Boolean).join("\n"),

    tags: ["Razorpay", "Online Payment"],

    transactions: [
      {
        kind: "SALE",
        status: "SUCCESS",
        gateway: "Razorpay",
        amountSet: {
          shopMoney: {
            amount: transactionAmount,
            currencyCode: "INR"
          },
          presentmentMoney: {
            amount: transactionAmount,
            currencyCode: "INR"
          }
        }
      }
    ]
  };

  const data = await shopifyGraphQL(mutation, {
    order: orderInput
  });

  const result = data.orderCreate;

  if (result.userErrors?.length) {
    console.error("Shopify order errors:", result.userErrors);
    throw new Error(
      result.userErrors.map(error => error.message).join(", ")
    );
  }

  if (!result.order) {
    throw new Error("Shopify did not return an order");
  }

  return result.order;
}

// --------------------------------------------------
// SERVICE STATUS
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Shopify Razorpay payment server is running",
    endpoints: [
      "POST /api/payments/create-order",
      "POST /api/payments/verify",
      "POST /api/payments/failure"
    ]
  });
});

// --------------------------------------------------
// CREATE RAZORPAY ORDER
// POST /api/payments/create-order
// --------------------------------------------------

app.post("/api/payments/create-order", async (req, res) => {
  try {
    cleanOldCheckouts();

    const { shop, customer, items } = req.body;

    if (
      String(shop || "").toLowerCase() !== SHOPIFY_STORE
    ) {
      return res.status(403).json({
        success: false,
        message: "Invalid Shopify store"
      });
    }

    if (!customer || !customer.email || !isValidEmail(customer.email)) {
      return res.status(400).json({
        success: false,
        message: "Valid customer email is required"
      });
    }

    if (
      !customer.address ||
      !customer.address.address1 ||
      !customer.address.city ||
      !customer.address.postalCode
    ) {
      return res.status(400).json({
        success: false,
        message: "Complete shipping address is required"
      });
    }

    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > 50
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid cart items"
      });
    }

    // Get actual prices from Shopify.
    const cart = await getVerifiedCart(items);

    const checkoutId = crypto.randomUUID();

    // Create Razorpay order.
    const razorpayOrder = await razorpay.orders.create({
      amount: cart.amount,
      currency: cart.currency,
      receipt: checkoutId.slice(0, 40),
      notes: {
        checkoutId,
        shop: SHOPIFY_STORE
      }
    });

    const checkout = {
      checkoutId,
      shop: SHOPIFY_STORE,
      customer,
      items: cart.items,
      amount: cart.amount,
      currency: cart.currency,
      storeName: cart.storeName,
      razorpayOrderId: razorpayOrder.id,
      paymentId: null,
      status: "created",
      createdAt: Date.now(),
      processingAt: null,
      shopifyOrderId: null,
      orderName: null,
      statusPageUrl: null
    };

    checkouts.set(checkoutId, checkout);

    return res.json({
      success: true,
      checkoutId,
      razorpayOrderId: razorpayOrder.id,
      amount: cart.amount,
      currency: cart.currency,
      storeName: cart.storeName
    });

  } catch (error) {
    console.error("Create order error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Could not create payment order"
    });
  }
});

// --------------------------------------------------
// VERIFY RAZORPAY PAYMENT AND CREATE SHOPIFY ORDER
// POST /api/payments/verify
// --------------------------------------------------

app.post("/api/payments/verify", async (req, res) => {
  let checkout;

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
        message: "Missing payment verification details"
      });
    }

    checkout = checkouts.get(checkoutId);

    if (!checkout) {
      return res.status(404).json({
        success: false,
        message: "Checkout not found. Please contact support."
      });
    }

    // Idempotency: do not create the order twice.
    if (checkout.status === "completed") {
      return res.json({
        success: true,
        orderName: checkout.orderName,
        shopifyOrderId: checkout.shopifyOrderId,
        financialStatus: "PAID",
        statusPageUrl: checkout.statusPageUrl
      });
    }

    if (checkout.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({
        success: false,
        message: "Razorpay order ID mismatch"
      });
    }

    // Verify Razorpay signature.
    if (
      !verifySignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment signature"
      });
    }

    if (
      checkout.status === "processing" &&
      Date.now() - checkout.processingAt < 120000
    ) {
      return res.status(409).json({
        success: false,
        message: "Payment verification is already processing"
      });
    }

    checkout.status = "processing";
    checkout.processingAt = Date.now();
    checkout.paymentId = razorpay_payment_id;

    // Independently verify payment with Razorpay.
    const payment = await razorpay.payments.fetch(
      razorpay_payment_id
    );

    if (
      payment.order_id !== checkout.razorpayOrderId ||
      Number(payment.amount) !== checkout.amount ||
      payment.currency !== checkout.currency
    ) {
      checkout.status = "failed";

      return res.status(400).json({
        success: false,
        message: "Payment details do not match the checkout"
      });
    }

    // Capture an authorized payment.
    let verifiedPayment = payment;

    if (payment.status === "authorized") {
      verifiedPayment = await razorpay.payments.capture(
        razorpay_payment_id,
        checkout.amount,
        checkout.currency
      );
    }

    if (verifiedPayment.status !== "captured") {
      checkout.status = "failed";

      return res.status(400).json({
        success: false,
        message: "Payment has not been captured"
      });
    }

    // Payment is captured. Now create the Shopify order.
    checkout.status = "paid_pending_shopify";

    const shopifyOrder = await createShopifyOrder(checkout);

    checkout.status = "completed";
    checkout.shopifyOrderId = shopifyOrder.id;
    checkout.orderName = shopifyOrder.name;
    checkout.statusPageUrl = shopifyOrder.statusPageUrl;

    return res.json({
      success: true,
      orderName: shopifyOrder.name,
      shopifyOrderId: shopifyOrder.id,
      financialStatus: shopifyOrder.displayFinancialStatus,
      statusPageUrl: shopifyOrder.statusPageUrl
    });

  } catch (error) {
    console.error("Payment verification error:", error);

    if (checkout && checkout.paymentId) {
      checkout.status = "paid_pending_shopify";

      return res.status(502).json({
        success: false,
        paymentCaptured: true,
        message:
          "Payment was received, but Shopify order creation failed. Please contact support. Do not pay again."
      });
    }

    if (checkout) {
      checkout.status = "failed";
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Payment verification failed"
    });
  }
});

// --------------------------------------------------
// PAYMENT FAILURE CALLBACK
// POST /api/payments/failure
// --------------------------------------------------

app.post("/api/payments/failure", (req, res) => {
  const { checkoutId, error } = req.body;

  const checkout = checkouts.get(checkoutId);

  if (!checkout) {
    return res.status(404).json({
      success: false,
      message: "Checkout not found"
    });
  }

  // Never mark an already paid checkout as failed.
  if (
    checkout.status !== "completed" &&
    checkout.status !== "paid_pending_shopify" &&
    checkout.status !== "processing"
  ) {
    checkout.status = "failed";
    checkout.failure = error || null;
  }

  return res.json({
    success: true,
    message: "Payment failure recorded"
  });
});







const startServer = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();


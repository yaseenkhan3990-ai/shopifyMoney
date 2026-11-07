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

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        callback(new Error("Origin not allowed"));
    }
}));

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

// Temporary checkout storage (NO DATABASE)
const checkouts = new Map();

// Expire unfinished checkouts after 30 minutes
setInterval(() => {
    const now = Date.now();

    for (const [id, checkout] of checkouts) {
        if (now - checkout.createdAt > 30 * 60 * 1000) {
            checkouts.delete(id);
        }
    }
}, 5 * 60 * 1000).unref();

// ================================
// SHOPIFY GRAPHQL
// ================================

async function shopifyGraphQL(query, variables = {}) {

    const response = await fetch(
        `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token":
                    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
            },
            body: JSON.stringify({
                query,
                variables
            })
        }
    );

    const result = await response.json();

   if (!response.ok || result.errors) {
    console.error("Shopify error:", result);
    throw new Error("Shopify API request failed");
}

    return result.data;
}

// ================================
// GET VERIFIED SHOPIFY PRICES
// ================================

async function getProducts(items) {

    const query = `
        query GetVariants($ids: [ID!]!) {
            nodes(ids: $ids) {
                ... on ProductVariant {
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

    const ids = items.map(item =>
        `gid://shopify/ProductVariant/${item.variantId}`
    );

    const data = await shopifyGraphQL(query, { ids });

    if (data.shop.currencyCode !== "INR") {
        throw new Error("Only INR payments are supported");
    }

    const variants = new Map();

    data.nodes.forEach(variant => {
        if (variant) {
            variants.set(
                String(variant.legacyResourceId),
                variant
            );
        }
    });

    let total = 0;

    const verifiedItems = items.map(item => {

        const variant = variants.get(String(item.variantId));

        if (
            !variant ||
            !variant.availableForSale ||
            String(variant.product.legacyResourceId) !==
                String(item.productId)
        ) {
            throw new Error("Invalid or unavailable product");
        }

        const match = String(variant.price).match(
            /^(\d+)(?:\.(\d{1,2}))?$/
        );

        if (!match) {
            throw new Error("Invalid product price");
        }

        const price =
            Number(match[1]) * 100 +
            Number((match[2] || "").padEnd(2, "0"));

        total += price * item.quantity;

        return {
            productId: String(item.productId),
            variantId: String(item.variantId),
            quantity: item.quantity
        };
    });

    if (!Number.isSafeInteger(total) || total <= 0) {
        throw new Error("Invalid payment amount");
    }

    return {
        total,
        items: verifiedItems,
        storeName: data.shop.name
    };
}

// ================================
// CREATE SHOPIFY ORDER
// ================================

async function createShopifyOrder(checkout) {

    const mutation = `
        mutation CreateOrder($order: OrderCreateOrderInput!) {
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

    const customer = checkout.customer;
    const address = customer.address;

    const orderInput = {

        email: customer.email,
        phone: customer.phone,

        financialStatus: "PAID",

        currency: "INR",

        shippingAddress: {
            firstName: customer.firstName,
            lastName: customer.lastName,
            address1: address.address1,
            address2: address.address2 || "",
            city: address.city,
            province: address.province || "",
            zip: address.postalCode,
            countryCode: "IN",
            phone: customer.phone
        },

        lineItems: checkout.items.map(item => ({
            variantId:
                `gid://shopify/ProductVariant/${item.variantId}`,
            quantity: item.quantity
        })),

        note: [
            customer.note || "",
            `Razorpay Payment ID: ${checkout.paymentId}`,
            `Checkout ID: ${checkout.checkoutId}`
        ].filter(Boolean).join("\n"),

        tags: ["Razorpay", "Online Payment"]
    };

    const data = await shopifyGraphQL(
        mutation,
        { order: orderInput }
    );

    const result = data.orderCreate;

    if (result.userErrors.length) {
        throw new Error(
            result.userErrors.map(e => e.message).join(", ")
        );
    }

    if (!result.order) {
        throw new Error("Shopify order creation failed");
    }

    return result.order;
}

// ================================
// API 1: RECEIVE CART + CREATE PAYMENT
// POST /api/payments/create-order
// ================================

app.post("/api/payments/create-order", async (req, res) => {

    try {

        const { shop, customer, items } = req.body;

        if (shop !== process.env.SHOPIFY_STORE_DOMAIN) {
            return res.status(403).json({
                message: "Invalid store"
            });
        }

        if (
            !customer ||
            !customer.firstName ||
            !customer.lastName ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email || "") ||
            !customer.phone ||
            !customer.address?.address1 ||
            !customer.address?.city ||
            !customer.address?.postalCode
        ) {
            return res.status(400).json({
                message: "Invalid customer details"
            });
        }

        // if (
        //     typeof cartToken !== "string" ||
        //     !cartToken ||
        //     cartToken.length > 512
        // ) {
        //     return res.status(400).json({
        //         message: "Invalid cart token"
        //     });
        // }

        if (
            !Array.isArray(items) ||
            items.length === 0 ||
            items.length > 50
        ) {
            return res.status(400).json({
                message: "Cart is empty"
            });
        }

        for (const item of items) {

            if (
                !/^\d+$/.test(String(item.productId)) ||
                !/^\d+$/.test(String(item.variantId)) ||
                !Number.isSafeInteger(item.quantity) ||
                item.quantity < 1 ||
                item.quantity > 100
            ) {
                return res.status(400).json({
                    message: "Invalid cart item"
                });
            }
        }

        // Get actual Shopify prices
        const verified = await getProducts(items);

        // Create checkout ID
        const checkoutId = crypto.randomUUID();

        // Create Razorpay order
        const razorpayOrder = await razorpay.orders.create({

            amount: verified.total,
            currency: "INR",

            receipt: checkoutId.replace(/-/g, "").slice(0, 40),

            notes: {
                checkoutId,
                shop
            }
        });

        // Store temporarily in server memory
        checkouts.set(checkoutId, {

            checkoutId,
            shop,
            customer,

            items: verified.items,

            amount: verified.total,
            currency: "INR",

            razorpayOrderId: razorpayOrder.id,

            createdAt: Date.now(),

            status: "created"

        });

        return res.status(201).json({

            success: true,

            checkoutId,

            razorpayOrderId: razorpayOrder.id,

            amount: verified.total,

            currency: "INR",

            storeName: verified.storeName

        });

    } catch (error) {

        console.error(error);

        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// ================================
// API 2: VERIFY PAYMENT + CREATE SHOPIFY ORDER
// POST /api/payments/verify
// ================================

app.post("/api/payments/verify", async (req, res) => {

    try {

        const {
            checkoutId,
            razorpay_payment_id,
            razorpay_order_id,
            razorpay_signature
        } = req.body;

        const checkout = checkouts.get(checkoutId);

        if (!checkout) {
            return res.status(404).json({
                message: "Checkout expired or not found"
            });
        }

        if (checkout.status === "processing") {
            return res.status(409).json({
                message: "Order is already processing"
            });
        }

        if (
            checkout.razorpayOrderId !== razorpay_order_id ||
            !razorpay_payment_id ||
            !razorpay_signature
        ) {
            return res.status(400).json({
                message: "Invalid payment details"
            });
        }

        // Verify signature
        const expected = crypto
            .createHmac(
                "sha256",
                process.env.RAZORPAY_KEY_SECRET
            )
            .update(
                `${razorpay_order_id}|${razorpay_payment_id}`
            )
            .digest();

        const received = Buffer.from(
            razorpay_signature,
            "hex"
        );

        if (
            received.length !== expected.length ||
            !crypto.timingSafeEqual(expected, received)
        ) {
            return res.status(400).json({
                message: "Invalid payment signature"
            });
        }

        // Verify directly with Razorpay
        let payment = await razorpay.payments.fetch(
            razorpay_payment_id
        );

        if (
            payment.order_id !== checkout.razorpayOrderId ||
            payment.amount !== checkout.amount ||
            payment.currency !== checkout.currency
        ) {
            return res.status(400).json({
                message: "Payment details mismatch"
            });
        }

        // Capture payment if authorized
        if (payment.status === "authorized") {

            await razorpay.payments.capture(
                razorpay_payment_id,
                checkout.amount,
                checkout.currency
            );

            payment = await razorpay.payments.fetch(
                razorpay_payment_id
            );
        }

        if (payment.status !== "captured") {
            return res.status(409).json({
                message: "Payment is not captured"
            });
        }

        // Prevent duplicate processing
        checkout.status = "processing";
        checkout.paymentId = razorpay_payment_id;

        try {

            // Create actual Shopify order
            const shopifyOrder = await createShopifyOrder(checkout);

            checkout.status = "completed";
            checkout.shopifyOrderId = shopifyOrder.id;
            checkout.orderName = shopifyOrder.name;

            return res.json({

                success: true,

                message: "Payment successful. Shopify order created.",

                orderName: shopifyOrder.name,

                shopifyOrderId: shopifyOrder.id,

                financialStatus:
                    shopifyOrder.displayFinancialStatus,

                statusPageUrl: shopifyOrder.statusPageUrl

            });

        } catch (error) {

            // Keep checkout for manual/retry recovery
            checkout.status = "paid_pending_shopify";

            console.error("Shopify order error:", error);

            return res.status(502).json({

                success: false,

                paymentCaptured: true,

                message:
                    "Payment received, but Shopify order creation failed. Please contact support. Do not pay again."

            });
        }

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Payment verification failed"
        });
    }
});

// ================================
// API 3: PAYMENT FAILURE
// POST /api/payments/failure
// ================================

app.post("/api/payments/failure", async (req, res) => {

    const { checkoutId, error } = req.body;

    const checkout = checkouts.get(checkoutId);

    if (!checkout) {
        return res.status(404).json({
            message: "Checkout not found"
        });
    }

    if (
        checkout.status === "completed" ||
        checkout.status === "paid_pending_shopify"
    ) {
        return res.status(409).json({
            message: "Payment already received"
        });
    }

    checkout.status = "failed";

    checkout.failure = {
        code: error?.code,
        description: error?.description,
        reason: error?.reason
    };

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


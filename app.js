import 'dotenv/config';
import express from 'express';
import connectDB from './config/connection.js';
import Wallet from './schema/wallet.js';
import Order from './schema/order.js';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: 'https://sitara-style-2.myshopify.com' }));


app.use(express.json());

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
  } catch (error) {
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
  let wallet = null;
  let amountDeducted = false;
  let email = null;
  let total = 0;

  try {
    const {
      customer,
      shipping_address,
      cart_items,
      total: orderTotal
    } = req.body;


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

    total = Number(orderTotal);

    if (isNaN(total) || total <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order total'
      });
    }

    email = customer.email.trim().toLowerCase();

    
    wallet = await Wallet.findOneAndUpdate(
      {
        email,
        balance: { $gte: total }
      },
      {
        $inc: { balance: -total }
      },
      {
        new: true
      }
    );

    if (!wallet) {
      return res.status(400).json({
        success: false,
        message: 'Wallet not found or insufficient balance'
      });
    }

    amountDeducted = true;

    const line_items = cart_items.map(item => {
      if(!item.variant_id) {
        throw new Error(
          `Missing variant_id for product ${item.title || ''}`
        );
      }

      return {
        variant_id: Number(item.variant_id),
        quantity: Number(item.quantity || 1)
      };
    });


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

    console.log('SHOPIFY PAYLOAD');
    console.log(JSON.stringify(shopifyPayload, null, 2));

 
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 30000);

  
    
    console.log('SHOPIFY URL:', shopifyUrl);

    const response = await fetch(`https://${process.env.SHOPIFY_STORE}` +
      `/admin/api/2026-01/orders.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token':
          process.env.SHOPIFY_ADMIN_TOKEN
      },
      body: JSON.stringify(shopifyPayload),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const rawResponse = await response.text();

    console.log('SHOPIFY STATUS:', response.status);
    console.log('SHOPIFY RESPONSE:', rawResponse);

    let data = {};

    try {
      data = rawResponse
        ? JSON.parse(rawResponse)
        : {};
    } catch (parseError) {
      throw new Error(
        `Shopify returned invalid JSON. Status=${response.status}. Body=${rawResponse}`
      );
    }

    if (!response.ok) {
      if (amountDeducted) {
        await Wallet.findOneAndUpdate(
          { email },
          { $inc: { balance: total } }
        );

        amountDeducted = false;
      }

      return res.status(response.status).json({
        success: false,
        message: 'Shopify order creation failed',
        shopify_status: response.status,
        shopify_error: data
      });
    }

    // --------------------------------------------------
    // SUCCESS
    // --------------------------------------------------

    return res.status(200).json({
      success: true,
      order_id: data?.order?.id,
      order_number: data?.order?.order_number,
      order_name: data?.order?.name,
      remaining_balance: wallet.balance
    });

  } catch (error) {
    console.error('================ ERROR ================');
    console.error(error);
    console.error(error.stack);

    // Refund only if still deducted

    if (amountDeducted && email) {
      try {
        await Wallet.findOneAndUpdate(
          { email },
          { $inc: { balance: Number(total) } }
        );

        console.log(
          `Wallet refunded: ${email} amount=${total}`
        );
      } catch (refundError) {
        console.error('REFUND ERROR');
        console.error(refundError);
      }
    }

    return res.status(500).json({
      success: false,
      message: 'Internal Server Error',
      error: error.message
    });
  }
});
const startServer = async () => {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();


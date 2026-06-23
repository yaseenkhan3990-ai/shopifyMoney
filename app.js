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
  try {
    const {
      customer,
      shipping_address,
      cart_items,
      total
    } = req.body;
  
   
    // if (!cart_items || !cart_items.length) {
    //   return res.status(400).json({
    //     success: false,
    //     message: 'Cart is empty'
    //   });
    // }
    console.log(cart_items)

  
    const wallet = await Wallet.findOne({
      email: customer.email.toLowerCase()
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found'
      });
    }

    // Check balance
    if (wallet.balance < total) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance',
        balance: wallet.balance,
        required: total
      });
    }

    // Deduct amount
    wallet.balance -= total;
    await wallet.save();

    const line_items = cart_items.map(item => ({
      variant_id: item.variant_id,
      quantity: item.quantity
    }));

    const shopifyPayload = {
      order: {
        email: customer.email,
        financial_status: 'paid',
        line_items,
        shipping_address: {
          first_name: shipping_address.name,
          address1: shipping_address.address,
          city: shipping_address.city,
          zip: shipping_address.pincode,
          phone: shipping_address.phone,
          country: 'India'
        }
      }
    };

    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-10/orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token':
            process.env.SHOPIFY_ADMIN_TOKEN
        },
        body: JSON.stringify(shopifyPayload)
      }
    );

    const data = await response.json();

    if (!response.ok) {

      // Refund wallet if Shopify order fails
      wallet.balance += total;
      await wallet.save();

      return res.status(response.status).json({
        success: false,
        shopify: data
      });
    }

    res.json({
      success: true,
      order_id: data.order.id,
      order_number: data.order.order_number,
      order_name: data.order.name,
      remaining_balance: wallet.balance
    });

  } catch (error) {
    console.error(error);

  try {

    const {
      customer,
      shipping_address,
      cart_items
    } = req.body;

    if (!cart_items || !cart_items.length) {
      return res.status(400).json({
        success: false,
        message: 'Cart is empty'
      });
    }

  try {

    const {
      customer,
      shipping_address,
      cart_items
    } = req.body;

    if (!cart_items || !cart_items.length) {
      return res.status(400).json({
        success: false,
        message: 'Cart is empty'
      });
    }

    const line_items = cart_items.map(item => ({
      variant_id: item.variant_id,
      quantity: item.quantity
    }));

    const shopifyPayload = {
      order: {
        email: customer.email,

        financial_status: 'pending',

        line_items,

        shipping_address: {
          first_name: shipping_address.name,
          address1: shipping_address.address,
          city: shipping_address.city,
          zip: shipping_address.pincode,
          phone: shipping_address.phone,
          country: 'India'
        }
      }
    };

    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-10/orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token':
            process.env.SHOPIFY_ADMIN_TOKEN
        },
        body: JSON.stringify(shopifyPayload)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        shopify: data
      });
    }

    res.json({
      success: true,
      order_id: data.order.id,
      order_number: data.order.order_number,
      order_name: data.order.name
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message
    });

  }

    const line_items = cart_items.map(item => ({
      variant_id: item.variant_id,
      quantity: item.quantity
    }));

    const shopifyPayload = {
      order: {
        email: customer.email,

        financial_status: 'pending',

        line_items,

        shipping_address: {
          first_name: shipping_address.name,
          address1: shipping_address.address,
          city: shipping_address.city,
          zip: shipping_address.pincode,
          phone: shipping_address.phone,
          country: 'India'
        }
      }
    };

    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-10/orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token':
            process.env.SHOPIFY_ADMIN_TOKEN
        },
        body: JSON.stringify(shopifyPayload)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        shopify: data
      });
    }

    res.json({
      success: true,
      order_id: data.order.id,
      order_number: data.order.order_number,
      order_name: data.order.name
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message
    });

  }

    res.status(500).json({
      success: false,
      message: error.message
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


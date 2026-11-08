import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import connectDB from './config/connection.js';
import checkoutRouter from './middleware/checkout.js';
import walletRouter from './middleware/wallet.js';

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.FRONTEND_URL ||
  'https://sitara-style-2.myshopify.com')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({
    message: 'MyMony Wallet API',
    endpoints: {
      addMoney: 'POST /wallet/add-money',
      checkBalance: 'GET /wallet/:email',
      createOrder: 'POST /orders',
      checkout: 'POST /checkout/create-order'
    }
  });
});

app.use('/checkout', checkoutRouter);
app.use(walletRouter);

const startServer = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();

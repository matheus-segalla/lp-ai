const express = require('express');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');

// 1. Carrega variáveis de ambiente (.env.local tem prioridade, com fallback para .env)
dotenv.config({ path: path.join(__dirname, '.env.local') });
dotenv.config({ path: path.join(__dirname, '.env') });

const { saveOrder, getOrderBySessionId } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Inicializa a SDK do Stripe
const Stripe = require('stripe');
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const isStripeConfigured = stripeSecretKey && !stripeSecretKey.includes('substitua');
const stripe = isStripeConfigured ? new Stripe(stripeSecretKey) : null;

// Habilita CORS
app.use(cors());

// =========================================================================
// ROTA 4: WEBHOOK DO STRIPE (checkout.session.completed)
// IMPORTANTE: Esta rota DEVE usar express.raw() ANTES do express.json()
// para que a assinatura criptográfica (stripe-signature) seja validada.
// =========================================================================
app.post(
  '/api/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      if (stripe && webhookSecret && !webhookSecret.includes('substitua')) {
        // Validação criptográfica oficial da assinatura do Stripe
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } else {
        // Modo fallback para desenvolvimento caso webhook secret ainda não esteja definido
        console.warn('⚠️ STRIPE_WEBHOOK_SECRET não configurado. Parseando payload sem validação criptográfica (modo desenvolvimento).');
        event = JSON.parse(req.body.toString('utf8'));
      }
    } catch (err) {
      console.error(`❌ Falha na validação da assinatura do Webhook: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Processa o evento 'checkout.session.completed'
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log(`🔔 Evento recebido: checkout.session.completed para sessão [${session.id}]`);

      try {
        // Salva os dados do comprador e do pedido no banco de dados SQLite
        const savedRecord = await saveOrder({
          sessionId: session.id,
          customerEmail: session.customer_details?.email || session.customer_email,
          customerName: session.customer_details?.name,
          amountTotal: session.amount_total,
          currency: session.currency,
          paymentStatus: session.payment_status,
          paymentIntent: session.payment_intent,
          productId: process.env.STRIPE_PRODUCT_ID || 'prod_VNxJqXKSD1q1D9',
          priceId: process.env.STRIPE_PRICE_ID || 'price_1UNBPHJ8GWZznJJJCaeFtQAs'
        });

        console.log(`💾 Comprador registrado no banco: ${savedRecord.customerEmail} (Valor: $${(savedRecord.amountTotal / 100).toFixed(2)})`);
      } catch (dbError) {
        console.error('❌ Erro ao persistir pedido no banco de dados:', dbError.message);
      }
    } else {
      console.log(`ℹ️ Evento Stripe ignorado: ${event.type}`);
    }

    // Responde ao Stripe com 200 OK para confirmar o recebimento
    res.status(200).json({ received: true });
  }
);

// Habilita parsing de JSON para as demais rotas da API
app.use(express.json());

// =========================================================================
// ROTA 1: CRIAR STRIPE CHECKOUT SESSION (POST /api/create-checkout-session)
// Requisitos atendidos:
// - Product ID: prod_VNxJqXKSD1q1D9
// - Price ID: price_1UNBPHJ8GWZznJJJCaeFtQAs
// - Modo: Pagamento único (US$ 19,90) -> mode: 'payment'
// - E-mail digitado direto na página do Stripe (sem customer_email prévio)
// - Sucesso: /sucesso?session_id={CHECKOUT_SESSION_ID}
// - Cancelamento: /
// =========================================================================
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: 'STRIPE_SECRET_KEY não foi configurada. Preencha sua chave secreta no arquivo .env.local.'
      });
    }

    const domain = process.env.DOMAIN || `http://localhost:${PORT}`;
    const priceId = process.env.STRIPE_PRICE_ID || 'price_1UNBPHJ8GWZznJJJCaeFtQAs';

    // Criação da sessão de checkout no Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      mode: 'payment', // Pagamento único (US$ 19,90)
      // O e-mail NÃO é passado aqui, garantindo que o cliente digite diretamente no Stripe
      success_url: `${domain}/sucesso?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domain}/`,
      billing_address_collection: 'auto'
    });

    console.log(`🛒 Sessão de checkout criada: ${session.id} -> Redirecionando para ${session.url}`);
    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('❌ Erro ao criar Stripe Checkout Session:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// =========================================================================
// ROTA AUXILIAR: CONSULTAR DETALHES DA SESSÃO (/api/checkout-session/:id)
// Usada pela página de sucesso para exibir os dados da compra
// =========================================================================
app.get('/api/checkout-session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Tenta buscar no banco primeiro
    const localOrder = await getOrderBySessionId(sessionId).catch(() => null);

    if (stripe) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      return res.json({
        id: session.id,
        customerEmail: session.customer_details?.email,
        customerName: session.customer_details?.name,
        amountTotal: session.amount_total,
        currency: session.currency,
        paymentStatus: session.payment_status
      });
    }

    if (localOrder) {
      return res.json(localOrder);
    }

    res.status(404).json({ error: 'Sessão não encontrada.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// PÁGINA DE SUCESSO (/sucesso)
// =========================================================================
app.get('/sucesso', (req, res) => {
  res.sendFile(path.join(__dirname, 'sucesso.html'));
});

// =========================================================================
// ARQUIVOS ESTÁTICOS (Landing page index.html, scripts, assets)
// =========================================================================
app.use(express.static(__dirname));

// Fallback para SPA / index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Inicia o servidor local se executado diretamente
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`
🚀 Servidor Stripe ativo em: http://localhost:${PORT}
👉 API Checkout: http://localhost:${PORT}/api/create-checkout-session
👉 Webhook URL: http://localhost:${PORT}/api/webhook
👉 Página Sucesso: http://localhost:${PORT}/sucesso
    `);
  });
}

module.exports = app;

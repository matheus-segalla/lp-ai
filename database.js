const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const os = require('os');
const isServerless = process.env.VERCEL === '1' || process.env.VERCEL === 'true' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const dbPath = isServerless ? path.join(os.tmpdir(), 'orders.db') : path.join(__dirname, 'orders.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Erro ao conectar ao banco SQLite:', err.message);
  } else {
    console.log(`📦 Conectado ao banco de dados SQLite (${dbPath})`);
  }
});

// Inicializa a tabela de pedidos
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      customer_email TEXT,
      customer_name TEXT,
      amount_total INTEGER,
      currency TEXT,
      payment_status TEXT,
      payment_intent TEXT,
      product_id TEXT,
      price_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('❌ Erro ao criar tabela orders:', err.message);
    } else {
      console.log('✅ Tabela "orders" pronta para registrar transações.');
    }
  });
});

/**
 * Salva ou atualiza um pedido no banco de dados
 */
function saveOrder(orderData) {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO orders (
        session_id, customer_email, customer_name, 
        amount_total, currency, payment_status, 
        payment_intent, product_id, price_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        payment_status = excluded.payment_status,
        customer_email = excluded.customer_email,
        customer_name = excluded.customer_name
    `;

    const params = [
      orderData.sessionId,
      orderData.customerEmail || null,
      orderData.customerName || null,
      orderData.amountTotal || null,
      orderData.currency || 'usd',
      orderData.paymentStatus || 'paid',
      orderData.paymentIntent || null,
      orderData.productId || null,
      orderData.priceId || null
    ];

    db.run(query, params, function (err) {
      if (err) {
        console.error('❌ Erro ao salvar pedido:', err.message);
        return reject(err);
      }
      console.log(`🎉 Pedido salvo com sucesso! ID do registro: ${this.lastID}, Sessão: ${orderData.sessionId}`);
      resolve({ id: this.lastID, ...orderData });
    });
  });
}

/**
 * Busca um pedido por session_id
 */
function getOrderBySessionId(sessionId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM orders WHERE session_id = ?', [sessionId], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

module.exports = {
  db,
  saveOrder,
  getOrderBySessionId
};

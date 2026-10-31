const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'nexus_cyber_secret_key_2026';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        login VARCHAR(50) UNIQUE NOT NULL,
        senha VARCHAR(255) NOT NULL,
        cargo VARCHAR(20) NOT NULL CHECK (cargo IN ('COBRADOR', 'SUPERVISOR', 'ADMIN'))
      );

      CREATE TABLE IF NOT EXISTS cob_clientes (
        id SERIAL PRIMARY KEY,
        contrato VARCHAR(50) UNIQUE NOT NULL,
        nome VARCHAR(100) NOT NULL,
        telefone VARCHAR(20),
        valor_devedor NUMERIC(10,2) NOT NULL,
        faixa_atraso VARCHAR(20) NOT NULL,
        estagio VARCHAR(50) DEFAULT 'Novos Contatos'
      );

      CREATE TABLE IF NOT EXISTS cob_agenda (
        id SERIAL PRIMARY KEY,
        cliente_id INT REFERENCES cob_clientes(id) ON DELETE CASCADE,
        titulo VARCHAR(150) NOT NULL,
        data_agendamento TIMESTAMP NOT NULL,
        concluido BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS pos_planos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        valor NUMERIC(10,2) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pos_clientes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        telefone VARCHAR(20),
        plano_id INT REFERENCES pos_planos(id) ON DELETE SET NULL,
        valor_mensal NUMERIC(10,2) NOT NULL,
        estagio VARCHAR(50) DEFAULT 'Venda Instalada',
        satisfacao_nps INT DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS pos_upgrades (
        id SERIAL PRIMARY KEY,
        cliente_id VARCHAR(50) NOT NULL,
        nome VARCHAR(100) NOT NULL,
        plano_atual VARCHAR(100) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pos_vendas_ativas (
        id SERIAL PRIMARY KEY,
        cliente_id VARCHAR(50) NOT NULL,
        nome VARCHAR(100) NOT NULL,
        telefone VARCHAR(20) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS acordos_pagos (
        id SERIAL PRIMARY KEY,
        operador_id INT REFERENCES usuarios(id),
        valor NUMERIC(10,2) NOT NULL,
        data_pagamento TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS vendas_realizadas (
        id SERIAL PRIMARY KEY,
        operador_id INT REFERENCES usuarios(id),
        valor NUMERIC(10,2) NOT NULL,
        data_venda TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const res = await pool.query("SELECT * FROM usuarios WHERE login = 'admin'");
    if (res.rows.length === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      await pool.query(
        "INSERT INTO usuarios (nome, login, senha, cargo) VALUES ('Admin Nexus', 'admin', $1, 'ADMIN')",
        [hash]
      );
      console.log('✅ Usuário Admin padrão criado: admin / admin123');
    }
  } catch (err) {
    console.error('❌ Erro na inicialização do DB:', err);
  }
}
initDB();

function authMiddleware(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Acesso Negado' });
  try {
    const verified = jwt.verify(token.replace('Bearer ', ''), JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ error: 'Token Inválido' });
  }
}

app.post('/api/auth/login', async (req, res) => {
  const { login, senha } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE login = $1', [login]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Usuário não encontrado' });

    const user = result.rows[0];
    const validPass = await bcrypt.compare(senha, user.senha);
    if (!validPass) return res.status(400).json({ error: 'Senha incorreta' });

    const token = jwt.sign({ id: user.id, cargo: user.cargo, nome: user.nome }, JWT_SECRET);
    res.json({ token, user: { id: user.id, nome: user.nome, login: user.login, cargo: user.cargo } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const carteira = await pool.query('SELECT COUNT(*), COALESCE(SUM(valor_devedor), 0) as total FROM cob_clientes');
    const vendasAtivas = await pool.query('SELECT COUNT(*) FROM pos_vendas_ativas');
    const upgrades = await pool.query('SELECT COUNT(*) FROM pos_upgrades');

    const rankingAcordos = await pool.query(`
      SELECT u.nome, COALESCE(SUM(a.valor), 0) as total 
      FROM usuarios u 
      LEFT JOIN acordos_pagos a ON u.id = a.operador_id 
      GROUP BY u.id ORDER BY total DESC
    `);

    const rankingVendas = await pool.query(`
      SELECT u.nome, COUNT(v.id) as qtd, COALESCE(SUM(v.valor), 0) as total 
      FROM usuarios u 
      LEFT JOIN vendas_realizadas v ON u.id = v.operador_id 
      GROUP BY u.id ORDER BY total DESC
    `);

    res.json({
      indicadores: {
        totalCarteira: carteira.rows[0],
        totalVendasAtivas: vendasAtivas.rows[0].count,
        totalUpgrades: upgrades.rows[0].count
      },
      rankingAcordos: rankingAcordos.rows,
      rankingVendas: rankingVendas.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cob/pipeline', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM cob_clientes ORDER BY id DESC');
  res.json(result.rows);
});

app.put('/api/cob/pipeline/mover', authMiddleware, async (req, res) => {
  const { id, novoEstagio } = req.body;
  if (novoEstagio === 'Acordo Pago (Gestão)' && !['SUPERVISOR', 'ADMIN'].includes(req.user.cargo)) {
    return res.status(403).json({ error: 'Movimentação restrita a Supervisores/Admins.' });
  }
  await pool.query('UPDATE cob_clientes SET estagio = $1 WHERE id = $2', [novoEstagio, id]);
  res.json({ success: true });
});

app.post('/api/cob/cadastro', authMiddleware, async (req, res) => {
  const { contrato, nome, telefone, valor_devedor, faixa_atraso } = req.body;
  try {
    await pool.query(
      'INSERT INTO cob_clientes (contrato, nome, telefone, valor_devedor, faixa_atraso) VALUES ($1, $2, $3, $4, $5)',
      [contrato, nome, telefone, valor_devedor, faixa_atraso]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/cob/agenda', authMiddleware, async (req, res) => {
  const result = await pool.query(`
    SELECT a.*, c.nome as cliente_nome, c.telefone 
    FROM cob_agenda a 
    JOIN cob_clientes c ON a.cliente_id = c.id 
    ORDER BY a.data_agendamento ASC
  `);
  res.json(result.rows);
});

app.put('/api/cob/agenda/:id/concluir', authMiddleware, async (req, res) => {
  await pool.query('UPDATE cob_agenda SET concluido = true WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.delete('/api/cob/agenda/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM cob_agenda WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/pos/pipeline', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM pos_clientes ORDER BY id DESC');
  res.json(result.rows);
});

app.put('/api/pos/pipeline/nps', authMiddleware, async (req, res) => {
  const { id, nps } = req.body;
  await pool.query('UPDATE pos_clientes SET satisfacao_nps = $1 WHERE id = $2', [nps, id]);
  res.json({ success: true });
});

app.get('/api/pos/planos', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM pos_planos ORDER BY valor ASC');
  res.json(result.rows);
});

app.post('/api/pos/planos', authMiddleware, async (req, res) => {
  const { nome, valor } = req.body;
  await pool.query('INSERT INTO pos_planos (nome, valor) VALUES ($1, $2)', [nome, valor]);
  res.json({ success: true });
});

app.get('/api/pos/upgrades', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM pos_upgrades');
  res.json(result.rows);
});

app.get('/api/pos/vendas-ativas', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM pos_vendas_ativas');
  res.json(result.rows);
});

app.get('/api/admin/usuarios', authMiddleware, async (req, res) => {
  if (req.user.cargo !== 'ADMIN') return res.status(403).json({ error: 'Acesso Negado' });
  const result = await pool.query('SELECT id, nome, login, cargo FROM usuarios ORDER BY id DESC');
  res.json(result.rows);
});

app.post('/api/admin/usuarios', authMiddleware, async (req, res) => {
  if (req.user.cargo !== 'ADMIN') return res.status(403).json({ error: 'Acesso Negado' });
  const { nome, login, senha, cargo } = req.body;
  const hash = await bcrypt.hash(senha, 10);
  try {
    await pool.query('INSERT INTO usuarios (nome, login, senha, cargo) VALUES ($1, $2, $3, $4)', [nome, login, hash, cargo]);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/usuarios/:id', authMiddleware, async (req, res) => {
  if (req.user.cargo !== 'ADMIN') return res.status(403).json({ error: 'Acesso Negado' });
  await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.post('/api/admin/importar', authMiddleware, upload.single('arquivo'), async (req, res) => {
  if (!['SUPERVISOR', 'ADMIN'].includes(req.user.cargo)) return res.status(403).json({ error: 'Acesso Negado' });
  const { tipo, faixa } = req.body;
  const buffer = req.file.buffer.toString('utf-8');
  const linhas = buffer.split('\n').filter(l => l.trim() !== '');

  try {
    for (let i = 1; i < linhas.length; i++) {
      const colunas = linhas[i].split(';').map(c => c.trim().replace(/"/g, ''));
      if (colunas.length < 2) continue;

      if (tipo === 'cobranca') {
        const [contrato, nome, valor, telefone] = colunas;
        await pool.query(
          `INSERT INTO cob_clientes (contrato, nome, valor_devedor, faixa_atraso, telefone) 
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (contrato) DO NOTHING`,
          [contrato, nome, parseFloat(valor || 0), faixa || '30 dias', telefone || '']
        );
      } else if (tipo === 'upgrade') {
        const [cliente_id, nome, plano_atual] = colunas;
        await pool.query('INSERT INTO pos_upgrades (cliente_id, nome, plano_atual) VALUES ($1, $2, $3)', [cliente_id, nome, plano_atual]);
      } else if (tipo === 'vendas_ativas') {
        const [cliente_id, nome, telefone] = colunas;
        await pool.query('INSERT INTO pos_vendas_ativas (cliente_id, nome, telefone) VALUES ($1, $2, $3)', [cliente_id, nome, telefone]);
      }
    }
    res.json({ success: true, count: linhas.length - 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/limpar-acervo', authMiddleware, async (req, res) => {
  if (req.user.cargo !== 'ADMIN') return res.status(403).json({ error: 'Acesso Negado' });
  const { tabela } = req.body;
  if (['cob_clientes', 'pos_upgrades', 'pos_vendas_ativas'].includes(tabela)) {
    await pool.query(`TRUNCATE TABLE ${tabela} CASCADE`);
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Tabela inválida' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 NEXUS COBR rodando na porta ${PORT}`));

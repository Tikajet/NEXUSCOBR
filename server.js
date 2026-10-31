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

      CREATE TABLE IF NOT EXISTS scripts (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('COBRANCA', 'VENDAS')),
        titulo VARCHAR(100) NOT NULL,
        conteudo TEXT NOT NULL
      );
    `);

    const res = await pool.query("SELECT * FROM usuarios WHERE login = 'admin'");
    if (res.rows.length === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      await pool.query(
        "INSERT INTO usuarios (nome, login, senha, cargo) VALUES ('Admin Nexus', 'admin', $1, 'ADMIN')",
        [hash]
      );
    }

    // Scripts Padrão Iniciais
    const scrRes = await pool.query("SELECT COUNT(*) FROM scripts");
    if (parseInt(scrRes.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO scripts (tipo, titulo, conteudo) VALUES
        ('COBRANCA', 'Abordagem Inicial (30 Dias)', 'Olá [NOME], boa tarde! Identificamos uma pendência em aberto no valor de R$ [VALOR]. Podemos gerar o chave Pix para quitação hoje?'),
        ('COBRANCA', 'Notificação Urgente (60-90 Dias)', 'Prezado(a) [NOME], consta em nosso sistema notificação para cancelamento definitivo. Podemos negociar com desconto especial no valor de R$ [VALOR]?'),
        ('VENDAS', 'Oferta de Up-Grade de Banda', 'Olá [NOME]! Notamos seu excelente uso da nossa fibra. Temos uma oferta para dobrar sua velocidade de internet por apenas R$ 15 a mais no mês.')
      `);
    }
  } catch (err) {
    console.error('❌ Erro no DB:', err);
  }
}
initDB();

function authMiddleware(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Acesso Negado' });
  try {
    req.user = jwt.verify(token.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch (err) {
    res.status(400).json({ error: 'Token Inválido' });
  }
}

// AUTH
app.post('/api/auth/login', async (req, res) => {
  const { login, senha } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE login = $1', [login]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Usuário não encontrado' });
    const user = result.rows[0];
    if (!await bcrypt.compare(senha, user.senha)) return res.status(400).json({ error: 'Senha incorreta' });
    const token = jwt.sign({ id: user.id, cargo: user.cargo, nome: user.nome }, JWT_SECRET);
    res.json({ token, user: { id: user.id, nome: user.nome, login: user.login, cargo: user.cargo } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DASHBOARD - CORRIGIDO
app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const carteira = await pool.query('SELECT COUNT(*), COALESCE(SUM(valor_devedor), 0) as total FROM cob_clientes');
    const acordosPagos = await pool.query("SELECT COUNT(*), COALESCE(SUM(valor_devedor), 0) as total FROM cob_clientes WHERE estagio = 'Acordo Pago (Gestão)'");
    const vendasAtivas = await pool.query('SELECT COUNT(*) FROM pos_vendas_ativas');
    const upgrades = await pool.query('SELECT COUNT(*) FROM pos_upgrades');

    res.json({
      indicadores: {
        totalCarteira: carteira.rows[0],
        totalAcordosPagos: acordosPagos.rows[0],
        totalVendasAtivas: vendasAtivas.rows[0].count,
        totalUpgrades: upgrades.rows[0].count
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// COBRANÇA - CLIENTES
app.get('/api/cob/clientes', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM cob_clientes ORDER BY id DESC');
  res.json(result.rows);
});

app.post('/api/cob/clientes', authMiddleware, async (req, res) => {
  const { contrato, nome, telefone, valor_devedor, faixa_atraso } = req.body;
  try {
    await pool.query(
      'INSERT INTO cob_clientes (contrato, nome, telefone, valor_devedor, faixa_atraso) VALUES ($1, $2, $3, $4, $5)',
      [contrato, nome, telefone || '', valor_devedor || 0, faixa_atraso || '30 dias']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/cob/clientes/:id', authMiddleware, async (req, res) => {
  const { contrato, nome, telefone, valor_devedor, faixa_atraso } = req.body;
  try {
    await pool.query(
      'UPDATE cob_clientes SET contrato=$1, nome=$2, telefone=$3, valor_devedor=$4, faixa_atraso=$5 WHERE id=$6',
      [contrato, nome, telefone, valor_devedor, faixa_atraso, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/cob/clientes/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM cob_clientes WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.put('/api/cob/pipeline/mover', authMiddleware, async (req, res) => {
  const { id, novoEstagio } = req.body;
  if (novoEstagio === 'Acordo Pago (Gestão)' && !['SUPERVISOR', 'ADMIN'].includes(req.user.cargo)) {
    return res.status(403).json({ error: 'Movimentação restrita a Supervisores/Admins.' });
  }
  await pool.query('UPDATE cob_clientes SET estagio = $1 WHERE id = $2', [novoEstagio, id]);
  res.json({ success: true });
});

// PÓS VENDAS - CLIENTES E PLANOS
app.get('/api/pos/clientes', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM pos_clientes ORDER BY id DESC');
  res.json(result.rows);
});

app.post('/api/pos/clientes', authMiddleware, async (req, res) => {
  const { nome, telefone, valor_mensal } = req.body;
  await pool.query('INSERT INTO pos_clientes (nome, telefone, valor_mensal) VALUES ($1, $2, $3)', [nome, telefone, valor_mensal]);
  res.json({ success: true });
});

app.put('/api/pos/clientes/:id', authMiddleware, async (req, res) => {
  const { nome, telefone, valor_mensal } = req.body;
  await pool.query('UPDATE pos_clientes SET nome=$1, telefone=$2, valor_mensal=$3 WHERE id=$4', [nome, telefone, valor_mensal, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/pos/clientes/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM pos_clientes WHERE id = $1', [req.params.id]);
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

app.delete('/api/pos/planos/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM pos_planos WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/pos/upgrades', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM pos_upgrades ORDER BY id DESC');
  res.json(result.rows);
});

app.get('/api/pos/vendas-ativas', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM pos_vendas_ativas ORDER BY id DESC');
  res.json(result.rows);
});

// SCRIPTS MANUAL
app.get('/api/scripts/:tipo', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM scripts WHERE tipo = $1 ORDER BY id DESC', [req.params.tipo]);
  res.json(result.rows);
});

app.post('/api/scripts', authMiddleware, async (req, res) => {
  const { tipo, titulo, conteudo } = req.body;
  await pool.query('INSERT INTO scripts (tipo, titulo, conteudo) VALUES ($1, $2, $3)', [tipo, titulo, conteudo]);
  res.json({ success: true });
});

app.delete('/api/scripts/:id', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM scripts WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ADMIN & IMPORTADOR (3 Colunas: ID;Nome;Valor)
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
    for (let i = 0; i < linhas.length; i++) {
      const colunas = linhas[i].split(';').map(c => c.trim().replace(/"/g, ''));
      if (colunas.length < 2) continue;

      if (tipo === 'cobranca') {
        const [contrato, nome, valor, telefone] = colunas;
        const valNum = parseFloat((valor || '0').replace(',', '.'));
        await pool.query(
          `INSERT INTO cob_clientes (contrato, nome, valor_devedor, faixa_atraso, telefone) 
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (contrato) DO UPDATE SET valor_devedor = EXCLUDED.valor_devedor`,
          [contrato, nome, valNum, faixa || '30 dias', telefone || '']
        );
      } else if (tipo === 'upgrade') {
        const [cliente_id, nome, plano_atual] = colunas;
        await pool.query('INSERT INTO pos_upgrades (cliente_id, nome, plano_atual) VALUES ($1, $2, $3)', [cliente_id, nome, plano_atual || 'Padrão']);
      } else if (tipo === 'vendas_ativas') {
        const [cliente_id, nome, telefone] = colunas;
        await pool.query('INSERT INTO pos_vendas_ativas (cliente_id, nome, telefone) VALUES ($1, $2, $3)', [cliente_id, nome, telefone || '']);
      }
    }
    res.json({ success: true, count: linhas.length });
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
app.listen(PORT, () => console.log(`🚀 NEXUS COBR (Enterprise V2) rodando na porta ${PORT}`));

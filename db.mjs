import pkg from 'pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
const { Pool } = pkg;

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['PGUSER', 'PGHOST', 'PGDATABASE', 'POSTGRES_PASSWORD', 'PGPORT'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}

// Configure database pool
const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.POSTGRES_PASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false
});

// Test database connection
pool.connect((err, client, done) => {
  if (err) {
    console.error('Error connecting to the database:', err);
  } else {
    console.log('Successfully connected to database');
    done();
  }
});

const saltRounds = 10;

const users = [
  { username: 'tmetaxation', password: '100%TME-25' },
  { username: 'uwe', password: '100%TME-25' },
  { username: 'malavika', password: '100%TME-25' },
  { username: 'dijendra', password: '100%TME-25' }
];

// Initialize database tables
const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Drop existing tables if they exist
    await client.query(`
      DROP TABLE IF EXISTS messages CASCADE;
      DROP TABLE IF EXISTS conversations CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);

    // Create users table
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Insert users with hashed passwords
    for (const user of users) {
      const hashedPassword = await bcrypt.hash(user.password, saltRounds);
      await client.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
        [user.username, hashedPassword]
      );
    }

    // Create conversations table
    await client.query(`
      CREATE TABLE conversations (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_conversations_user_id ON conversations(user_id);
    `);

    // Create messages table
    await client.query(`
      CREATE TABLE messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      );
      CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
    `);

    await client.query('COMMIT');
    console.log('Database initialized successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Add error logging utility
const logError = (operation, error) => {
  console.error(`Database ${operation} error:`, {
    message: error.message,
    code: error.code,
    detail: error.detail,
    where: error.where,
    timestamp: new Date().toISOString()
  });
};

// Wrap database operations in try-catch
const createConversation = async (userId, title) => {
  try {
    const result = await pool.query(
      'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *',
      [parseInt(userId), title]
    );
    return result.rows[0];
  } catch (error) {
    logError('createConversation', error);
    throw new Error(`Failed to create conversation: ${error.message}`);
  }
};

const addMessage = async (conversationId, role, content, metadata = {}) => {
  try {
    const result = await pool.query(
      'INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, $2, $3, $4) RETURNING *',
      [conversationId, role, content, metadata]
    );
    return result.rows[0];
  } catch (error) {
    logError('addMessage', error);
    throw new Error(`Failed to add message: ${error.message}`);
  }
};

const getConversations = async (userId) => {
  try {
    const result = await pool.query(
      `SELECT c.*, 
              (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at ASC LIMIT 1) as first_message
       FROM conversations c 
       WHERE c.user_id = $1 
       ORDER BY c.updated_at DESC`,
      [userId]
    );
    return result.rows;
  } catch (error) {
    logError('getConversations', error);
    throw new Error(`Failed to fetch conversations: ${error.message}`);
  }
};

const getConversationMessages = async (conversationId, userId) => {
  try {
    // First verify the conversation belongs to the user
    const conversationCheck = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    
    if (conversationCheck.rows.length === 0) {
      throw new Error('Unauthorized access to conversation');
    }

    const result = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId]
    );
    return result.rows;
  } catch (error) {
    logError('getConversationMessages', error);
    throw new Error(`Failed to fetch conversation messages: ${error.message}`);
  }
};

const updateConversationTimestamp = async (conversationId) => {
  try {
    await pool.query(
      'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [conversationId]
    );
  } catch (error) {
    logError('updateConversationTimestamp', error);
    throw new Error(`Failed to update conversation timestamp: ${error.message}`);
  }
};

const deleteConversation = async (conversationId, userId) => {
  try {
    // First verify the conversation belongs to the user
    const conversationCheck = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    
    if (conversationCheck.rows.length === 0) {
      throw new Error('Unauthorized access to conversation');
    }

    await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]);
  } catch (error) {
    logError('deleteConversation', error);
    throw new Error(`Failed to delete conversation: ${error.message}`);
  }
};

// Add health check query
const healthCheck = async () => {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    logError('healthCheck', error);
    return false;
  }
};

export {
  pool,
  initDb,
  createConversation,
  addMessage,
  getConversations,
  getConversationMessages,
  updateConversationTimestamp,
  deleteConversation,
  healthCheck
}; 
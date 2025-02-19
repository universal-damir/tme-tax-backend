const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'tax_chat',
  password: 'postgres',
  port: 5432,
});

const saltRounds = 10;

const users = [
  { username: 'tmetaxation', password: '100%TME-25' },
  { username: 'uwe', password: '100%TME-25' },
  { username: 'malavika', password: '100%TME-25' },
  { username: 'dijendra', password: '100%TME-25' }
];

async function initDB() {
  try {
    // Drop existing tables if they exist
    await pool.query('DROP TABLE IF EXISTS conversations CASCADE');
    await pool.query('DROP TABLE IF EXISTS messages CASCADE');
    await pool.query('DROP TABLE IF EXISTS users CASCADE');

    // Create users table with hashed password
    await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create conversations table
    await pool.query(`
      CREATE TABLE conversations (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create messages table
    await pool.query(`
      CREATE TABLE messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        role VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert users with hashed passwords
    for (const user of users) {
      const hashedPassword = await bcrypt.hash(user.password, saltRounds);
      await pool.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
        [user.username, hashedPassword]
      );
    }

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

initDB(); 
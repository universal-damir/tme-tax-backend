// server.mjs
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {
  initDb,
  createConversation,
  addMessage,
  getConversations,
  getConversationMessages,
  updateConversationTimestamp,
  deleteConversation
} from './db.mjs';
import bcrypt from 'bcrypt';
import pkg from 'pg';
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Current directory:', process.cwd());
console.log('__dirname:', __dirname);

// Load environment variables only in development
if (process.env.NODE_ENV !== 'production') {
  const envPath = path.resolve(process.cwd(), '.env');
  console.log('Loading .env from:', envPath);
  const result = dotenv.config({ path: envPath, debug: true });
  if (result.error) {
    console.warn('Error loading .env file in development:', result.error);
  }
} else {
  console.log('Running in production mode, using environment variables');
}

console.log('Environment variables loaded:', {
  PGUSER: process.env.PGUSER,
  PGHOST: process.env.PGHOST,
  PGDATABASE: process.env.PGDATABASE,
  PGPORT: process.env.PGPORT,
  // Not logging password
});

const app = express();

// Security middleware
app.use(helmet());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

app.use('/api/', limiter);

// Strict CORS configuration
const allowedOrigins = [
  'https://taxgpt.netlify.app',
  'http://localhost:3000',
  'http://localhost:4000'
];

const corsOptions = {
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('Blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS', 'PUT', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  credentials: true,
  maxAge: 86400, // 24 hours
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Sanitize request data
app.use(express.json({ limit: '10kb' })); // Limit JSON payload size

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Basic route to confirm server is running
app.get('/', (req, res) => res.send('Server is live'));

// Logging middleware for debugging
app.use((req, res, next) => {
  console.log('Incoming request:', {
    method: req.method,
    origin: req.headers.origin,
    path: req.path
  });
  next();
});

// Ttest route to verify CORS
app.get('/api/test', (req, res) => {
  res.json({ message: 'CORS is working' });
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Pinecone with error handling
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

// Validate environment variables
if (!process.env.PINECONE_INDEX) {
  throw new Error('PINECONE_INDEX environment variable is not set');
}

const index = pinecone.index(process.env.PINECONE_INDEX);

// Error handler for Pinecone operations
const handlePineconeError = (error) => {
  console.error('Pinecone error:', error);
  if (error.message.includes('name')) {
    throw new Error('Invalid Pinecone index configuration. Please check your PINECONE_INDEX environment variable.');
  }
  throw error;
};

// Health check endpoint
app.get('/api/health', (req, res) => {
  console.log('Health check received:', {
    headers: req.headers,
    origin: req.get('origin')
  });
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

const SYSTEM_PROMPT = `You are an expert UAE Tax Consultant Assistant with deep knowledge of UAE tax laws, regulations, and practices. 
Your responses should be well-formatted and easy to read, using appropriate markdown formatting:

- Use headers (##) for main sections
- Use bullet points for lists
- Use bold (**) for important terms
- Break down complex answers into clear sections
- Include relevant examples in code blocks
- Use tables when comparing multiple items

Base your answers on the provided context and format them for clarity. When applicable quote the law you are referencing. Note, IF you encouter ESR Rules, do not mention or discuss thise, since they are abolished by law in 2024.`;

// Initialize database
initDb().catch(console.error);

// New endpoints for conversation management
app.get('/api/conversations', async (req, res) => {
  try {
    const userId = req.headers.authorization;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized - No userId provided' });
    }
    console.log('Fetching conversations for user:', userId);
    const conversations = await getConversations(userId);
    res.json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const messages = await getConversationMessages(req.params.id);
    res.json(messages);
  } catch (error) {
    console.error('Error fetching conversation messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/conversations', async (req, res) => {
  try {
    const { title } = req.body;
    const userId = req.headers.authorization;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const conversation = await createConversation(userId, title || 'New Conversation');
    res.json(conversation);
  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  try {
    await deleteConversation(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update the existing chat endpoint to work with conversations
app.post('/api/chat', async (req, res) => {
  console.log('Received chat request');
  
 
  // CORS headers explicitly in case they're lost
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { message, conversationId, history = [] } = req.body;
    const userId = req.headers.authorization;
    
    if (!userId) {
      sendSSE({ type: 'error', error: 'Unauthorized' });
      return res.end();
    }

    let currentConversationId = conversationId;
    if (!currentConversationId) {
      // Create a new conversation if none exists
      const conversation = await createConversation(userId, message.slice(0, 50) + '...');
      currentConversationId = conversation.id;
      sendSSE({ type: 'conversation', id: currentConversationId });
    }

    // Save user message
    await addMessage(currentConversationId, 'user', message);

    const embedding = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: message,
    });
    console.log('Generated embeddings');

    const queryResponse = await index.query({
      vector: embedding.data[0].embedding,
      topK: 5,
      includeMetadata: true
    });
    console.log('Retrieved context from Pinecone');

    const context = queryResponse.matches
      .map(match => `Content: ${match.metadata.text}\nSource: ${match.metadata.source}`)
      .join('\n\n');

    const sources = [...new Set(
      queryResponse.matches
        .map(match => path.basename(match.metadata.source))
        .filter(Boolean)
    )];

    const conversationHistory = history.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    }));

    console.log('Creating OpenAI stream...');
    const stream = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...conversationHistory,
        { role: "user", content: `Context:\n${context}\n\nQuestion: ${message}` }
      ],
      temperature: 0.7,
      max_tokens: 1000,
      stream: true
    });

    console.log('Starting to stream response...');
    let assistantMessage = '';
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        assistantMessage += content;
        sendSSE({ type: 'content', content });
      }
    }

    // Save assistant message
    await addMessage(currentConversationId, 'assistant', assistantMessage);
    await updateConversationTimestamp(currentConversationId);

    sendSSE({ type: 'done' });
    res.end();

  } catch (error) {
    console.error('Error processing chat request:', error);
    sendSSE({
      type: 'error',
      error: error.message || 'Internal server error'
    });
    res.end();
  }
});

// Add CORS debugging middleware
app.use((req, res, next) => {
  console.log('Incoming request:', {
    method: req.method,
    path: req.path,
    origin: req.headers.origin,
    headers: req.headers
  });
  next();
});

// Handle preflight requests for all routes
app.options('*', (req, res) => {
  console.log('Handling preflight request:', {
    origin: req.headers.origin,
    method: req.method,
    path: req.path
  });
  
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', allowedOrigins.includes(req.headers.origin) ? req.headers.origin : '');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  
  // Respond with 204
  res.sendStatus(204);
});

// Update error handling middleware to include CORS headers
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Set CORS headers even for error responses
  res.header('Access-Control-Allow-Origin', allowedOrigins.includes(req.headers.origin) ? req.headers.origin : '');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message
  });
});

// Generate a secure JWT secret if not provided in environment
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

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

// Update login endpoint
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    // Query user from database
    const result = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (isValidPassword) {
      res.json({ 
        success: true,
        userId: user.id.toString(),
        username: user.username
      });
    } else {
      res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

const PORT = 4000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
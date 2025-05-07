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

// CORS Configuration - Must be before other middleware
const corsOptions = {
  origin: ['https://taxgpt.netlify.app', 'http://localhost:3000', 'http://localhost:4000'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS', 'PUT', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400
};

// Apply CORS middleware first
app.use(cors(corsOptions));

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "unsafe-none" }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

app.use('/api/', limiter);

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
Your role is to provide **accurate, clear, and professional** answers strictly within the scope of UAE tax laws, referencing official regulations whenever possible.

## **Response Guidelines**
- Always base responses on provided legal references—do not speculate or invent information.
- Maintain conversation memory, ensuring continuity and a natural flow.
- If an article or document is relevant, reference it explicitly.
- If required information is missing, indicate that and suggest the best official sources to check.
- If tax laws have multiple interpretations, highlight them and provide all relevant perspectives.
- Do **not** discuss Economic Substance Rules (ESR), as they were abolished in 2024.
- Prioritize the most recent UAE tax regulations, clarifying if older laws have been amended or repealed.
- If a query requires case-specific legal interpretation, recommend consulting **TME Services** for expert tax advice.

## **Formatting for Clarity**
- **Headers (##)** for major sections
- **Bullet points (-)** for structured lists
- **Bold text (**) for key legal terms**
- **Tables** for comparisons when applicable
- **Example Blocks** for case studies or calculations
- **Use proper Markdown code blocks for calculations, instead of LaTeX notation**
- **Example of correct tax calculation formatting:**
## **Corporate Tax Calculation**
  - **Total Profit:** AED 750,000
  - **Exempted Threshold:** AED 375,000
  - **Taxable Amount:** AED 750,000 - AED 375,000 = AED 375,000
  - **Tax Rate:** 9%
  - **CIT Due:** AED 375,000 × 9% = **AED 33,750**

## **Engaging Follow-Ups**
- Instead of listing generic follow-up topics, **ask the user relevant questions** based on their query.
- Example: Instead of "Possible Follow-Up Topics: Deductions and Exemptions," ask:  
  - "Are you looking to explore potential deductions or exemptions that might reduce this tax?"  
  - "Would you like to understand how corporate tax applies to free zone entities like yours?"  
- Ensure follow-up questions feel **natural and conversational**, helping users **deepen their understanding**.
- Offer to connect them with **TME Services** for a personalized consultation if needed.

## **Tone & Readability**
- Maintain a professional yet approachable tone, avoiding overly technical or robotic language.
- Use clear, natural phrasing that a business owner or accountant would easily understand.

## **Disclaimers**
- At the beginning of a conversation, state that responses are for informational purposes only and not legal advice.
- Avoid repeating disclaimers unless the context changes significantly.
- If case-specific guidance is needed, refer the user to **TME Services** for a tailored consultation.

Stay professional, concise, and focused strictly on UAE tax topics.`;

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
    const userId = req.headers.authorization;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized - No userId provided' });
    }

    const messages = await getConversationMessages(req.params.id, userId);
    res.json(messages);
  } catch (error) {
    console.error('Error fetching conversation messages:', error);
    if (error.message.includes('Unauthorized')) {
      return res.status(403).json({ error: 'Unauthorized access to conversation' });
    }
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
    const userId = req.headers.authorization;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized - No userId provided' });
    }

    await deleteConversation(req.params.id, userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    if (error.message.includes('Unauthorized')) {
      return res.status(403).json({ error: 'Unauthorized access to conversation' });
    }
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
      model: "gpt-4-turbo",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...conversationHistory,
        { role: "user", content: `Context:\n${context}\n\nQuestion: ${message}` }
      ],
      temperature: 0.3, // Lower temperature for accuracy in legal/tax responses
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
  res.header('Access-Control-Allow-Origin', corsOptions.origin.includes(req.headers.origin) ? req.headers.origin : '');
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
  res.header('Access-Control-Allow-Origin', corsOptions.origin.includes(req.headers.origin) ? req.headers.origin : '');
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

// Configure port for different environments
const PORT = process.env.PORT || 4000;
console.log('Environment:', process.env.NODE_ENV);
console.log('Attempting to start server on port:', PORT);

// Start server with proper host binding
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Full server URL: http://0.0.0.0:${PORT}`);
  console.log('CORS allowed origins:', corsOptions.origin);
});
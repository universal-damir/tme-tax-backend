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
import multer from 'multer';
import fs from 'fs';
import {
  processFile,
  createDocumentEmbeddings,
  searchDocumentChunks,
  cleanupFile
} from './fileProcessor.mjs';
import {
  initDb,
  initDbSafe,
  createConversation,
  addMessage,
  getConversations,
  getConversationMessages,
  updateConversationTimestamp,
  updateConversation,
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
  PGUSER: process.env.PGUSER ? '***' : 'not set',
  PGHOST: process.env.PGHOST ? '***' : 'not set', 
  PGDATABASE: process.env.PGDATABASE ? '***' : 'not set',
  PGPORT: process.env.PGPORT ? '***' : 'not set',
  // Never log passwords or API keys
});

const app = express();

// CORS Configuration - Must be before other middleware
const corsOptions = {
  origin: ['https://taxgpt.netlify.app', 'http://localhost:3000', 'http://localhost:3001', 'http://localhost:4000'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS', 'PUT', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-Conversation-Id'],
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

## **Document Analysis Priority**
- **ALWAYS analyze uploaded documents FIRST** before asking for additional information
- If a trial balance, financial statement, or tax document is provided, examine its contents thoroughly
- Extract relevant financial data from uploaded documents and use it for calculations
- Only ask for clarification if specific items in the uploaded documents are unclear or missing
- **NEVER ask users to manually provide information that is already available in uploaded documents**

## **Response Guidelines**
- Always base responses on provided legal references and uploaded documents—do not speculate or invent information.
- Maintain conversation memory, ensuring continuity and a natural flow.
- If an article or document is relevant, reference it explicitly.
- If required information is missing from uploaded documents, indicate that and suggest the best official sources to check.
- If tax laws have multiple interpretations, highlight them and provide all relevant perspectives.
- Do **not** discuss Economic Substance Rules (ESR), as they were abolished in 2024.
- Prioritize the most recent UAE tax regulations, clarifying if older laws have been amended or repealed.
- If a query requires case-specific legal interpretation, recommend consulting **TME Services** for expert tax advice.
- **NEVER include generic disclaimers**, such as:
  - "Please consult a tax professional"
  - "It is advisable to check official sources"
  - "This is not tax advice"
  - Or any variation of these statements.  
  **This tool is already used by qualified tax professionals.**

## **Trial Balance & Financial Document Analysis**
- When a **trial balance or financial statement** is uploaded, immediately analyze its contents
- Identify relevant tax items such as:
  - **Revenue**, **COGS**, **operating expenses**, **depreciation**, **provisions**, **related-party transactions**, etc.
- Calculate **adjusted taxable profit** according to UAE Corporate Tax law using the provided figures
- Apply **exemptions**, **thresholds**, or **non-deductible expenses** where applicable
- **Only ask for clarification** if specific items in the document are ambiguous or require additional context
- If information is clearly missing from the uploaded document, state what is needed for a proper assessment
- Output tax calculations using a clean Markdown breakdown like this:

### **Corporate Tax Calculation Based on Uploaded Trial Balance**
- **Net Profit Before Tax (from uploaded document):** AED XXXX
- **Add Back Non-Deductible Expenses:**
  - Entertainment: AED XXX
  - Fines: AED XXX
- **Less Allowable Deductions:**
  - Depreciation: AED XXX
- **Taxable Profit:** AED XXXX
- **Exempt Threshold:** AED 375,000
- **Taxable Amount:** AED XXXX - AED 375,000 = AED XXXX
- **Tax Rate:** 9%
- **CIT Due:** AED XXX

## **Document Context Usage**
- When user documents are available in the context, prioritize them over asking for manual input
- Reference specific line items, accounts, or figures from uploaded documents
- If calculations require assumptions, clearly state them and base them on standard UAE tax practices
- Always acknowledge when you're using data from uploaded documents vs. general knowledge`;

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

// Initialize database safely - only create tables if they don't exist
const initializeDatabase = async () => {
  try {
    // Safety check: never allow destructive initialization in production
    if (process.env.NODE_ENV === 'production' && process.env.FORCE_DB_RESET === 'true') {
      console.error('CRITICAL WARNING: Attempted to reset database in production. This operation is blocked for safety.');
      console.error('If you absolutely need to reset the database, set FORCE_DB_RESET=true in environment variables.');
      console.error('This will result in PERMANENT DATA LOSS!');
      return;
    }
    
    // Check if the conversations table exists
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'conversations'
    `);
    
    if (result.rows.length === 0) {
      console.log('Database tables not found, initializing for the first time...');
      await initDbSafe();
      console.log('Database initialization completed successfully');
    } else {
      console.log('Database already initialized, skipping table creation to preserve existing data');
    }
  } catch (error) {
    console.error('Database initialization error:', error);
    // In production, we don't want to crash the server if DB check fails
    if (process.env.NODE_ENV !== 'production') {
      throw error;
    }
  }
};

initializeDatabase();

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

app.put('/api/conversations/:id', async (req, res) => {
  try {
    const userId = req.headers.authorization;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized - No userId provided' });
    }

    const { title } = req.body;
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ error: 'Title is required and must be a non-empty string' });
    }

    const updatedConversation = await updateConversation(req.params.id, userId, { title: title.trim() });
    res.json(updatedConversation);
  } catch (error) {
    console.error('Error updating conversation:', error);
    if (error.message.includes('Unauthorized')) {
      return res.status(403).json({ error: 'Unauthorized access to conversation' });
    }
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

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    
    const allowedExtensions = ['.pdf', '.csv', '.xlsx', '.xls'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, CSV, and Excel files are allowed.'), false);
    }
  }
});

// File upload endpoint
app.post('/api/upload', upload.single('document'), async (req, res) => {
  try {
    const userId = req.headers.authorization;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized - No userId provided' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Get conversationId from headers or request body
    const conversationId = req.headers['x-conversation-id'] || req.body.conversationId;
    
    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation ID is required for file upload' });
    }

    // console.log('=== FILE UPLOAD DEBUG ===');
    console.log('Processing uploaded file:', req.file.originalname, 'for conversation:', conversationId);
    // console.log('Conversation ID type:', typeof conversationId);
    // console.log('Conversation ID value:', JSON.stringify(conversationId));
    
    // Process the file
    const processedData = await processFile(req.file.path, req.file.originalname);
    console.log('File processed successfully:', {
      fileName: processedData.originalName,
      type: processedData.type,
      textLength: processedData.text?.length || 0
    });
    
    // Create embeddings and store in Pinecone with correct conversationId
    const embeddingResult = await createDocumentEmbeddings(processedData, conversationId);
    console.log('Embeddings created successfully:', {
      conversationId,
      chunksCreated: embeddingResult.chunksCreated,
      vectorIds: embeddingResult.vectorIds.slice(0, 3) // Log first 3 vector IDs
    });
    
    // Clean up the temporary file
    cleanupFile(req.file.path);
    
    res.json({
      success: true,
      document: {
        fileName: processedData.originalName,
        fileType: processedData.type,
        fileSize: processedData.fileSize,
        processedAt: processedData.processedAt,
        chunksCreated: embeddingResult.chunksCreated,
        metadata: processedData.metadata
      }
    });

  } catch (error) {
    console.error('Error processing file upload:', error);
    
    // Clean up file on error
    if (req.file) {
      cleanupFile(req.file.path);
    }
    
    res.status(500).json({ 
      error: error.message || 'Failed to process uploaded file' 
    });
  }
});

// Search user documents endpoint
app.post('/api/search-documents', async (req, res) => {
  try {
    const userId = req.headers.authorization;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized - No userId provided' });
    }

    const { query, conversationId, topK = 5 } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation ID is required' });
    }

    const results = await searchDocumentChunks(query, conversationId, topK);
    
    res.json({
      success: true,
      results
    });

  } catch (error) {
    console.error('Error searching documents:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to search documents' 
    });
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

    // console.log('=== CHAT DEBUG INFO ===');
    // console.log('Current conversation ID:', currentConversationId, 'Type:', typeof currentConversationId);
    // console.log('User message:', message.substring(0, 100) + '...');

    // Ensure conversationId is always a string for consistency with file upload
    const conversationIdString = String(currentConversationId);
    // console.log('Converted conversation ID for search:', conversationIdString, 'Type:', typeof conversationIdString);

    const embedding = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: message,
    });
    console.log('Generated embeddings');

    // Search both general knowledge and user documents
    const [generalQuery, userDocsQuery] = await Promise.all([
      index.query({
        vector: embedding.data[0].embedding,
        topK: 3,
        includeMetadata: true,
        filter: {
          conversationId: { $exists: false }  // Only get general knowledge, not user docs
        }
      }),
      searchDocumentChunks(message, conversationIdString, 3)  // Use string version
    ]);

    console.log('Retrieved context from Pinecone and user documents');
    console.log('General knowledge matches:', generalQuery.matches.length);
    console.log('User document matches:', userDocsQuery.length);
    console.log('User documents found:', userDocsQuery.map(doc => doc.fileName));

    // Combine general knowledge and user document context
    const generalContext = generalQuery.matches
      .map(match => `Content: ${match.metadata?.text || 'No content available'}\nSource: ${match.metadata?.source || 'Unknown'}`)
      .join('\n\n');

    const userDocContext = userDocsQuery
      .map(match => `User Document (${match.fileName}): ${match.text}`)
      .join('\n\n');

    // Prioritize user documents by putting them first and making them more prominent
    let combinedContext = '';
    if (userDocContext) {
      combinedContext += `=== UPLOADED USER DOCUMENTS (ANALYZE THESE FIRST) ===\n\n${userDocContext}\n\n`;
    }
    if (generalContext) {
      combinedContext += `=== GENERAL KNOWLEDGE BASE ===\n\n${generalContext}`;
    }

    console.log('Combined context length:', combinedContext.length);
    console.log('User document context included:', userDocContext.length > 0);
    if (userDocContext.length > 0) {
      console.log('User document content preview:', userDocContext.substring(0, 200) + '...');
    }

    const sources = [...new Set([
      ...generalQuery.matches
        .map(match => match.metadata?.source ? path.basename(match.metadata.source) : null)
        .filter(Boolean),
      ...userDocsQuery.map(match => match.fileName)
    ])];

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
        { 
          role: "user", 
          content: userDocContext.length > 0 
            ? `I have uploaded documents that contain relevant data. Please analyze the uploaded documents first before asking for additional information.\n\nContext:\n${combinedContext}\n\nQuestion: ${message}`
            : `Context:\n${combinedContext}\n\nQuestion: ${message}`
        }
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
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With, X-Conversation-Id');
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
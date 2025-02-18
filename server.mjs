// server.mjs
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

console.log('Environment variables check:', {
  hasPineconeKey: !!process.env.PINECONE_API_KEY,
  hasPineconeIndex: !!process.env.PINECONE_INDEX,
  pineconeIndex: process.env.PINECONE_INDEX,
  hasOpenAIKey: !!process.env.OPENAI_API_KEY
});

const app = express();

const allowedOrigins = ['https://taxgpt.netlify.app', 'http://localhost:3001', 'https://heroic-bombolone-ae44f2.netlify.app'];
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
};

app.use(cors(corsOptions));

// Explicitly handle OPTIONS requests for /api/chat
app.options('/api/chat', (req, res) => {
  console.log('Received OPTIONS request for /api/chat');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  return res.sendStatus(200);
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

app.use(express.json());

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
    const { message, history = [] } = req.body;
    console.log('Processing message:', message);

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
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        sendSSE({ type: 'content', content });
      }
    }

    sendSSE({ type: 'done' });
    res.end();

  } catch (error) {
    console.error('Error processing chat request:', error);
    
    // Determine the error type and send appropriate message
    const errorMessage = {
      type: 'error',
      error: error.message || 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? {
        name: error.name,
        stack: error.stack,
        cause: error.cause
      } : undefined
    };
    
    sendSSE(errorMessage);
    res.end();
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message
  });
});

const VALID_USERNAME = process.env.LOGIN_USERNAME || 'tmetaxation';
const VALID_PASSWORD = process.env.LOGIN_PASSWORD || '100%TME-25';


app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  

  const isValidUsername = crypto.timingSafeEqual(
    Buffer.from(username),
    Buffer.from(VALID_USERNAME)
  );
  
  const isValidPassword = crypto.timingSafeEqual(
    Buffer.from(password),
    Buffer.from(VALID_PASSWORD)
  );

  if (isValidUsername && isValidPassword) {
    res.json({ success: true });
  } else {
  
    res.status(401).json({ 
      success: false, 
      message: 'Invalid credentials' 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
// server.mjs
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env
dotenv.config();

// Resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/**
 * Logging middleware (runs before any CORS checks).
 * Logs request details for debugging and monitoring.
 */
app.use((req, res, next) => {
  console.log('Incoming request:', {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    origin: req.headers.origin,
    referer: req.headers.referer,
    host: req.headers.host,
    contentType: req.headers['content-type'],
  });
  next();
});

/**
 * CORS Configuration
 * Allows specific origins and handles preflight checks.
 */
const allowedOrigins = [
  'https://taxgpt.netlify.app',
  'https://www.taxgpt.netlify.app',
  'http://localhost:3000',
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    // Allow if the incoming origin starts with any of the allowed ones
    if (allowedOrigins.some((allowed) => origin.startsWith(allowed))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
  credentials: false,
  optionsSuccessStatus: 200,
  exposedHeaders: ['Content-Type', 'Content-Length'],
};

// Apply CORS middleware globally
app.use(cors(corsOptions));

// Parse incoming JSON in request body
app.use(express.json());

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Pinecone client
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

// Reference your Pinecone index
const index = pinecone.index(process.env.PINECONE_INDEX);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

// A simple test endpoint to verify CORS
app.get('/api/test', (req, res) => {
  res.json({
    message: 'CORS is working',
    origin: req.headers.origin,
  });
});

/**
 * System Prompt for Chat
 * Tailored to provide a specific "personality" and context to the AI.
 */
const SYSTEM_PROMPT = `You are an expert UAE Tax Consultant Assistant with deep knowledge of UAE tax laws, regulations, and practices. 
Your responses should be well-formatted and easy to read, using appropriate markdown formatting:

- Use headers (##) for main sections
- Use bullet points for lists
- Use **bold** for important terms
- Break down complex answers into clear sections
- Include relevant examples in code blocks
- Use tables when comparing multiple items

Base your answers on the provided context and format them for clarity. When applicable quote the law you are referencing. Note, IF you encouter ESR Rules, do not mention or discuss those, since they are abolished by law in 2024.`;

/**
 * Chat endpoint with Server-Sent Events (SSE)
 * Allows streaming of the AI response to the client.
 */
app.post('/api/chat', async (req, res) => {
  // Set SSE response headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Origin',
  });

  // Helper function to send events to the client
  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Destructure incoming data
    const { message, history = [] } = req.body;
    console.log('Processing chat message:', {
      message,
      historyLength: history.length,
    });

    // Step 1: Generate embeddings via OpenAI
    const embedding = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: message,
    });

    // Step 2: Query Pinecone with the generated embeddings
    const queryResponse = await index.query({
      vector: embedding.data[0].embedding,
      topK: 5,
      includeMetadata: true,
    });

    // Step 3: Format retrieved context for the prompt
    const context = queryResponse.matches
      .map(
        (match) =>
          `Content: ${match.metadata.text}\nSource: ${match.metadata.source}`
      )
      .join('\n\n');

    // Gather unique sources
    const sources = [
      ...new Set(
        queryResponse.matches
          .map((match) => path.basename(match.metadata.source))
          .filter(Boolean)
      ),
    ];

    // Step 4: Format chat history for GPT
    const conversationHistory = history.map((msg) => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text,
    }));

    // Step 5: Create a streaming chat completion
    const stream = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...conversationHistory,
        {
          role: 'user',
          content: `Context:\n${context}\n\nQuestion: ${message}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 1000,
      stream: true,
    });

    // Step 6: Stream the response back to the client
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        sendSSE({ type: 'content', content });
      }
    }

    // After streaming is done, send the "done" event with sources
    sendSSE({ type: 'done', sources });
  } catch (error) {
    console.error('Error in chat endpoint:', error);

    const errorMessage =
      process.env.NODE_ENV === 'development'
        ? error.message
        : 'An error occurred while processing your request';

    sendSSE({
      type: 'error',
      error: errorMessage,
    });
  } finally {
    // End the SSE response
    res.end();
  }
});

/**
 * Global error-handling middleware.
 * Handles errors that might not be caught in the usual flow.
 */
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);

  const statusCode = err.statusCode || 500;
  const message =
    process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;

  res.status(statusCode).json({
    error: message,
    status: 'error',
  });
});

// Start the server on the specified port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
});

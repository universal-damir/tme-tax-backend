// server.mjs
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();

const corsOptions = {
  origin: [
    'https://taxgpt.netlify.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

const index = pinecone.index(process.env.PINECONE_INDEX);

// Add health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
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
    sendSSE({ 
      type: 'error', 
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
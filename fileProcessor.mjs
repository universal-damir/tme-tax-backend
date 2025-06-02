import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse-debugging-disabled';
import xlsx from 'xlsx';
import csv from 'csv-parser';
import { OpenAI } from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables - consistent with server.mjs
if (process.env.NODE_ENV !== 'production') {
  const envPath = path.resolve(__dirname, '..', '.env');  // Go up one level to root
  console.log('FileProcessor: Loading .env from:', envPath);
  const result = dotenv.config({ path: envPath, debug: true });
  if (result.error) {
    console.warn('FileProcessor: Error loading .env file in development:', result.error);
  } else {
    console.log('FileProcessor: .env file loaded successfully');
  }
} else {
  console.log('FileProcessor: Running in production mode, using environment variables');
}

// Validate required environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'PINECONE_API_KEY', 'PINECONE_INDEX'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName] || process.env[varName].includes('your_'));

if (missingVars.length > 0) {
  console.error('FileProcessor: Missing required environment variables:', missingVars);
  console.error('FileProcessor: Please check your .env file and add the required API keys');
}

// Now create the clients after environment variables are loaded
let openai, pinecone, index;

try {
  if (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('your_')) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    console.log('FileProcessor: OpenAI client initialized successfully');
  } else {
    console.error('FileProcessor: OpenAI API key is missing or not configured properly');
  }

  if (process.env.PINECONE_API_KEY && !process.env.PINECONE_API_KEY.includes('your_')) {
    pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY
    });
    
    if (process.env.PINECONE_INDEX && !process.env.PINECONE_INDEX.includes('your_')) {
      index = pinecone.index(process.env.PINECONE_INDEX);
      console.log('FileProcessor: Pinecone client initialized successfully');
    } else {
      console.error('FileProcessor: Pinecone index name is missing or not configured properly');
    }
  } else {
    console.error('FileProcessor: Pinecone API key is missing or not configured properly');
  }
} catch (error) {
  console.error('FileProcessor: Error initializing API clients:', error.message);
}

/**
 * Process PDF files and extract text content
 */
const processPDF = async (filePath) => {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    
    return {
      type: 'PDF',
      text: data.text,
      pages: data.numpages,
      metadata: {
        info: data.info,
        pages: data.numpages
      }
    };
  } catch (error) {
    console.error('Error processing PDF:', error);
    throw new Error('Failed to process PDF file');
  }
};

/**
 * Process Excel files and extract data as text
 */
const processExcel = async (filePath) => {
  try {
    const workbook = xlsx.readFile(filePath);
    let extractedText = '';
    let totalRows = 0;
    const sheetsData = [];

    workbook.SheetNames.forEach(sheetName => {
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
      
      // Convert to readable text format
      let sheetText = `\n=== Sheet: ${sheetName} ===\n`;
      jsonData.forEach((row, index) => {
        if (row.length > 0) {
          sheetText += `Row ${index + 1}: ${row.join(' | ')}\n`;
          totalRows++;
        }
      });
      
      extractedText += sheetText;
      sheetsData.push({
        name: sheetName,
        rows: jsonData.length,
        data: jsonData.slice(0, 10) // First 10 rows for preview
      });
    });

    return {
      type: 'Excel',
      text: extractedText,
      sheets: workbook.SheetNames.length,
      totalRows,
      metadata: {
        sheets: sheetsData
      }
    };
  } catch (error) {
    console.error('Error processing Excel:', error);
    throw new Error('Failed to process Excel file');
  }
};

/**
 * Process CSV files and extract data as text
 */
const processCSV = async (filePath) => {
  try {
    return new Promise((resolve, reject) => {
      const results = [];
      let extractedText = '=== CSV Data ===\n';
      let rowCount = 0;

      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => {
          results.push(data);
          rowCount++;
          
          // Convert row to readable text
          const rowText = Object.entries(data)
            .map(([key, value]) => `${key}: ${value}`)
            .join(' | ');
          extractedText += `Row ${rowCount}: ${rowText}\n`;
        })
        .on('end', () => {
          resolve({
            type: 'CSV',
            text: extractedText,
            rows: rowCount,
            metadata: {
              headers: results.length > 0 ? Object.keys(results[0]) : [],
              sampleData: results.slice(0, 5) // First 5 rows for preview
            }
          });
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  } catch (error) {
    console.error('Error processing CSV:', error);
    throw new Error('Failed to process CSV file');
  }
};

/**
 * Main file processor that routes to appropriate handler
 */
export const processFile = async (filePath, originalName) => {
  const ext = path.extname(originalName).toLowerCase();
  
  let processedData;
  
  switch (ext) {
    case '.pdf':
      processedData = await processPDF(filePath);
      break;
    case '.csv':
      processedData = await processCSV(filePath);
      break;
    case '.xlsx':
    case '.xls':
      processedData = await processExcel(filePath);
      break;
    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }

  // Add common metadata
  processedData.originalName = originalName;
  processedData.processedAt = new Date().toISOString();
  processedData.fileSize = fs.statSync(filePath).size;

  return processedData;
};

/**
 * Create embeddings for text chunks and store in Pinecone
 */
export const createDocumentEmbeddings = async (processedData, conversationId) => {
  try {
    // Check if required clients are initialized
    if (!openai) {
      throw new Error('OpenAI client is not initialized. Please check your OPENAI_API_KEY in the .env file.');
    }
    
    if (!index) {
      throw new Error('Pinecone client is not initialized. Please check your PINECONE_API_KEY and PINECONE_INDEX in the .env file.');
    }
    
    const text = processedData.text;
    
    // Split text into chunks (max 8000 characters per chunk for better processing)
    const chunkSize = 8000;
    const chunks = [];
    
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.substring(i, i + chunkSize));
    }

    const vectors = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      // Create embedding
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: chunk,
      });
      
      const embedding = embeddingResponse.data[0].embedding;
      
      // Create unique ID for this chunk
      const vectorId = `conversation_${conversationId}_${processedData.originalName}_chunk_${i}_${Date.now()}`;
      
      vectors.push({
        id: vectorId,
        values: embedding,
        metadata: {
          conversationId,
          fileName: processedData.originalName,
          fileType: processedData.type,
          chunkIndex: i,
          totalChunks: chunks.length,
          text: chunk,
          processedAt: processedData.processedAt
        }
      });
    }

    // Upsert vectors to Pinecone
    if (vectors.length > 0) {
      await index.upsert(vectors);
    }

    return {
      chunksCreated: vectors.length,
      vectorIds: vectors.map(v => v.id)
    };
  } catch (error) {
    console.error('Error creating document embeddings:', error);
    
    // Provide more specific error messages
    if (error.message.includes('OpenAI')) {
      throw new Error('OpenAI API configuration error. Please check your OPENAI_API_KEY in the .env file.');
    } else if (error.message.includes('Pinecone')) {
      throw new Error('Pinecone API configuration error. Please check your PINECONE_API_KEY and PINECONE_INDEX in the .env file.');
    } else if (error.code === 'invalid_api_key') {
      throw new Error('Invalid OpenAI API key. Please check your OPENAI_API_KEY in the .env file.');
    } else {
      throw new Error(`Failed to create document embeddings: ${error.message}`);
    }
  }
};

/**
 * Search for relevant document chunks based on query
 */
export const searchDocumentChunks = async (query, conversationId, topK = 5) => {
  try {
    // console.log('=== DOCUMENT SEARCH DEBUG ===');
    // console.log('Searching documents with:', {
    //   query: query.substring(0, 100) + '...',
    //   conversationId,
    //   conversationIdType: typeof conversationId,
    //   topK
    // });

    // Create embedding for the query
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: query,
    });
    
    const queryEmbedding = embeddingResponse.data[0].embedding;
    
    // Search in Pinecone with conversation filter
    const searchResponse = await index.query({
      vector: queryEmbedding,
      topK,
      includeMetadata: true,
      filter: {
        conversationId: { $eq: conversationId }
      }
    });

    // Keep minimal logging for monitoring
    console.log('Document search results:', {
      totalMatches: searchResponse.matches.length,
      conversationId,
      matchingFiles: searchResponse.matches.map(m => m.metadata?.fileName).filter(Boolean)
    });

    return searchResponse.matches.map(match => ({
      score: match.score,
      fileName: match.metadata.fileName,
      fileType: match.metadata.fileType,
      text: match.metadata.text,
      chunkIndex: match.metadata.chunkIndex
    }));
  } catch (error) {
    console.error('Error searching document chunks:', error);
    throw new Error('Failed to search document chunks');
  }
};

/**
 * Clean up temporary files
 */
export const cleanupFile = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Error cleaning up file:', error);
  }
}; 
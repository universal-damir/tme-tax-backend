// processDocuments.cjs
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const pdfParse = require('pdf-parse-debugging-disabled');
const { OpenAI } = require('openai');
const { Pinecone } = require('@pinecone-database/pinecone');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Pinecone
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

// Configuration
const CONFIG = {
  chunking: {
    maxChunkSize: 1000,
    overlap: 200,
  },
  embedding: {
    model: "text-embedding-ada-002",
    batchSize: 100,
  },
  paths: {
    documentsDir: "./documents",
    processedDir: "./processed",
    hashesFile: "./processed/document_hashes.json"
  }
};

const index = pinecone.index(process.env.PINECONE_INDEX);

// Function to parse PDF files
async function parsePDF(filePath) {
  try {
    console.log(`Attempting to read file: ${filePath}`);
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    if (!fileExists) {
      console.error(`File does not exist: ${filePath}`);
      return null;
    }
    
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    
    // Clean and prepare the text
    const cleanedText = data.text
      .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
      .replace(/[^\x20-\x7E\s]/g, '') // Remove non-printable characters
      .trim();
    
    return {
      text: cleanedText,
      metadata: {
        title: path.basename(filePath, '.pdf'),
        pages: data.numpages,
        source: filePath,
      }
    };
  } catch (error) {
    console.error(`Error parsing PDF ${filePath}:`, error);
    return null;
  }
}

// Function to calculate document hash
async function calculateFileHash(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Functions to load and save document hashes
async function loadProcessedHashes() {
  try {
    const content = await fs.readFile(CONFIG.paths.hashesFile, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    return {};
  }
}

async function saveProcessedHash(filePath, hash) {
  const hashes = await loadProcessedHashes();
  hashes[path.basename(filePath)] = hash;
  await fs.mkdir(path.dirname(CONFIG.paths.hashesFile), { recursive: true });
  await fs.writeFile(CONFIG.paths.hashesFile, JSON.stringify(hashes, null, 2));
}

// Split text into chunks with overlap
function splitIntoChunks(text, maxChunkSize, overlap) {
  const chunks = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + maxChunkSize;
    
    // Try to find a good breaking point (end of sentence)
    if (endIndex < text.length) {
      const nextPeriod = text.indexOf('.', endIndex - 50);
      if (nextPeriod !== -1 && nextPeriod < endIndex + 50) {
        endIndex = nextPeriod + 1;
      }
    }

    chunks.push(text.slice(startIndex, endIndex).trim());
    startIndex = endIndex - overlap;
  }

  return chunks.filter(chunk => chunk.length > 0); // Remove empty chunks
}

// Create embeddings using Gemini
async function createEmbeddings(chunks) {
  const embeddings = [];
  
  for (let i = 0; i < chunks.length; i += CONFIG.embedding.batchSize) {
    const batch = chunks.slice(i, i + CONFIG.embedding.batchSize);
    try {
      const embeddingResults = await Promise.all(
        batch.map(async (chunk) => {
          const response = await openai.embeddings.create({
            model: CONFIG.embedding.model,
            input: chunk,
          });
          return response.data[0].embedding;
        })
      );
      embeddings.push(...embeddingResults);
      console.log(`Processed embeddings batch ${Math.floor(i/CONFIG.embedding.batchSize) + 1} of ${Math.ceil(chunks.length/CONFIG.embedding.batchSize)}`);
    } catch (error) {
      console.error(`Error creating embeddings for batch ${i}:`, error);
      throw error;
    }
  }
  
  return embeddings;
}

// Store document chunks and embeddings in Pinecone
async function storeInPinecone(chunks, embeddings, metadata) {
  const vectors = chunks.map((chunk, i) => {
    // Ensure the embedding exists and is valid
    if (!embeddings[i] || !Array.isArray(embeddings[i])) {
      console.error(`Invalid embedding at index ${i}:`, embeddings[i]);
      throw new Error(`Invalid embedding at index ${i}`);
    }
    
    return {
      id: `${metadata.title.replace(/[^a-zA-Z0-9-_]/g, '_')}-${i}`,
      values: embeddings[i],
      metadata: {
        ...metadata,
        text: chunk,
        chunk_index: i,
      },
    };
  });

  // Upload vectors in batches of 100
  for (let i = 0; i < vectors.length; i += 100) {
    const batch = vectors.slice(i, i + 100);
    try {
      await index.upsert(batch);
      console.log(`Successfully uploaded batch ${Math.floor(i/100) + 1} of ${Math.ceil(vectors.length/100)}`);
    } catch (error) {
      console.error('Error uploading batch:', error);
      console.error('First vector in failed batch:', batch[0]);
      throw error;
    }
  }
}

// Process a single document
async function processDocument(filePath) {
  console.log(`\nProcessing document: ${filePath}`);
  
  try {
    // Calculate file hash
    const fileHash = await calculateFileHash(filePath);
    const processedHashes = await loadProcessedHashes();
    const fileName = path.basename(filePath);
    
    // Check if file was already processed
    if (processedHashes[fileName] === fileHash) {
      console.log(`File ${fileName} was already processed (duplicate detected)`);
      
      // Move to processed directory without processing
      const processedPath = path.join(CONFIG.paths.processedDir, fileName);
      await fs.mkdir(CONFIG.paths.processedDir, { recursive: true });
      await fs.rename(filePath, processedPath);
      
      return;
    }
    
    // Parse PDF
    const document = await parsePDF(filePath);
    if (!document) {
      console.error(`Failed to parse ${fileName}`);
      return;
    }
    
    // Split into chunks
    console.log('Splitting document into chunks...');
    const chunks = splitIntoChunks(
      document.text,
      CONFIG.chunking.maxChunkSize,
      CONFIG.chunking.overlap
    );
    console.log(`Created ${chunks.length} chunks`);
    
    // Create embeddings
    console.log('Creating embeddings...');
    const embeddings = await createEmbeddings(chunks);
    
    // Store in Pinecone
    console.log('Storing in Pinecone...');
    await storeInPinecone(chunks, embeddings, document.metadata);
    
    // Move to processed directory and save hash
    const processedPath = path.join(CONFIG.paths.processedDir, fileName);
    await fs.mkdir(CONFIG.paths.processedDir, { recursive: true });
    await fs.rename(filePath, processedPath);
    await saveProcessedHash(fileName, fileHash);
    
    console.log(`Successfully processed: ${fileName}`);
  } catch (error) {
    console.error(`Error processing document ${filePath}:`, error);
    throw error;
  }
}

// Main processing function
async function processAllDocuments() {
  try {
    await fs.mkdir(CONFIG.paths.documentsDir, { recursive: true });
    
    const files = await fs.readdir(CONFIG.paths.documentsDir);
    const pdfFiles = files
      .filter(file => file.toLowerCase().endsWith('.pdf'))
      .map(file => path.join(CONFIG.paths.documentsDir, file));
    
    if (pdfFiles.length === 0) {
      console.log(`No PDF files found in ${CONFIG.paths.documentsDir}`);
      return;
    }
    
    console.log('Found PDF files:', pdfFiles);
    console.log('Checking for duplicates...');
    
    // Process each document
    for (const file of pdfFiles) {
      try {
        await processDocument(file);
      } catch (error) {
        console.error(`Failed to process ${file}:`, error);
        // Continue with next file instead of stopping the entire process
        continue;
      }
    }
    
    console.log('\nDocument processing completed!');
  } catch (error) {
    console.error('Error processing documents:', error);
    process.exit(1);
  }
}

// Start processing
processAllDocuments();
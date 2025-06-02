import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from root directory
if (process.env.NODE_ENV !== 'production') {
  const envPath = path.resolve(__dirname, '..', '.env');
  console.log('Loading .env from:', envPath);
  const result = dotenv.config({ path: envPath, debug: true });
  if (result.error) {
    console.warn('Error loading .env file:', result.error);
  }
}

// Initialize Pinecone
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

const index = pinecone.index(process.env.PINECONE_INDEX);

/**
 * Clean up vectors that have userId as conversationId
 * These are vectors that were incorrectly stored before the fix
 */
async function cleanupIncorrectVectors() {
  try {
    console.log('Starting cleanup of incorrectly stored vectors...');
    
    // List of known userIds that might have been used as conversationId
    // You can add your actual userIds here
    const knownUserIds = ['1', '2', '3', '4']; // Add your actual user IDs
    
    for (const userId of knownUserIds) {
      console.log(`Checking for vectors with userId ${userId} as conversationId...`);
      
      try {
        // Query vectors that have this userId as conversationId
        const queryResponse = await index.query({
          vector: new Array(1536).fill(0), // Dummy vector for querying
          topK: 10000, // Get many results
          includeMetadata: true,
          filter: {
            conversationId: { $eq: userId }
          }
        });
        
        if (queryResponse.matches && queryResponse.matches.length > 0) {
          console.log(`Found ${queryResponse.matches.length} vectors with userId ${userId} as conversationId`);
          
          // Extract vector IDs to delete
          const vectorIds = queryResponse.matches.map(match => match.id);
          
          // Log the files that will be deleted
          const fileNames = [...new Set(queryResponse.matches.map(match => match.metadata?.fileName).filter(Boolean))];
          console.log('Files that will be removed:', fileNames);
          
          // Delete these vectors in batches
          const batchSize = 100;
          for (let i = 0; i < vectorIds.length; i += batchSize) {
            const batch = vectorIds.slice(i, i + batchSize);
            await index.deleteMany(batch);
            console.log(`Deleted batch ${Math.floor(i/batchSize) + 1} of ${Math.ceil(vectorIds.length/batchSize)}`);
          }
          
          console.log(`Successfully deleted ${vectorIds.length} vectors for userId ${userId}`);
        } else {
          console.log(`No vectors found with userId ${userId} as conversationId`);
        }
      } catch (error) {
        console.error(`Error processing userId ${userId}:`, error);
      }
    }
    
    console.log('Cleanup completed successfully!');
    
  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  }
}

/**
 * Alternative cleanup method: Delete vectors by filename pattern
 * Use this if you know the specific filename that's causing issues
 */
async function cleanupByFilename(filename) {
  try {
    console.log(`Cleaning up vectors for filename: ${filename}`);
    
    // Query vectors that contain this filename
    const queryResponse = await index.query({
      vector: new Array(1536).fill(0), // Dummy vector for querying
      topK: 10000,
      includeMetadata: true,
      filter: {
        fileName: { $eq: filename }
      }
    });
    
    if (queryResponse.matches && queryResponse.matches.length > 0) {
      console.log(`Found ${queryResponse.matches.length} vectors for filename ${filename}`);
      
      // Extract vector IDs to delete
      const vectorIds = queryResponse.matches.map(match => match.id);
      
      // Delete these vectors in batches
      const batchSize = 100;
      for (let i = 0; i < vectorIds.length; i += batchSize) {
        const batch = vectorIds.slice(i, i + batchSize);
        await index.deleteMany(batch);
        console.log(`Deleted batch ${Math.floor(i/batchSize) + 1} of ${Math.ceil(vectorIds.length/batchSize)}`);
      }
      
      console.log(`Successfully deleted ${vectorIds.length} vectors for filename ${filename}`);
    } else {
      console.log(`No vectors found for filename ${filename}`);
    }
    
  } catch (error) {
    console.error('Error during filename cleanup:', error);
    throw error;
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length > 0 && args[0] === '--filename') {
    if (args[1]) {
      await cleanupByFilename(args[1]);
    } else {
      console.error('Please provide a filename: node cleanupPinecone.mjs --filename "trial balance-1.xlsx"');
    }
  } else {
    await cleanupIncorrectVectors();
  }
}

// Run the cleanup
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { cleanupIncorrectVectors, cleanupByFilename }; 
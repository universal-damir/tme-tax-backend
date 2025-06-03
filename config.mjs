import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Database configuration
const isProduction = process.env.NODE_ENV === 'production';

// Get database configuration from environment variables
const dbUser = process.env.PGUSER;
const dbPassword = process.env.POSTGRES_PASSWORD;
const dbHost = process.env.PGHOST;
const dbPort = process.env.PGPORT;
const dbName = process.env.PGDATABASE;

// Construct the connection string using environment variables
const connectionString = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

console.log('Using connection string:', connectionString.replace(/:[^:@]+@/, ':****@'));

// Export database configuration
export const dbConfig = {
  user: dbUser,
  password: dbPassword,
  host: dbHost,
  port: dbPort,
  database: dbName,
  ssl: isProduction ? {
    rejectUnauthorized: true,
    // Railway PostgreSQL uses self-signed certificates, so we need to handle this properly
    checkServerIdentity: () => undefined
  } : false
};

// Other configurations
export const config = {
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  openaiApiKey: process.env.OPENAI_API_KEY,
  pineconeApiKey: process.env.PINECONE_API_KEY,
  pineconeIndex: process.env.PINECONE_INDEX,
  allowedOrigins: ['https://taxgpt.netlify.app', 'http://localhost:3001']
}; 
import { Pool } from 'pg';

// Create a singleton database pool for Vercel serverless functions
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    
    if (!databaseUrl) {
      const errorMsg = 'DATABASE_URL or POSTGRES_URL environment variable is not set';
      console.error(errorMsg);
      console.error('Available env vars:', Object.keys(process.env).filter(k => k.includes('DB') || k.includes('POST') || k.includes('DATABASE')));
      throw new Error(errorMsg);
    }

    // Clean up connection string (remove quotes if present, handle special formatting)
    let cleanUrl = databaseUrl.trim();
    if (cleanUrl.startsWith('"') || cleanUrl.startsWith("'")) {
      cleanUrl = cleanUrl.slice(1, -1);
    }
    
    // Remove psql wrapper if present (from .env file format)
    if (cleanUrl.startsWith("psql '")) {
      cleanUrl = cleanUrl.replace(/^psql ['"]/, '').replace(/['"]$/, '');
    }

    console.log('Connecting to database...', cleanUrl.substring(0, 20) + '...');

    pool = new Pool({
      connectionString: cleanUrl,
      ssl: {
        rejectUnauthorized: false
      },
      max: 10, // Allow more concurrent connections for better performance under load
      min: 0,  // Don't maintain idle connections in serverless (cold starts don't need connections)
      idleTimeoutMillis: 10000, // Shorter timeout for serverless (connections close faster when idle)
      connectionTimeoutMillis: 5000,
    });

    // Handle pool errors
    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }

  return pool;
}

// Helper function to execute queries with automatic error handling
export async function query(text: string, params?: any[]) {
  const pool = getPool();
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(text, params);
    return result;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Database query error:', errorMessage);
    console.error('Query:', text.substring(0, 100));
    if (params) {
      console.error('Params:', params);
    }
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}


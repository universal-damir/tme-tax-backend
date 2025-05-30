# Safe Deployment Guide

## ⚠️ CRITICAL: Preventing Data Loss

This application now includes safeguards to prevent accidental data loss in production. Please follow these guidelines:

## Database Initialization

### ✅ Safe Mode (Default)
The application now uses `initDbSafe()` which:
- Creates tables only if they don't exist (`CREATE TABLE IF NOT EXISTS`)
- Never drops existing data
- Only inserts default users if the users table is empty
- Safe for production deployments

### ❌ Destructive Mode (Development Only)
The old `initDb()` function:
- Drops all existing tables and data
- Should NEVER be used in production
- Only for development/testing when you want to reset everything

## Production Deployment Checklist

1. **Environment Variables**: Ensure `NODE_ENV=production` is set
2. **Database**: The application will safely create tables if they don't exist
3. **No Manual DB Reset**: Never call `initDb()` in production
4. **Backup**: Always backup your database before major deployments

## Emergency Database Reset (⚠️ DATA LOSS)

If you absolutely need to reset the production database (THIS WILL DELETE ALL DATA):

1. Set environment variable: `FORCE_DB_RESET=true`
2. Manually call the reset endpoint or function
3. **ALL CHAT DATA WILL BE PERMANENTLY LOST**

## Monitoring

The application logs will show:
- `"Database already initialized, skipping table creation to preserve existing data"` - Normal, safe operation
- `"Database tables not found, initializing for the first time..."` - First-time setup
- `"CRITICAL WARNING: Attempted to reset database in production"` - Blocked dangerous operation

## What Was Fixed

### Before (Dangerous):
```javascript
// This was called on every server restart, destroying all data
initDb().catch(console.error);
```

### After (Safe):
```javascript
// This only creates tables if they don't exist
const initializeDatabase = async () => {
  // Check if tables exist first
  // Only create if missing
  // Preserve all existing data
};
```

## Authentication Improvements

- Removed fallback userId='1' that could cause data mixing
- Proper redirect to login when authentication fails
- Better error handling for expired sessions 
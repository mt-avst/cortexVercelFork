# Demo Server

This directory contains demo/testing artifacts that were moved from the main backend source code for production readiness.

## Files

- `demo-server.ts` - Standalone demo server with mock authentication and API endpoints
- `mock-data.ts` - Mock data service for development when database is not available

## Usage

These files are kept for development and testing purposes but are not part of the production application.

To run the demo server:
```bash
cd demo
tsx demo-server.ts
```

## Note

This demo server provides mock authentication and API responses for development and testing. It should not be used in production environments.

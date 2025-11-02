# Adaptalabs Recruitment App

An internal recruitment application for Adaptalabs that allows researchers to post opportunities and employees to browse and book sessions.

## Features (M1 - Auth and Roles)

- ✅ SSO authentication with OpenID Connect
- ✅ Role-based access control (visitor, employee, researcher admin)
- ✅ Secure session management
- ✅ `/api/me` endpoint for user information
- ✅ Admin role seeding from environment variables

## Project Structure

```
/backend          - Express.js API server
/frontend         - React TypeScript frontend
```

## Prerequisites

- Node.js 16+ 
- PostgreSQL 12+
- OIDC provider (company SSO)
- Docker and Docker Compose (for containerized development)

## Setup

### Option 1: Docker Development (Recommended)

The easiest way to get started is using Docker Compose:

```bash
# Clone and navigate to the project
cd adaptalabs-recruitment-app

# Copy environment template
cp docker.env.example .env
# Edit .env with your configuration

# Start all services
docker-compose up --build

# In another terminal, run database migrations
docker-compose exec backend npm run migrate
docker-compose exec backend npm run seed
```

This will start:
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001  
- **PostgreSQL**: localhost:5432

### Option 2: Local Development

#### 1. Database Setup

Create a PostgreSQL database:

```sql
CREATE DATABASE adaptalabs;
```

#### 2. Backend Setup

```bash
cd backend
npm install
cp env.example .env
# Edit .env with your configuration
npm run migrate
npm run seed
npm run dev
```

#### 3. Frontend Setup

```bash
cd frontend
npm install
cp env.example .env
# Edit .env if needed
npm start
```

## Environment Variables

### Backend (.env)

```env
NODE_ENV=development
PORT=3001
DATABASE_URL=postgresql://user:pass@localhost:5432/adaptalabs
SESSION_SECRET=your_random_session_secret_here
OIDC_ISSUER=https://your-idp.com
OIDC_CLIENT_ID=your_client_id
OIDC_CLIENT_SECRET=your_client_secret
OIDC_REDIRECT_URL=http://localhost:3001/auth/callback
ADMIN_EMAILS=admin1@company.com,admin2@company.com
CORS_ORIGIN=http://localhost:3000
```

### Frontend (.env)

```env
REACT_APP_API_URL=http://localhost:3001
```

## Development

### Docker Commands

```bash
# Start all services
docker-compose up

# Start in background
docker-compose up -d

# Rebuild and start
docker-compose up --build

# Stop all services
docker-compose down

# View logs
docker-compose logs -f [service-name]

# Execute commands in running containers
docker-compose exec backend npm run migrate
docker-compose exec backend npm run seed
docker-compose exec frontend npm test

# Clean up (removes volumes)
docker-compose down -v
```

### Backend Commands

```bash
# Local development
npm run dev          # Start development server with hot reload
npm run build        # Build for production
npm run migrate      # Run database migrations
npm run seed         # Seed admin users

# Docker development
docker-compose exec backend npm run dev
docker-compose exec backend npm run migrate
docker-compose exec backend npm run seed
```

### Frontend Commands

```bash
# Local development
npm start            # Start development server
npm run build        # Build for production
npm test             # Run tests

# Docker development
docker-compose exec frontend npm test
```

## API Endpoints

### Authentication
- `GET /auth/login` - Initiate OIDC login
- `GET /auth/callback` - OIDC callback handler
- `POST /auth/logout` - Logout and destroy session

### API
- `GET /api/me` - Get current user information (requires auth)

### Admin Utilities
- `POST /api/admin/reset-demo-data` - **Reset Demo Data Script** (Admin only)
  - Clears all bookings, sessions, and opportunities
  - Creates 6 new demo opportunities (2 test, 2 poll, 2 survey) **WITHOUT sessions**
  - Useful for clearing all timeslot availability and starting fresh
  - Usage: Call via `POST` request as an authenticated admin user
  - Example (from browser console when logged in as admin):
    ```javascript
    fetch('/api/admin/reset-demo-data', { method: 'POST', credentials: 'include' })
      .then(res => res.json())
      .then(data => console.log(data));
    ```

## Security Features

- ✅ Helmet.js security headers
- ✅ CORS configuration
- ✅ Rate limiting on auth routes
- ✅ Secure session cookies
- ✅ CSRF protection ready
- ✅ Input validation

## Testing

### Backend Tests
```bash
cd backend
npm test
```

### Frontend Tests
```bash
cd frontend
npm test
```

## Deployment

### Docker Production Deployment

For production deployment, you can use the same Docker setup with production environment variables:

```bash
# Set production environment
export NODE_ENV=production

# Update docker-compose.yml for production
# - Remove volume mounts for source code
# - Use production database URL
# - Set proper environment variables

# Deploy
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Production Environment Variables

Ensure these are set in production:

- `NODE_ENV=production`
- `SESSION_SECRET` - Strong random secret
- `DATABASE_URL` - Production database
- `OIDC_*` - Production OIDC configuration
- `CORS_ORIGIN` - Production frontend URL
- `GOOGLE_SERVICE_ACCOUNT_JSON` - Production Google Calendar credentials
- `EMAIL_*` - Production email configuration

### Security Checklist

- [ ] Strong session secret
- [ ] HTTPS enabled
- [ ] Secure cookie flags
- [ ] Database credentials secured
- [ ] OIDC client secrets secured

## Next Milestones

- **M2**: Opportunities CRUD and public browsing
- **M3**: Sessions and capacity management  
- **M4**: Booking, reschedule, cancel flows
- **M5**: Google Calendar integration
- **M6**: Polls and surveys with external links
- **M7**: Dashboard and admin settings
- **M8**: Branding and accessibility

## Troubleshooting

### Docker Issues

1. **Services won't start**
   ```bash
   # Check if ports are already in use
   lsof -i :3000 -i :3001 -i :5432
   
   # Rebuild containers
   docker-compose down
   docker-compose up --build
   ```

2. **Database connection issues**
   ```bash
   # Check if postgres container is healthy
   docker-compose ps
   
   # View postgres logs
   docker-compose logs postgres
   
   # Connect to database directly
   docker-compose exec postgres psql -U postgres -d adaptalabs_dev
   ```

3. **Frontend build fails**
   ```bash
   # Check frontend logs
   docker-compose logs frontend
   
   # Rebuild frontend only
   docker-compose build frontend
   ```

4. **Backend build fails**
   ```bash
   # Check backend logs
   docker-compose logs backend
   
   # Rebuild backend only
   docker-compose build backend
   ```

### Common Issues

1. **Database connection failed**
   - Check `DATABASE_URL` format
   - Ensure PostgreSQL is running
   - Verify database exists
   - For Docker: ensure postgres service is healthy

2. **OIDC login fails**
   - Verify `OIDC_ISSUER` is correct
   - Check `OIDC_REDIRECT_URL` matches provider config
   - Ensure client credentials are correct

3. **CORS errors**
   - Check `CORS_ORIGIN` matches frontend URL
   - Verify frontend proxy configuration
   - For Docker: ensure services are on same network

### Logs

Backend logs are written to console. In production, consider using a proper logging service.

## Contributing

1. Follow the milestone structure
2. Write tests for new features
3. Update documentation
4. Follow security best practices

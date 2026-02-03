# Adaptalabs Recruitment App

An internal recruitment application for Adaptalabs that allows researchers to post opportunities and employees to browse and book sessions.

## Features (M1 - Auth and Roles)

- ✅ SSO authentication with OpenID Connect
- ✅ Role-based access control (visitor, employee, researcher admin)
- ✅ Secure session management
- ✅ `/api/me` endpoint for user information
- ✅ Admin role seeding from environment variables

## M6 - Polls, Surveys & Analytics

- **Opportunity types**: `poll`, `survey`, `unmoderated` (external links); `test`, `interview` (bookable sessions). Admins create and publish; employees see and click.
- **Click tracking**: Two levels — **view** (opened study details) and **action** (clicked "Open Poll/Survey" or "Book Session"). IP is hashed for privacy.
- **Analytics API** (admin/owner only):
  - `GET /api/opportunities/[id]/analytics?period=7|14|30` — Returns views/actions counts and time-series for the given period (default 30 days).
  - `POST /api/opportunities/[id]/click` — Body: `{ "click_type": "view" | "action" }`. Optional auth; used by frontend when user views or clicks the action button.
- **E2E**: `e2e/m6-poll-click-tracking.test.ts` — full flow and optional analytics check. See **README_M6.md** for env, error handling, and verification steps.

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

### E2E Tests (Playwright)

```bash
# From project root - start dev servers first
npm run dev:all      # In one terminal
npm run test:admin-create-study   # In another - admin create study flow
npm run test:e2e     # Full E2E suite (starts its own servers)
```

The **admin create study** test verifies: login → create poll study → submit → study appears in list. Uses `admin-login` (seeded researcher_admin). Run `npm run seed` in backend to ensure admin/superadmin users exist.

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

## 📚 Documentation

### For Users
- **[User Guide](USER_GUIDE.md)** - Complete guide for end users
- **[Alpha Tester Quick Start](ALPHA_TESTER_QUICK_START.md)** - Quick start guide for alpha testers

### For Admins
- **[Admin Guide](ADMIN_GUIDE.md)** - Complete guide for researcher admins

### For Developers
- **[Plan](plan.md)** - Original project plan and requirements
- **[Core](core.md)** - Core architecture and data model

### Testing & Status
- **[Alpha Testing Readiness](ALPHA_TESTING_READINESS.md)** - Comprehensive alpha readiness checklist
- **[End-to-End Testing Checklist](END_TO_END_TESTING_CHECKLIST.md)** - Testing scenarios and checklist
- **[Known Issues](KNOWN_ISSUES.md)** - Known issues, limitations, and workarounds
- **[Plan Status Report](PLAN_STATUS_REPORT.md)** - Current milestone completion status

## Current Status

**Version**: 7.3.1  
**Status**: ✅ Production Ready - Alpha Testing Phase  
**Deployment**: https://adapta-labs-p62q.vercel.app

### Milestones Completed
- ✅ **M1**: Auth and Roles
- ✅ **M2**: Opportunities
- ✅ **M3**: Sessions
- ✅ **M4**: Booking
- ✅ **M5**: Calendar
- ✅ **M6**: Polls and Surveys
- ✅ **M7**: Dashboard and Settings
- ✅ **M8**: Branding and Accessibility (WCAG 2.2 AA)

## Next Milestones
- **Future**: Advanced analytics, export functionality, enhanced reporting

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

## Alpha Testing

AdaptaLabs is currently in **alpha testing phase**. 

### For Alpha Testers
- Start with the **[Alpha Tester Quick Start](ALPHA_TESTER_QUICK_START.md)**
- Read the **[User Guide](USER_GUIDE.md)** for detailed instructions
- Check **[Known Issues](KNOWN_ISSUES.md)** for limitations and workarounds
- Use the **"Send Feedback"** link in the app to report issues

### Feedback & Support
- **Feedback Form**: Header dropdown → "Send Feedback"; or use the feedback footer on every page.
- **Service Desk**: https://adaptavistlabs.atlassian.net/servicedesk/customer/portal/80
- **Email**: nfine@adaptavist.com

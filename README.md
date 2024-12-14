# SoarAPI

WebSocket-based API for SoarClient premium user management.

## Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and configure your settings
5. Start the server: `npm start`

## Environment Variables

- `ADMIN_KEY`: Admin panel access key
- `PORT`: Server port (default: 8080)

## API Endpoints

### WebSocket
- `/websocket` - Main WebSocket connection endpoint

### HTTP
- `/v1/handshake` - API health check
- `/v1/user/isSpecialUser` - Check user premium status
- `/admin` - Admin panel interface

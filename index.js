// Core imports
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const uuid = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');

// Constants
const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY;
const USERS_DB_PATH = path.join(__dirname, 'usersDb.json');
const VALID_ROLES = ['Normal', 'Premium', 'Staff', 'Famous', 'Owner'];
const WS_HEARTBEAT_INTERVAL = 30000;

// Logger setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
            let msg = `${timestamp} [${level}]: ${message}`;
            if (Object.keys(meta).length) msg += ` ${JSON.stringify(meta)}`;
            return msg;
        })
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error', format: winston.format.json() }),
        new winston.transports.File({ filename: 'combined.log', format: winston.format.json() }),
        new winston.transports.Console()
    ]
});

// Database operations
async function loadDatabase(dbPath) {
    try {
        const data = await fs.readFile(dbPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info(`Database file not found. Creating new file: ${dbPath}`);
            await fs.writeFile(dbPath, '{}');
            return {};
        }
        throw error;
    }
}

async function saveDatabase(dbPath, data) {
    await fs.writeFile(dbPath, JSON.stringify(data, null, 2));
}

// Express setup
const app = express();
const server = http.createServer(app);
app.use(express.json());

// WebSocket setup
const wss = new WebSocket.Server({ server, path: '/websocket' });

// Add after the WebSocket setup
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Add this function to help with cleanup
function cleanupDeadConnections() {
    for (const [ws, userData] of connectedUsers) {
        if (ws.readyState !== WebSocket.OPEN) {
            connectedUsers.delete(ws);
            logger.info(`Cleaned up dead connection for user: ${userData.uuid}`);
        }
    }
}

function handleConsoleCommands() {
    rl.question('', (input) => {
        const [command, ...args] = input.trim().split(' ');
        
        switch(command) {
            case 'broadcast':
                const message = args.join(' ');
                broadcastMessage('server_message', { message });
                logger.info(`Broadcasted message: ${message}`);
                break;
            
            case 'users':
                console.log('\nConnected users:');
                wss.clients.forEach(client => {
                    const userData = connectedUsers.get(client);
                    if (userData && client.readyState === WebSocket.OPEN) {
                        console.log(`${userData.name} (${userData.uuid}): ${userData.role}`);
                    }
                });
                console.log(`\nTotal: ${wss.clients.size} user(s) connected\n`);
                break;

            case 'help':
                console.log('\nAvailable commands:');
                console.log('broadcast <message> - Send message to all connected clients');
                console.log('users - List all connected users');
                console.log('help - Show this help message\n');
                break;

            default:
                if (command) console.log('Unknown command. Type "help" for available commands.');
                break;
        }
        
        handleConsoleCommands(); // Continue listening for commands
    });
}

// Data structures
const connectedUsers = new Map(); // Map of ws (WebSocket) -> userData

// WebSocket message handlers
function broadcastUserData() {
    const premiumUsers = Object.entries(usersDb).map(([uuid, userData]) => ({
        name: userData.name || 'Unknown',
        uuid: uuid,
        role: userData.role || 'Premium'
    }));

    broadcastMessage('sws-soar-user-data', { users: premiumUsers });
}

function broadcastMessage(type, data) {
    const message = JSON.stringify({ type, ...data });
    const sent = new Set(); // Track unique clients
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && !sent.has(client)) {
            client.send(message);
            sent.add(client);
        }
    });
}

function updateUserStatus(userUuid, changes) {
    // Update database
    if (changes.remove) {
        delete usersDb[userUuid];
    } else {
        usersDb[userUuid] = {
            ...(usersDb[userUuid] || {}),
            name: changes.name || usersDb[userUuid]?.name || 'Unknown',
            role: changes.role || usersDb[userUuid]?.role || 'Premium'
        };
    }

    // Update connected user if online
    connectedUsers.forEach((userData, ws) => {
        if (userData.uuid === userUuid) {
            if (changes.remove) {
                userData.role = 'Normal';
            } else {
                userData.role = changes.role || userData.role;
            }
            ws.send(JSON.stringify({ 
                type: 'role_update',
                role: userData.role
            }));

            // Send notification about role change
            ws.send(JSON.stringify({
                type: 'server_message',
                message: `Your role has been updated to ${userData.role}.`
            }));
        }
    });

    // Save and broadcast
    saveDatabase(USERS_DB_PATH, usersDb);
    broadcastUserData();
}

// WebSocket connection handling
wss.on('connection', async (ws, req) => {
    const ip = req.socket.remoteAddress;
    ws.isAlive = true;

    ws.send(JSON.stringify({ type: 'request_uuid' }));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'user_uuid') {
                const { uuid: userUuid, name } = data;
                
                // Close any existing connections for this UUID first
                for (const [existingWs, existingData] of connectedUsers) {
                    if (existingData.uuid === userUuid) {
                        existingWs.terminate();
                        connectedUsers.delete(existingWs);
                        logger.info(`Closed duplicate connection for UUID=${userUuid}`);
                    }
                }

                const userData = usersDb[userUuid];
                const role = userData?.role || 'Normal';
                
                connectedUsers.set(ws, { 
                    uuid: userUuid, 
                    name, 
                    role
                });

                // Send immediate role update
                ws.send(JSON.stringify({ 
                    type: 'role_update',
                    role
                }));

                // Send welcome message
                ws.send(JSON.stringify({
                    type: 'server_message',
                    message: 'Welcome to Soar Socket!'
                }));

                // Broadcast updated user list
                broadcastUserData();
                logger.info(`User connected: UUID=${userUuid}, Role=${role}, IP=${ip}`);
            }
        } catch (error) {
            logger.error(`WebSocket error: ${error.message}`);
        }
    });

    ws.on('pong', () => (ws.isAlive = true));

    ws.on('close', () => {
        const userData = connectedUsers.get(ws);
        if (userData) {
            logger.info(`User disconnected: UUID=${userData.uuid}, IP=${ip}`);
            connectedUsers.delete(ws);
            cleanupDeadConnections(); // Clean up any other dead connections
        }
    });

    ws.on('error', (error) => {
        logger.error(`WebSocket error for ${ip}:`, error);
    });
});

// Basic Routes
app.get('/v1/handshake', (req, res) => {
    res.json({ success: true, message: 'Handshake successful' });
});

// User Routes
app.get('/v1/user/isSpecialUser', async (req, res) => {
    const userUuid = req.query.uuid;
    const userRole = usersDb[userUuid]?.role || 'Normal';
    const isSpecial = userRole !== 'Normal';
    res.json({ success: true, special: isSpecial });
});

// Shop Routes
app.get('/v1/shop/createPremium', async (req, res) => {
    const { name, uuid: userUuid } = req.query;
    const link = `https://shop.soarclient.com/premium/${uuid.v4()}`;
    
    // Preserve existing role or set to Premium
    const existingRole = usersDb[userUuid]?.role || 'Premium';
    usersDb[userUuid] = { name, role: existingRole };
    await saveDatabase(USERS_DB_PATH, usersDb);

    // Update connected user if they're online
    connectedUsers.forEach((userData, clientWs) => {
        if (userData.uuid === userUuid) {
            userData.isPremium = true;
            userData.role = existingRole;
            clientWs.send(JSON.stringify({ 
                type: 'role_update',
                isPremium: true,
                role: existingRole
            }));
        }
    });

    broadcastUserData();
    res.json({ success: true, url: link });
});

// Admin Routes
app.post('/v1/admin/verify', (req, res) => {
    const { adminKey: providedAdminKey } = req.body;
    if (providedAdminKey !== ADMIN_KEY) {
        return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }
    res.json({ success: true, message: 'Admin key verified' });
});

app.post('/v1/admin/addSpecialUser', async (req, res) => {
    const { uuid: userUuid, adminKey: providedAdminKey } = req.body;
    if (providedAdminKey !== ADMIN_KEY) {
        return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    updateUserStatus(userUuid, { role: 'Premium' });
    res.json({ success: true, message: 'User added as premium user' });
});

app.get('/v1/admin/premiumUsers', (req, res) => {
    const { adminKey: providedAdminKey } = req.query;
    if (providedAdminKey !== ADMIN_KEY) {
        return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }
    const specialUsers = Object.entries(usersDb)
        .filter(([_, userData]) => userData.role && userData.role !== 'Normal')
        .map(([uuid, userData]) => ({
            uuid,
            name: userData.name || 'Unknown',
            role: userData.role
        }));
    res.json({ success: true, users: specialUsers });
});

app.post('/v1/admin/removePremium', async (req, res) => {
    const { uuid: userUuid, adminKey: providedAdminKey } = req.body;
    if (providedAdminKey !== ADMIN_KEY) {
        return res.status(403).json({ success: false, message: 'Invalid admin key' });
    }

    updateUserStatus(userUuid, { remove: true });
    res.json({ success: true, message: 'Premium status removed' });
});

app.post('/v1/admin/updateUserRole', async (req, res) => {
    const { uuid: userUuid, role, adminKey: providedAdminKey } = req.body;
    if (providedAdminKey !== ADMIN_KEY || !VALID_ROLES.includes(role)) {
        return res.status(403).json({ success: false, message: 'Invalid request' });
    }

    updateUserStatus(userUuid, { role });
    res.json({ success: true, message: 'User role updated' });
});

// Static routes
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '/public', 'admin.html'));
});

// Initialize database and start server
let usersDb;
(async () => {
    usersDb = await loadDatabase(USERS_DB_PATH);
    server.listen(PORT, () => {
        logger.info(`Server running at http://localhost:${PORT}`);
        console.log('\nServer console ready. Type "help" for available commands.\n');
        handleConsoleCommands();
    });
})();

// WebSocket heartbeat
const heartbeatInterval = setInterval(() => {
    cleanupDeadConnections(); // Clean up before checking heartbeats
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            const userData = connectedUsers.get(ws);
            connectedUsers.delete(ws);
            ws.terminate();
            if (userData) {
                logger.info(`User disconnected due to heartbeat timeout: UUID=${userData.uuid}`);
            }
            return;
        }
        ws.isAlive = false;
        ws.ping(() => {});
    });
}, WS_HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeatInterval));

// Error handling
process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Closing server...');
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
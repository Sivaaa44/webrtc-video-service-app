const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');
const os = require('os'); 

const app = express();
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/client.html');
});
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server,
    clientTracking: true
});

app.use(cors());
app.use(express.static('public'));
app.use(cors({
    origin: '*', // Be more restrictive in production
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

// Store active connections
const rooms = new Map();
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            // Skip internal (i.e. 127.0.0.1) and non-IPv4 addresses
            if (interface.family === 'IPv4' && !interface.internal) {
                return interface.address;
            }
        }
    }
    return '0.0.0.0'; // Fallback
}

// Utility function to broadcast room status
function broadcastRoomStatus(roomId) {
    const room = rooms.get(roomId);
    if (room) {
        const status = {
            type: 'roomStatus',
            participants: room.size
        };
        room.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(status));
            }
        });
    }
}

wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        console.log('Received message:', data.type, 'for room:', data.room);
        
        switch(data.type) {
            case 'join':
                console.log(`Client joining room: ${data.room}`);
                if (!rooms.has(data.room)) {
                    console.log(`Creating new room: ${data.room}`);
                    rooms.set(data.room, new Set());
                }
                rooms.get(data.room).add(ws);
                ws.room = data.room;
                broadcastRoomStatus(data.room);
                break;
                
            case 'signal':
                console.log(`Forwarding ${data.signal.type} signal in room: ${data.room}`);
                const room = rooms.get(data.room);
                if (room) {
                    room.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(data.signal));
                        }
                    });
                }
                break;
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected from room: ${ws.room}`);
        if (ws.room && rooms.has(ws.room)) {
            rooms.get(ws.room).delete(ws);
            if (rooms.get(ws.room).size === 0) {
                console.log(`Removing empty room: ${ws.room}`);
                rooms.delete(ws.room);
            } else {
                broadcastRoomStatus(ws.room);
            }
        }
    });
});

const ip = getLocalIP();
server.listen(8080, '0.0.0.0', () => {
    console.log(`Server running on http://${ip}:8080`);
    console.log(`WebSocket server running on ws://${ip}:8080`);
    console.log('Share this IP address with others to connect');
});
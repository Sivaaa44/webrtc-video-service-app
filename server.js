const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

// Store active connections
const rooms = new Map();

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

server.listen(8080, () => {
    console.log('Server running on port 8080');
    console.log('WebRTC signaling server is ready');
});
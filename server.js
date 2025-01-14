const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

// Store active connections
const rooms = new Map();

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        switch(data.type) {
            case 'join':
                // Store connection in room
                if (!rooms.has(data.room)) {
                    rooms.set(data.room, new Set());
                }
                rooms.get(data.room).add(ws);
                ws.room = data.room;
                break;
                
            case 'signal':
                // Forward the signaling data to other peers in the room
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
        if (ws.room && rooms.has(ws.room)) {
            rooms.get(ws.room).delete(ws);
            if (rooms.get(ws.room).size === 0) {
                rooms.delete(ws.room);
            }
        }
    });
});

server.listen(8080, () => {
    console.log('Server running on port 8080');
});
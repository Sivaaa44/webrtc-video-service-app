const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function logSessionStatus() {
    console.log('\n=== ACTIVE SESSIONS ===');
    roomSessions.forEach((sessionSet, roomId) => {
        console.log(`\nROOM: ${roomId}`);
        sessionSet.forEach(sessionId => {
            const session = sessions.get(sessionId);
            if (session) {
                const participants = Array.from(session.participants.keys());
                console.log(`  Session ${sessionId}: ${participants.length} participants`);
                participants.forEach(userId => {
                    console.log(`    - User ${userId}`);
                });
            }
        });
    });
    console.log('\n===================\n');
}

class Session {
    constructor(roomId) {
        this.id = Math.random().toString(36).substring(7);
        this.roomId = roomId;
        this.participants = new Map();
        this.maxParticipants = 2;
        this.lastActivity = Date.now();
    }

    addParticipant(userId, ws) {
        if (this.participants.size >= this.maxParticipants) {
            throw new Error('Session is full');
        }

        this.participants.set(userId, ws);
        ws.sessionId = this.id;
        ws.userId = userId;
        this.lastActivity = Date.now();

        // Notify existing participants about the new peer
        this.broadcast({
            type: 'newPeer',
            userId: userId
        }, userId);

        // Send current participants to new user
        const existingParticipants = Array.from(this.participants.keys())
            .filter(id => id !== userId);

        ws.send(JSON.stringify({
            type: 'sessionInfo',
            sessionId: this.id,
            peers: existingParticipants
        }));

        console.log(`\n➡️ User ${userId} joined Room ${this.roomId}`);
        logSessionStatus();
    }

    removeParticipant(userId) {
        this.participants.delete(userId);
        this.lastActivity = Date.now();

        // Notify others about participant leaving
        this.broadcast({
            type: 'peerLeft',
            userId: userId
        });

        console.log(`\n⬅️ User ${userId} left Room ${this.roomId}`);
        logSessionStatus();

        return this.participants.size === 0;
    }

    broadcast(message, excludeUserId = null) {
        const messageStr = JSON.stringify(message);
        this.participants.forEach((ws, userId) => {
            if (userId !== excludeUserId && ws.readyState === WebSocket.OPEN) {
                ws.send(messageStr);
            }
        });
    }

    isAvailable() {
        return this.participants.size < this.maxParticipants;
    }

    isExpired(timeoutMs = 3600000) { // 1 hour default timeout
        return this.participants.size === 0 &&
            (Date.now() - this.lastActivity) > timeoutMs;
    }
}

// Session management
const sessions = new Map();
const roomSessions = new Map();

function findOrCreateSession(roomId) {
    // Look for an existing session in the room
    let roomSessionList = roomSessions.get(roomId);

    if (!roomSessionList) {
        roomSessionList = new Set();
        roomSessions.set(roomId, roomSessionList);
    }

    // Find available session in the room
    for (const sessionId of roomSessionList) {
        const session = sessions.get(sessionId);
        if (session && session.isAvailable()) {
            return session;
        }
    }

    // Create new session if none available
    const session = new Session(roomId);
    sessions.set(session.id, session);
    roomSessionList.add(session.id);
    console.log(`Created new session ${session.id} in room ${roomId}`);
    return session;
}

// Cleanup expired sessions periodically
setInterval(() => {
    for (const [sessionId, session] of sessions) {
        if (session.isExpired()) {
            sessions.delete(sessionId);
            const roomSessionList = roomSessions.get(session.roomId);
            if (roomSessionList) {
                roomSessionList.delete(sessionId);
                if (roomSessionList.size === 0) {
                    roomSessions.delete(session.roomId);
                }
            }
            console.log(`Cleaned up expired session ${sessionId} in room ${session.roomId}`);
        }
    }
}, 300000); // Check every 5 minutes

// WebSocket handler
wss.on('connection', (ws) => {

    let heartbeatInterval;
    ws.isAlive = true;

    // Setup heartbeat
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    heartbeatInterval = setInterval(() => {
        if (ws.isAlive === false) {
            clearInterval(heartbeatInterval);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    }, 30000);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const userId = data.userId;
            const roomId = data.room;

            if (data.type === 'join' || data.type === 'leave') {
                console.log(`${data.type.toUpperCase()} request from User ${userId} for Room ${roomId}`);
            }

            switch (data.type) {
                case 'join': {
                    if (!roomId) {
                        throw new Error('Room ID is required');
                    }
                    const session = findOrCreateSession(roomId);
                    session.addParticipant(userId, ws);
                    break;
                }

                case 'offer':
                case 'answer':
                case 'candidate': {
                    const session = sessions.get(ws.sessionId);
                    if (!session) {
                        throw new Error('No active session found');
                    }

                    const targetPeer = session.participants.get(data.targetUserId);
                    if (targetPeer && targetPeer.readyState === WebSocket.OPEN) {
                        targetPeer.send(JSON.stringify({
                            type: data.type,
                            data: data.data,
                            from: userId,
                            targetUserId: data.targetUserId
                        }));
                    }
                    break;
                }

                case 'leave': {
                    const session = sessions.get(ws.sessionId);
                    if (session) {
                        const isEmpty = session.removeParticipant(userId);
                        if (isEmpty) {
                            sessions.delete(session.id);
                            const roomSessionList = roomSessions.get(session.roomId);
                            if (roomSessionList) {
                                roomSessionList.delete(session.id);
                                if (roomSessionList.size === 0) {
                                    roomSessions.delete(session.roomId);
                                }
                            }
                            console.log(`Removed empty session ${session.id} from room ${session.roomId}`);
                        }
                    }
                    break;
                }

                case 'recordingRequest':
                case 'recordingResponse': {
                    const session = sessions.get(ws.sessionId);
                    if (!session) {
                        throw new Error('No active session found');
                    }

                    if (data.type === 'recordingRequest') {
                        // Broadcast recording request to all peers except sender
                        session.broadcast({
                            type: 'recordingRequest',
                            data: data.data,
                            from: userId
                        }, userId);
                    } else {
                        // Send recording response only to the initiator
                        const targetPeer = session.participants.get(data.targetUserId);
                        if (targetPeer && targetPeer.readyState === WebSocket.OPEN) {
                            targetPeer.send(JSON.stringify({
                                type: 'recordingResponse',
                                data: data.data,
                                from: userId
                            }));
                        }
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('Error handling message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });

    ws.on('close', () => {
        clearInterval(heartbeatInterval);
        if (ws.sessionId && ws.userId) {
            const session = sessions.get(ws.sessionId);
            if (session) {
                const isEmpty = session.removeParticipant(ws.userId);
                if (isEmpty) {
                    sessions.delete(ws.sessionId);
                    const roomSessionList = roomSessions.get(session.roomId);
                    if (roomSessionList) {
                        roomSessionList.delete(session.id);
                        if (roomSessionList.size === 0) {
                            roomSessions.delete(session.roomId);
                        }
                    }
                }
            }
        }
    });
});

// Express setup
app.use(cors());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
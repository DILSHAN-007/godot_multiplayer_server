// Complete WebSocket Server for Godot Multiplayer
const WebSocket = require('ws');
const express = require('express');
const app = express();
const HTTP_PORT = 8080;
const WS_PORT = 9001;

// Store rooms: roomCode -> { host, clients: [], hostInfo, gameState }
const rooms = new Map();

// WebSocket Server
const wss = new WebSocket.Server({ port: WS_PORT });

console.log('=================================');
console.log('Godot Multiplayer Server Started');
console.log(`HTTP: http://localhost:${HTTP_PORT}`);
console.log(`WebSocket: ws://localhost:${WS_PORT}`);
console.log('=================================');

wss.on('connection', (ws) => {
    console.log('✅ New client connected');
    ws.isAlive = true;
    
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleMessage(ws, msg);
        } catch (e) {
            console.error('❌ Message parse error:', e);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
    });
    
    ws.on('close', () => {
        console.log('❌ Client disconnected');
        handleDisconnect(ws);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Heartbeat - check for dead connections
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            handleDisconnect(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000); // 30 seconds

wss.on('close', () => {
    clearInterval(interval);
});

function handleMessage(ws, msg) {
    console.log(`📨 Received: ${msg.type} from ${msg.playerInfo?.nick || 'Unknown'}`);
    
    switch(msg.type) {
        case 'create_room':
            createRoom(ws, msg);
            break;
        case 'join_room':
            joinRoom(ws, msg);
            break;
        case 'player_position':
            broadcastPosition(ws, msg);
            break;
        case 'chat_message':
            broadcastChat(ws, msg);
            break;
        case 'player_action':
            broadcastAction(ws, msg);
            break;
        case 'leave_room':
            leaveRoom(ws);
            break;
        default:
            console.log(`⚠️ Unknown message type: ${msg.type}`);
    }
}

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function createRoom(ws, msg) {
    let roomCode = generateRoomCode();
    
    // Ensure unique code
    while (rooms.has(roomCode)) {
        roomCode = generateRoomCode();
    }
    
    const room = {
        host: ws,
        clients: [],
        hostInfo: msg.playerInfo,
        playerData: {
            host: {
                info: msg.playerInfo,
                position: { x: 0, y: 0, z: 0 }
            }
        },
        createdAt: Date.now()
    };
    
    rooms.set(roomCode, room);
    ws.roomCode = roomCode;
    ws.isHost = true;
    ws.playerId = 'host';
    ws.playerInfo = msg.playerInfo;
    
    ws.send(JSON.stringify({
        type: 'room_created',
        roomCode: roomCode,
        success: true,
        playerId: 'host'
    }));
    
    console.log(`🎮 Room created: ${roomCode} by ${msg.playerInfo.nick}`);
}

function joinRoom(ws, msg) {
    const roomCode = msg.roomCode.toUpperCase();
    const room = rooms.get(roomCode);
    
    if (!room) {
        ws.send(JSON.stringify({
            type: 'join_failed',
            error: 'Room not found'
        }));
        console.log(`❌ Join failed: Room ${roomCode} not found`);
        return;
    }
    
    if (room.clients.length >= 9) {
        ws.send(JSON.stringify({
            type: 'join_failed',
            error: 'Room is full (max 10 players)'
        }));
        console.log(`❌ Join failed: Room ${roomCode} is full`);
        return;
    }
    
    const playerId = `player_${room.clients.length + 1}`;
    ws.roomCode = roomCode;
    ws.isHost = false;
    ws.playerId = playerId;
    ws.playerInfo = msg.playerInfo;
    
    room.clients.push(ws);
    room.playerData[playerId] = {
        info: msg.playerInfo,
        position: { x: 0, y: 0, z: 0 }
    };
    
    // Send success to joining client with all player data
    ws.send(JSON.stringify({
        type: 'join_success',
        roomCode: roomCode,
        playerId: playerId,
        allPlayers: room.playerData
    }));
    
    // Notify host and all other clients about new player
    const newPlayerMsg = JSON.stringify({
        type: 'player_joined',
        playerId: playerId,
        playerInfo: msg.playerInfo
    });
    
    room.host.send(newPlayerMsg);
    room.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(newPlayerMsg);
        }
    });
    
    console.log(`✅ Player ${msg.playerInfo.nick} joined room ${roomCode} as ${playerId}`);
}

function broadcastPosition(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    // Update stored position
    if (room.playerData[ws.playerId]) {
        room.playerData[ws.playerId].position = msg.position;
    }
    
    const positionMsg = JSON.stringify({
        type: 'player_position',
        playerId: ws.playerId,
        position: msg.position
    });
    
    // Broadcast to all other players in room
    if (ws.isHost) {
        room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(positionMsg);
            }
        });
    } else {
        if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(positionMsg);
        }
        room.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(positionMsg);
            }
        });
    }
}

function broadcastChat(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    const chatMsg = JSON.stringify({
        type: 'chat_message',
        nick: ws.playerInfo.nick,
        message: msg.message,
        playerId: ws.playerId
    });
    
    // Broadcast to all players including sender
    ws.send(chatMsg);
    
    if (ws.isHost) {
        room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(chatMsg);
            }
        });
    } else {
        if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(chatMsg);
        }
        room.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(chatMsg);
            }
        });
    }
    
    console.log(`💬 Chat from ${ws.playerInfo.nick}: ${msg.message}`);
}

function broadcastAction(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    const actionMsg = JSON.stringify({
        type: 'player_action',
        playerId: ws.playerId,
        action: msg.action,
        data: msg.data
    });
    
    // Broadcast to all other players
    if (ws.isHost) {
        room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(actionMsg);
            }
        });
    } else {
        if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(actionMsg);
        }
        room.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(actionMsg);
            }
        });
    }
}

function leaveRoom(ws) {
    handleDisconnect(ws);
}

function handleDisconnect(ws) {
    if (!ws.roomCode) return;
    
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    if (ws.isHost) {
        // Host left - notify all clients and close room
        const closeMsg = JSON.stringify({
            type: 'host_disconnected',
            message: 'Host left the game'
        });
        
        room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(closeMsg);
                client.close();
            }
        });
        
        rooms.delete(ws.roomCode);
        console.log(`🚪 Room ${ws.roomCode} closed - Host disconnected`);
    } else {
        // Client left - remove from room and notify others
        const index = room.clients.indexOf(ws);
        if (index > -1) {
            room.clients.splice(index, 1);
            delete room.playerData[ws.playerId];
            
            const leftMsg = JSON.stringify({
                type: 'player_left',
                playerId: ws.playerId,
                playerInfo: ws.playerInfo
            });
            
            if (room.host.readyState === WebSocket.OPEN) {
                room.host.send(leftMsg);
            }
            
            room.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(leftMsg);
                }
            });
            
            console.log(`👋 Player ${ws.playerInfo?.nick || 'Unknown'} left room ${ws.roomCode}`);
        }
    }
}

// HTTP Server for status
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Godot Multiplayer Server</title>
                <style>
                    body { font-family: Arial; padding: 20px; background: #1a1a1a; color: #fff; }
                    .status { background: #2a2a2a; padding: 20px; border-radius: 10px; }
                    .room { background: #3a3a3a; margin: 10px 0; padding: 15px; border-radius: 5px; }
                </style>
            </head>
            <body>
                <h1>🎮 Godot Multiplayer Server</h1>
                <div class="status">
                    <h2>Server Status: ✅ Online</h2>
                    <p>Active Rooms: ${rooms.size}</p>
                    <p>Connected Clients: ${wss.clients.size}</p>
                    <p>WebSocket Port: ${WS_PORT}</p>
                    <p>HTTP Port: ${HTTP_PORT}</p>
                    
                    <h3>Active Rooms:</h3>
                    ${Array.from(rooms.entries()).map(([code, room]) => `
                        <div class="room">
                            <strong>Room: ${code}</strong><br>
                            Host: ${room.hostInfo.nick}<br>
                            Players: ${room.clients.length + 1}/10
                        </div>
                    `).join('') || '<p>No active rooms</p>'}
                </div>
            </body>
        </html>
    `);
});

app.get('/stats', (req, res) => {
    res.json({
        activeRooms: rooms.size,
        connectedClients: wss.clients.size,
        rooms: Array.from(rooms.entries()).map(([code, room]) => ({
            code,
            host: room.hostInfo.nick,
            players: room.clients.length + 1
        }))
    });
});

app.listen(HTTP_PORT, () => {
    console.log(`📊 Stats available at: http://localhost:${HTTP_PORT}`);
});

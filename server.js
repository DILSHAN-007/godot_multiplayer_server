const WebSocket = require('ws');
const express = require('express');
const app = express();

const PORT = process.env.PORT || 10000;

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

console.log('=================================');
console.log('Godot Multiplayer Server Starting');
console.log(`Port: ${PORT}`);
console.log('=================================');

wss.on('connection', (ws) => {
    console.log('✅ Client connected');
    ws.isAlive = true;
    
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleMessage(ws, msg);
        } catch (e) {
            console.error('❌ Parse error:', e);
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

const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            handleDisconnect(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

function handleMessage(ws, msg) {
    console.log(`📨 ${msg.type}`);
    
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
        case 'maze_data':
            broadcastMazeData(ws, msg);
            break;
        case 'leave_room':
            leaveRoom(ws);
            break;
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
        mazeData: null,  // Store maze data
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
    
    console.log(`🎮 Room created: ${roomCode}`);
}

function joinRoom(ws, msg) {
    const roomCode = msg.roomCode.toUpperCase();
    const room = rooms.get(roomCode);
    
    if (!room) {
        ws.send(JSON.stringify({
            type: 'join_failed',
            error: 'Room not found'
        }));
        console.log(`❌ Room not found: ${roomCode}`);
        return;
    }
    
    if (room.clients.length >= 5) {
        ws.send(JSON.stringify({
            type: 'join_failed',
            error: 'Room full (max 6 players)'
        }));
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
    
    ws.send(JSON.stringify({
        type: 'join_success',
        roomCode: roomCode,
        playerId: playerId,
        allPlayers: room.playerData
    }));
    
    // If maze already generated, send to new player
    if (room.mazeData) {
        console.log(`📤 Sending existing maze data to ${playerId}`);
        ws.send(JSON.stringify({
            type: 'maze_data',
            mazeData: room.mazeData
        }));
    }
    
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
    console.log(`   Total players in room: ${room.clients.length + 1}`);
}

function broadcastPosition(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    if (room.playerData[ws.playerId]) {
        room.playerData[ws.playerId].position = msg.position;
    }
    
    const positionMsg = JSON.stringify({
        type: 'player_position',
        playerId: ws.playerId,
        position: msg.position
    });
    
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

function broadcastMazeData(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    // Only host can send maze data
    if (!ws.isHost) {
        console.log(`⚠️ Non-host tried to send maze data`);
        return;
    }
    
    // Store maze data in room
    room.mazeData = msg.mazeData;
    
    const mazeMsg = JSON.stringify({
        type: 'maze_data',
        mazeData: msg.mazeData
    });
    
    console.log(`🎲 Broadcasting maze data to ${room.clients.length} clients`);
    
    // Send to all clients
    room.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(mazeMsg);
        }
    });
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
}

function leaveRoom(ws) {
    handleDisconnect(ws);
}

function handleDisconnect(ws) {
    if (!ws.roomCode) return;
    
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    if (ws.isHost) {
        const closeMsg = JSON.stringify({
            type: 'host_disconnected',
            message: 'Host left'
        });
        
        room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(closeMsg);
                client.close();
            }
        });
        
        rooms.delete(ws.roomCode);
        console.log(`🚪 Room ${ws.roomCode} closed (host left)`);
    } else {
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
            
            console.log(`👋 Player ${ws.playerInfo.nick} left room ${ws.roomCode}`);
            console.log(`   Remaining players: ${room.clients.length + 1}`);
        }
    }
}

// HTTP Routes
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Godot Maze Server</title>
            <style>
                body { 
                    font-family: Arial; 
                    padding: 20px; 
                    background: #1a1a1a; 
                    color: #fff; 
                }
                .status { 
                    background: #2a2a2a; 
                    padding: 20px; 
                    border-radius: 10px; 
                }
            </style>
        </head>
        <body>
            <div class="status">
                <h1>🎮 Godot Maze Multiplayer Server</h1>
                <h2>✅ Server Online</h2>
                <p><strong>Active Rooms:</strong> ${rooms.size}</p>
                <p><strong>Connected Clients:</strong> ${wss.clients.size}</p>
                <p><strong>Max Players Per Room:</strong> 6</p>
                <p><strong>Features:</strong> Random Maze Generation, Co-op Puzzles</p>
                <p><strong>WebSocket URL:</strong> wss://${req.get('host')}</p>
            </div>
        </body>
        </html>
    `);
});

app.get('/stats', (req, res) => {
    res.json({
        status: 'online',
        activeRooms: rooms.size,
        connectedClients: wss.clients.size,
        rooms: Array.from(rooms.entries()).map(([code, room]) => ({
            code,
            host: room.hostInfo.nick,
            players: room.clients.length + 1,
            maxPlayers: 6,
            hasMaze: room.mazeData !== null
        }))
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`WebSocket: wss://your-domain:${PORT}`);
    console.log(`Max players per room: 6`);
    console.log(`Features: Procedural maze generation with sync`);
});

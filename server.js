const WebSocket = require('ws');
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });
const rooms = new Map();

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
        try {
            handleMessage(ws, JSON.parse(data.toString()));
        } catch (e) {
            console.error('Parse error:', e);
        }
    });
    ws.on('close', () => handleDisconnect(ws));
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

wss.on('close', () => clearInterval(interval));

function handleMessage(ws, msg) {
    switch(msg.type) {
        case 'create_room': createRoom(ws, msg); break;
        case 'join_room': joinRoom(ws, msg); break;
        case 'player_position': broadcastPosition(ws, msg); break;
        case 'chat_message': broadcastChat(ws, msg); break;
        case 'environment_update': broadcastEnvironment(ws, msg); break;
        case 'puzzle_update': broadcastPuzzle(ws, msg); break;
        case 'interaction': broadcastInteraction(ws, msg); break;
        case 'leave_room': leaveRoom(ws); break;
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
        environmentState: {},
        puzzleStates: {},
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
}

function joinRoom(ws, msg) {
    const roomCode = msg.roomCode.toUpperCase();
    const room = rooms.get(roomCode);
    
    if (!room) {
        ws.send(JSON.stringify({ type: 'join_failed', error: 'Room not found' }));
        return;
    }
    
    if (room.clients.length >= 5) {
        ws.send(JSON.stringify({ type: 'join_failed', error: 'Room full (max 6 players)' }));
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
    
    // Send current environment state
    if (Object.keys(room.environmentState).length > 0) {
        ws.send(JSON.stringify({
            type: 'environment_update',
            data: room.environmentState
        }));
    }
    
    // Send all puzzle states
    for (const [puzzleId, state] of Object.entries(room.puzzleStates)) {
        ws.send(JSON.stringify({
            type: 'puzzle_update',
            puzzleId: puzzleId,
            state: state
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

function broadcastEnvironment(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room || !ws.isHost) return;
    
    room.environmentState = msg.data;
    
    const envMsg = JSON.stringify({
        type: 'environment_update',
        data: msg.data
    });
    
    room.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(envMsg);
        }
    });
}

function broadcastPuzzle(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    room.puzzleStates[msg.puzzleId] = msg.state;
    
    const puzzleMsg = JSON.stringify({
        type: 'puzzle_update',
        puzzleId: msg.puzzleId,
        state: msg.state
    });
    
    if (ws.isHost) {
        room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(puzzleMsg);
            }
        });
    } else {
        if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(puzzleMsg);
        }
        room.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(puzzleMsg);
            }
        });
    }
}

function broadcastInteraction(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    
    const interactionMsg = JSON.stringify({
        type: 'interaction',
        objectId: msg.objectId,
        action: msg.action,
        data: msg.data,
        playerId: ws.playerId
    });
    
    if (ws.isHost) {
        room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(interactionMsg);
            }
        });
    } else {
        if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(interactionMsg);
        }
        room.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(interactionMsg);
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
        const closeMsg = JSON.stringify({ type: 'host_disconnected', message: 'Host left' });
        room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(closeMsg);
                client.close();
            }
        });
        rooms.delete(ws.roomCode);
    } else {
        const index = room.clients.indexOf(ws);
        if (index > -1) {
            room.clients.splice(index, 1);
            delete room.playerData[ws.playerId];
            const leftMsg = JSON.stringify({ type: 'player_left', playerId: ws.playerId, playerInfo: ws.playerInfo });
            if (room.host.readyState === WebSocket.OPEN) {
                room.host.send(leftMsg);
            }
            room.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(leftMsg);
                }
            });
        }
    }
}

app.get('/', (req, res) => {
    res.send(`<html><head><title>Godot Server</title><style>body{font-family:Arial;padding:20px;background:#1a1a1a;color:#fff}.status{background:#2a2a2a;padding:20px;border-radius:10px}</style></head><body><div class="status"><h1>🎮 Godot Multiplayer Server</h1><h2>✅ Server Online</h2><p><strong>Active Rooms:</strong> ${rooms.size}</p><p><strong>Connected Clients:</strong> ${wss.clients.size}</p></div></body></html>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

console.log('[init] CLIENT_ID:', SPOTIFY_CLIENT_ID ? 'set' : 'MISSING');
console.log('[init] CLIENT_SECRET:', SPOTIFY_CLIENT_SECRET ? 'set' : 'MISSING');

let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  return new Promise((resolve, reject) => {
    const body = 'grant_type=client_credentials';
    const req = https.request({
      hostname: 'accounts.spotify.com',
      path: '/api/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': body.length,
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { reject(new Error(json.error_description)); return; }
          spotifyToken = json.access_token;
          tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
          resolve(spotifyToken);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function spotifyGet(path) {
  return new Promise(async (resolve, reject) => {
    const token = await getSpotifyToken();
    const req = https.request({
      hostname: 'api.spotify.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('[spotifyGet] status:', res.statusCode);
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON from Spotify')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'EarBuddies' }));

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ tracks: [] });
  try {
    const data = await spotifyGet(`/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`);
    const tracks = (data.tracks?.items || []).map(t => ({
      id: t.id,
      title: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      duration_ms: t.duration_ms,
      uri: t.uri,
      albumArt: t.album?.images?.[0]?.url || null,
    }));
    res.json({ tracks });
  } catch (e) {
    console.error('[search] error:', e.message);
    res.status(500).json({ tracks: [], error: e.message });
  }
});

// ── Room state ────────────────────────────────────────────────────────────
// Each room tracks: queue, currentIndex, isPlaying, startEpoch (when current track started)
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      queue: [],
      currentIndex: 0,
      isPlaying: false,
      startEpoch: null,
      members: 0,
    };
  }
  return rooms[roomId];
}

function getRoomSnapshot(roomId) {
  const room = getRoom(roomId);
  const positionMs = room.isPlaying && room.startEpoch
    ? Date.now() - room.startEpoch
    : 0;
  return { ...room, positionMs };
}

io.on('connection', (socket) => {
  let currentRoom = null;
  console.log('[socket] connected:', socket.id);

  socket.on('join_room', (roomId) => {
    currentRoom = roomId;
    socket.join(roomId);
    const room = getRoom(roomId);
    room.members++;
    // Send current state so late joiners sync up
    socket.emit('room_state', getRoomSnapshot(roomId));
    io.to(roomId).emit('member_count', room.members);
  });

  socket.on('add_to_queue', ({ roomId, track }) => {
    const room = getRoom(roomId);
    room.queue.push(track);
    if (room.queue.length === 1) {
      room.currentIndex = 0;
      room.isPlaying = true;
      room.startEpoch = Date.now();
    }
    io.to(roomId).emit('room_state', getRoomSnapshot(roomId));
  });

  socket.on('play', ({ roomId }) => {
    const room = getRoom(roomId);
    if (!room.isPlaying && room.queue.length > 0) {
      room.isPlaying = true;
      room.startEpoch = Date.now();
      io.to(roomId).emit('room_state', getRoomSnapshot(roomId));
    }
  });

  socket.on('pause', ({ roomId }) => {
    const room = getRoom(roomId);
    room.isPlaying = false;
    room.startEpoch = null;
    io.to(roomId).emit('room_state', getRoomSnapshot(roomId));
  });

  socket.on('skip', ({ roomId }) => {
    const room = getRoom(roomId);
    if (room.currentIndex < room.queue.length - 1) {
      room.currentIndex++;
      room.startEpoch = Date.now();
      room.isPlaying = true;
    } else {
      room.isPlaying = false;
    }
    io.to(roomId).emit('room_state', getRoomSnapshot(roomId));
  });

  socket.on('prev', ({ roomId }) => {
    const room = getRoom(roomId);
    if (room.currentIndex > 0) room.currentIndex--;
    room.startEpoch = Date.now();
    room.isPlaying = true;
    io.to(roomId).emit('room_state', getRoomSnapshot(roomId));
  });

  socket.on('jump_to', ({ roomId, index }) => {
    const room = getRoom(roomId);
    room.currentIndex = index;
    room.isPlaying = true;
    room.startEpoch = Date.now();
    io.to(roomId).emit('room_state', getRoomSnapshot(roomId));
  });

  socket.on('remove_from_queue', ({ roomId, index }) => {
    const room = getRoom(roomId);
    room.queue.splice(index, 1);
    if (index < room.currentIndex) room.currentIndex = Math.max(0, room.currentIndex - 1);
    if (room.currentIndex >= room.queue.length) room.currentIndex = Math.max(0, room.queue.length - 1);
    if (room.queue.length === 0) { room.isPlaying = false; room.startEpoch = null; }
    io.to(roomId).emit('room_state', getRoomSnapshot(roomId));
  });

  socket.on('clear_queue', ({ roomId }) => {
    const room = getRoom(roomId);
    room.queue = [];
    room.currentIndex = 0;
    room.isPlaying = false;
    room.startEpoch = null;
    io.to(roomId).emit('room_state', getRoomSnapshot(roomId));
  });

  socket.on('track_ended', ({ roomId }) => {
    const room = getRoom(roomId);
    if (room.currentIndex < room.queue.length - 1) {
      room.currentIndex++;
      room.startEpoch = Date.now();
    } else {
      room.isPlaying = false;
      room.startEpoch = null;
    }
    io.to(roomId).emit('room_state', getRoomSnapshot(roomId));
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].members = Math.max(0, rooms[currentRoom].members - 1);
      io.to(currentRoom).emit('member_count', rooms[currentRoom].members);
    }
    console.log('[socket] disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`EarBuddies server on :${PORT}`));
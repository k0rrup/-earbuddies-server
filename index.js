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
          if (json.error) {
            console.error('[spotify] token error:', json.error, json.error_description);
            reject(new Error(json.error_description));
            return;
          }
          spotifyToken = json.access_token;
          tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
          console.log('[spotify] got token ok');
          resolve(spotifyToken);
        } catch(e) {
          reject(e);
        }
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
        console.log('[spotifyGet] body:', data.substring(0, 500));
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
    const data = await spotifyGet(`/v1/search?q=${encodeURIComponent(q)}&type=track&limit=15`);
    const tracks = (data.tracks?.items || []).map(t => ({
      id: t.id,
      title: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      duration_ms: t.duration_ms,
      uri: t.uri,
      albumArt: t.album?.images?.[0]?.url || null,
      previewUrl: t.preview_url || null,
    }));
    res.json({ tracks });
  } catch (e) {
    console.error('[search] error:', e.message);
    res.status(500).json({ tracks: [], error: e.message });
  }
});

const rooms = {};
io.on('connection', (socket) => {
  console.log('[socket] connected:', socket.id);
  socket.on('join-room', ({ roomId, userId }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = { users: [], state: null };
    rooms[roomId].users.push(userId);
    socket.to(roomId).emit('user-joined', { userId });
    if (rooms[roomId].state) socket.emit('sync-state', rooms[roomId].state);
  });
  socket.on('play', ({ roomId, trackUri, position }) => {
    if (rooms[roomId]) rooms[roomId].state = { trackUri, position, playing: true, ts: Date.now() };
    socket.to(roomId).emit('play', { trackUri, position });
  });
  socket.on('pause', ({ roomId, position }) => {
    if (rooms[roomId]) rooms[roomId].state = { ...rooms[roomId].state, playing: false, position };
    socket.to(roomId).emit('pause', { position });
  });
  socket.on('seek', ({ roomId, position }) => {
    if (rooms[roomId]) rooms[roomId].state = { ...rooms[roomId].state, position };
    socket.to(roomId).emit('seek', { position });
  });
  socket.on('disconnect', () => console.log('[socket] disconnected:', socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`EarBuddies server on :${PORT}`));
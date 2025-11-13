// server/server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Game = require('./models/Game');

// Helper function to create session via SDK API
function createSessionViaSDK(gameId) {
  return new Promise((resolve, reject) => {
    try { 
    // Use the correct server URL and API key
    const SDK_API_URL = process.env.SDK_API_URL;
    const SDK_API_KEY = process.env.SDK_API_KEY;
    
    // Validate environment variables
    if (!SDK_API_URL) {
      reject(new Error('SDK_API_URL environment variable is not set'));
      return;
    }
    if (!SDK_API_KEY) {
      reject(new Error('SDK_API_KEY environment variable is not set'));
      return;
    }
    
    // Normalize SDK_API_URL to remove trailing slash to avoid double slashes
    const normalizedApiUrl = SDK_API_URL.replace(/\/$/, '');
    
    // Use correct endpoint path
    const url = new URL(`${normalizedApiUrl}/api/game/session/create`);
    url.searchParams.set('apiKey', SDK_API_KEY);
    
    // Server expects game_id as a number, but we're passing a string
    // For now, convert string gameId to a number (you may need to look up the actual game ID from DB)
    // TODO: Replace 'rock-paper-scissors' with actual numeric game_id from database
    const numericGameId = typeof gameId === 'string' ? Number(gameId) : gameId; // Default to 1 for now
    
    const postData = JSON.stringify({ game_id: numericGameId });
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    // Use https module for HTTPS URLs, http for HTTP URLs
    const requestModule = url.protocol === 'https:' ? https : http;
    const req = requestModule.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        // Check if response is successful
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error(`SDK API Error Response (${res.statusCode}):`, data.substring(0, 500));
          reject(new Error(`SDK API returned status ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        
        // Check if response is JSON
        const contentType = res.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
          console.error('SDK API returned non-JSON response:', data.substring(0, 500));
          reject(new Error(`SDK API returned non-JSON response (${contentType}). Response: ${data.substring(0, 200)}`));
          return;
        }
        
        try {
          const response = JSON.parse(data);
          // Server returns { success: true, data: { sessionId: ... } }
          if (response.success && response.data && response.data.sessionId) {
            resolve(response.data.sessionId);
          } else {
            const errorMsg = response.message || response.error || 'Failed to create session';
            reject(new Error(errorMsg));
          }
        } catch (err) {
          console.error('Failed to parse SDK API response:', err.message);
          console.error('Response body:', data.substring(0, 500));
          reject(new Error('Invalid JSON response from SDK API: ' + err.message));
        }
      });
    });
    
    req.on('error', (err) => {
      reject(new Error('Network error: ' + err.message));
    });
    
    req.write(postData);
    req.end();
  }catch(error){
    console.error('Error creating session via SDK API:', error);
  }
  });
}

// --- DB & Express Setup ---
const app = express();
// Normalize CLIENT_URL to remove trailing slash for CORS
const clientUrl = process.env.CLIENT_URL?.replace(/\/$/, '') || 'http://localhost:5173';
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    // Normalize origin by removing trailing slash
    const normalizedOrigin = origin.replace(/\/$/, '');
    if (normalizedOrigin === clientUrl) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected successfully.'))
  .catch((err) => console.error('☠️MongoDB Connection Error:', err));

const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// --- HTTP & Socket.io Server Setup ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin
      if (!origin) return callback(null, true);
      // Normalize origin by removing trailing slash
      const normalizedOrigin = origin.replace(/\/$/, '');
      if (normalizedOrigin === clientUrl) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// --- Game State ---
const games = {}; // In-memory store for *live* games
let matchingQueue = [];

const ROUND_TIME = 8000;
const POINTS_TO_WIN = 2;
const POST_ROUND_COOLDOWN = 3000; // time to show results before next round

// --- Helper Functions ---
function getGameResult(move1, move2) {
  if (move1 === move2) return 'draw';
  if (
    (move1 === 'rock' && move2 === 'scissors') ||
    (move1 === 'scissors' && move2 === 'paper') ||
    (move1 === 'paper' && move2 === 'rock')
  ) {
    return 'player1';
  }
  return 'player2';
}

// --- Game Logic Functions ---
async function startRound(roomId) {
  const game = games[roomId];
  if (!game) return;

  game.round++;
  game.moves = [null, null];
  io.to(roomId).emit('new-round', { round: game.round });

  game.timer = setTimeout(() => {
    endRound(roomId);
  }, ROUND_TIME);
}

async function endRound(roomId) {
  const game = games[roomId];
  if (!game) return;

  clearTimeout(game.timer);

  const [move1, move2] = game.moves;
  const p1_id = game.players[0].id;
  const p2_id = game.players[1].id;
  let roundWinner = null;
  let roundWinnerId = null;

  if (!move1 && !move2) {
    roundWinner = 'draw';
  } else if (!move1) {
    roundWinner = 'player2';
    roundWinnerId = p2_id;
    game.scores[1]++;
  } else if (!move2) {
    roundWinner = 'player1';
    roundWinnerId = p1_id;
    game.scores[0]++;
  } else {
    const result = getGameResult(move1, move2);
    if (result === 'player1') {
      roundWinner = 'player1';
      roundWinnerId = p1_id;
      game.scores[0]++;
    } else if (result === 'player2') {
      roundWinner = 'player2';
      roundWinnerId = p2_id;
      game.scores[1]++;
    } else {
      roundWinner = 'draw';
    }
  }

  // Save round data to DB
  const roundData = {
    roundNumber: game.round,
    moves: [
      { user: p1_id, move: move1 },
      { user: p2_id, move: move2 },
    ],
    winner: roundWinnerId,
  };

  try {
    await Game.findByIdAndUpdate(game.dbGameId, { $push: { rounds: roundData } });
  } catch (err) {
    console.error('Error saving round data:', err);
  }

  // Send round result to clients
  io.to(roomId).emit('round-result', {
    winner: roundWinner,
    moves: game.moves,
    scores: game.scores,
    cooldownMs: POST_ROUND_COOLDOWN,
  });

    // Check for game over
    if (game.scores[0] === POINTS_TO_WIN || game.scores[1] === POINTS_TO_WIN) {
      const winnerIndex = game.scores[0] === POINTS_TO_WIN ? 0 : 1;
      const gameWinnerId = game.players[winnerIndex].id;
      const winnerUsername = game.players[winnerIndex].username;

      try {
        await Game.findByIdAndUpdate(game.dbGameId, {
          $set: { status: 'completed', winner: gameWinnerId },
        });
        
        // Emit winner info with session ID for frontend to report to SDK
        if (game.sessionId) {
          io.to(roomId).emit('game-over', { 
            winner: gameWinnerId,
            winnerUsername: winnerUsername,
            sessionId: game.sessionId
          });
        } else {
          io.to(roomId).emit('game-over', { 
            winner: gameWinnerId,
            winnerUsername: winnerUsername
          });
        }
      } catch (err) {
        console.error('Error saving game winner:', err);
      }

      delete games[roomId];
    } else {
    // Delay the next round so players can see the result and opponent's move
    setTimeout(() => {
      // Ensure game still exists (not deleted due to disconnect) before starting next round
      if (games[roomId]) {
        startRound(roomId);
      }
    }, POST_ROUND_COOLDOWN);
  }
}

// --- Socket.io Auth Middleware ---
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error: No token provided.'));
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return next(new Error('Authentication error: User not found.'));
    }
    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Authentication error: Invalid token.'));
  }
});

// --- Socket.io Connection Logic ---
io.on('connection', (socket) => {

  // 1. Create Private Room
  socket.on('create-room', ({ sessionId }) => {
    const roomId = uuidv4();
    games[roomId] = {
      players: [
        {
          id: socket.user._id.toString(),
          username: socket.user.username,
          socketId: socket.id,
        },
      ],
      scores: [0, 0],
      round: 0,
      moves: [null, null],
      timer: null,
      dbGameId: null,
      sessionId: sessionId, // Store session ID for staking and winner reporting
    };
    socket.join(roomId);
    socket.emit('room-created', { roomId, sessionId });
  });

  // 2. Join Private Room
  socket.on('join-room', async ({ roomId }) => {
    const game = games[roomId];

    if (!game) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    if (game.players.length >= 2) {
      socket.emit('error', { message: 'Room is full.' });
      return;
    }

    // Check if user is already in the game
    const alreadyInGame = game.players.some(p => p.id === socket.user._id.toString());
    if (alreadyInGame) {
      socket.join(roomId);
      
      // Send current game state with sessionId
      const clientPlayers = game.players.map((p) => ({
        id: p.id,
        username: p.username,
      }));
      
      // Find which player this socket is
      const playerIndex = game.players.findIndex(p => p.id === socket.user._id.toString());
      socket.emit('game-start', { 
        players: clientPlayers, 
        sessionId: game.sessionId,
        myPlayerIndex: playerIndex !== -1 ? playerIndex : 0,
        myUserId: socket.user._id.toString()
      });
      
      // If game is in progress, send current round
      if (game.round > 0) {
        socket.emit('new-round', { round: game.round });
      }
      return;
    }

    // Prevent same user from joining as second player (if they're already the first player)
    if (game.players.length > 0 && game.players[0].id === socket.user._id.toString()) {
      socket.emit('error', { message: 'You cannot join your own room as a second player. Share the link with another user.' });
      return;
    }

    // Add 2nd player
    game.players.push({
      id: socket.user._id.toString(),
      username: socket.user.username,
      socketId: socket.id,
    });
    socket.join(roomId);

    // Create game in DB
    try {
      const newGame = new Game({
        players: [game.players[0].id, game.players[1].id],
        status: 'active',
      });
      await newGame.save();
      game.dbGameId = newGame._id;

      const clientPlayers = game.players.map((p) => ({
        id: p.id,
        username: p.username,
      }));
      
      // Send game-start to each player individually with their own playerIndex
      // This ensures each client knows which player they are
      p1Socket.emit('game-start', { 
        players: clientPlayers, 
        sessionId: gameSessionId,
        myPlayerIndex: 0, // Player 1 is at index 0
        myUserId: p1Socket.user._id.toString()
      });
      p2Socket.emit('game-start', { 
        players: clientPlayers, 
        sessionId: gameSessionId,
        myPlayerIndex: 1, // Player 2 is at index 1
        myUserId: p2Socket.user._id.toString()
      });
      startRound(roomId);
    } catch (err) {
      console.error('Error creating game:', err);
      socket.emit('error', { message: 'Could not create game.' });
    }
  });

  // 3. Find Random Match
  socket.on('find-random-match', async () => {
    // Check if already in queue by socket ID
    const alreadyInQueue = matchingQueue.some(s => s.id === socket.id);
    if (alreadyInQueue) {
      socket.emit('error', { message: 'You are already in the matchmaking queue.' });
      return;
    }

    // Check if same user is already in queue (prevent same user from multiple tabs)
    const sameUserInQueue = matchingQueue.some(s => s.user._id.toString() === socket.user._id.toString());
    if (sameUserInQueue) {
      socket.emit('error', { message: 'You are already searching for a match in another tab. Please close that tab or wait for the match to complete.' });
      return;
    }

    // Add to queue (no sessionId yet - will be created when match is found)
    matchingQueue.push(socket);

    if (matchingQueue.length >= 2) {
      const p1Socket = matchingQueue.shift();
      const p2Socket = matchingQueue.shift();
      
      // Prevent matching same user with themselves
      if (p1Socket.user._id.toString() === p2Socket.user._id.toString()) {
        // Put both back in queue (at front) and try to find different players
        matchingQueue.unshift(p2Socket, p1Socket);
        const errorMsg = 'Cannot match with yourself. Please use a different account (e.g., rahul vs rahul2), different browser, or incognito mode with a different account.';
        p1Socket.emit('error', { message: errorMsg });
        p2Socket.emit('error', { message: errorMsg });
        return;
      }
      
      const roomId = uuidv4();

      // Create ONE shared session for the match via SDK API
      let gameSessionId = null;
      try {
        const gameId = process.env.GAME_ID || 1;
        gameSessionId = await createSessionViaSDK(gameId);
      } catch (err) {
        console.error('Failed to create session via SDK API:', err.message);
        p1Socket.emit('error', { message: 'Failed to create game session. Please try again.' });
        p2Socket.emit('error', { message: 'Failed to create game session. Please try again.' });
        return;
      }

      try {
        const newGame = new Game({
          players: [p1Socket.user._id, p2Socket.user._id],
          status: 'active',
        });
        await newGame.save();

        // Create in-memory game
        games[roomId] = {
          dbGameId: newGame._id,
          sessionId: gameSessionId, // Store session ID - both players use same sessionId
          players: [
            {
              id: p1Socket.user._id.toString(),
              username: p1Socket.user.username,
              socketId: p1Socket.id,
            },
            {
              id: p2Socket.user._id.toString(),
              username: p2Socket.user.username,
              socketId: p2Socket.id,
            },
          ],
          scores: [0, 0],
          round: 0,
          moves: [null, null],
          timer: null,
        };

        // Join both players to the room
        p1Socket.join(roomId);
        p2Socket.join(roomId);

        const clientPlayers = games[roomId].players.map((p) => ({
          id: p.id,
          username: p.username,
        }));

        // Emit to each socket individually with roomId and sessionId
        p1Socket.emit('match-found', { roomId, players: clientPlayers, sessionId: gameSessionId });
        p2Socket.emit('match-found', { roomId, players: clientPlayers, sessionId: gameSessionId });
        
        // Start the game after a small delay to ensure clients have navigated
        // Send to each player individually with their playerIndex
        setTimeout(() => {
          p1Socket.emit('game-start', { 
            players: clientPlayers, 
            sessionId: gameSessionId,
            myPlayerIndex: 0,
            myUserId: p1Socket.user._id.toString()
          });
          p2Socket.emit('game-start', { 
            players: clientPlayers, 
            sessionId: gameSessionId,
            myPlayerIndex: 1,
            myUserId: p2Socket.user._id.toString()
          });
          startRound(roomId);
        }, 1000);
        
      } catch (err) {
        console.error('Error creating game:', err);
        p1Socket.emit('error', { message: 'Could not create game.' });
        p2Socket.emit('error', { message: 'Could not create game.' });
      }
    } else {
      socket.emit('waiting-for-match');
    }
  });

  // 4. Cancel Match Search
  socket.on('cancel-match-search', () => {
    const beforeLength = matchingQueue.length;
    matchingQueue = matchingQueue.filter((s) => s.id !== socket.id);
    const afterLength = matchingQueue.length;
    
    if (beforeLength !== afterLength) {
      socket.emit('match-search-cancelled');
    }
  });

  // 5. Handle Player Move
  socket.on('make-move', ({ roomId, move }) => {
    const game = games[roomId];
    if (!game) {
      return;
    }

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex === -1) {
      return;
    }

    if (game.moves[playerIndex] !== null) {
      return;
    }

    game.moves[playerIndex] = move;
    socket.emit('move-confirmed');

    if (game.moves[0] && game.moves[1]) {
      endRound(roomId);
    }
  });

  // 6. Handle Disconnect
  socket.on('disconnect', () => {
    // Remove from queue by socket ID
    matchingQueue = matchingQueue.filter((s) => s.id !== socket.id);

    for (const roomId in games) {
      const game = games[roomId];
      const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);

      if (playerIndex !== -1) {
        const otherPlayerIndex = playerIndex === 0 ? 1 : 0;
        const otherPlayer = game.players[otherPlayerIndex];
        
        if (otherPlayer) {
          const winnerId = otherPlayer.id;
          try {
            if (game.dbGameId) {
              Game.findByIdAndUpdate(game.dbGameId, {
                $set: { status: 'completed', winner: winnerId },
              }).exec();
            }
          } catch (err) {
            console.error('Error handling disconnect:', err);
          }
          
          io.to(roomId).emit('opponent-left');
        }
        delete games[roomId];
        break;
      }
    }
  });
});

// --- Start Server ---
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🎉Server running on port ${PORT}`));


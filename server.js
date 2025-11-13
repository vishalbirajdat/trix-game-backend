// server/server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
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
    
    // Use correct endpoint path
    const url = new URL(`${SDK_API_URL}/api/game/session/create`);
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
    console.log('Options:', options);
    
    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log('Response:', response);
          // Server returns { success: true, data: { sessionId: ... } }
          if (response.success && response.data && response.data.sessionId) {
            resolve(response.data.sessionId);
          } else {
            const errorMsg = response.message || response.error || 'Failed to create session';
            reject(new Error(errorMsg));
          }
        } catch (err) {
          reject(new Error('Invalid response from SDK API: ' + err.message));
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
app.use(cors());
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
    origin: process.env.CLIENT_URL,
    methods: ['GET', 'POST'],
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
          console.log(`Game winner: ${winnerUsername}, Session: ${game.sessionId}`);
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
  console.log(`\n=== User Connected ===`);
  console.log(`Username: ${socket.user.username}`);
  console.log(`User ID: ${socket.user._id}`);
  console.log(`Socket ID: ${socket.id}`);
  console.log(`Connection from: ${socket.handshake.address}`);

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
    console.log(`Room created: ${roomId} by ${socket.user.username}, Session: ${sessionId}`);
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
      console.log(`${socket.user.username} already in game ${roomId}, just joining socket room`);
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
      console.log(`${socket.user.username} tried to join their own room as second player`);
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

    console.log(`${socket.user.username} joined room ${roomId}`);

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
      
      // Store session ID for later use (staking/winner reporting handled by SDK/frontend)
      if (game.sessionId) {
        console.log(`Game session ID: ${game.sessionId} for room ${roomId}`);
      }
      
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
      console.log(`Sent game-start to Player 1 (index 0) and Player 2 (index 1)`);
      startRound(roomId);
    } catch (err) {
      console.error('Error creating game:', err);
      socket.emit('error', { message: 'Could not create game.' });
    }
  });

  // 3. Find Random Match
  socket.on('find-random-match', async () => {
    console.log(`find-random-match request from ${socket.user.username} (${socket.user._id}) socket ${socket.id}`);
    console.log(`Current queue size: ${matchingQueue.length}`);
    console.log(`Queue users: ${matchingQueue.map(s => `${s.user.username}(${s.user._id})`).join(', ')}`);
    
    // Check if already in queue by socket ID
    const alreadyInQueue = matchingQueue.some(s => s.id === socket.id);
    if (alreadyInQueue) {
      console.log(`${socket.user.username} already in queue (by socket ID)`);
      socket.emit('error', { message: 'You are already in the matchmaking queue.' });
      return;
    }

    // Check if same user is already in queue (prevent same user from multiple tabs)
    const sameUserInQueue = matchingQueue.some(s => s.user._id.toString() === socket.user._id.toString());
    if (sameUserInQueue) {
      console.log(`${socket.user.username} (${socket.user._id}) is already in queue from another tab/connection`);
      console.log(`Existing socket in queue: ${matchingQueue.find(s => s.user._id.toString() === socket.user._id.toString())?.id}`);
      socket.emit('error', { message: 'You are already searching for a match in another tab. Please close that tab or wait for the match to complete.' });
      return;
    }

    // Add to queue (no sessionId yet - will be created when match is found)
    matchingQueue.push(socket);
    console.log(`${socket.user.username} joined matchmaking queue. Queue size: ${matchingQueue.length}`);

    if (matchingQueue.length >= 2) {
      const p1Socket = matchingQueue.shift();
      const p2Socket = matchingQueue.shift();
      
      // Prevent matching same user with themselves
      if (p1Socket.user._id.toString() === p2Socket.user._id.toString()) {
        console.log(`\n❌ PREVENTED MATCHING SAME USER`);
        console.log(`Player 1: ${p1Socket.user.username} (ID: ${p1Socket.user._id}, Socket: ${p1Socket.id})`);
        console.log(`Player 2: ${p2Socket.user.username} (ID: ${p2Socket.user._id}, Socket: ${p2Socket.id})`);
        console.log(`Both players have the same User ID - they are the same user account!`);
        // Put both back in queue (at front) and try to find different players
        matchingQueue.unshift(p2Socket, p1Socket);
        const errorMsg = 'Cannot match with yourself. Please use a different account (e.g., rahul vs rahul2), different browser, or incognito mode with a different account.';
        p1Socket.emit('error', { message: errorMsg });
        p2Socket.emit('error', { message: errorMsg });
        return;
      }
      
      console.log(`\n✅ MATCHING DIFFERENT USERS`);
      console.log(`Player 1: ${p1Socket.user.username} (ID: ${p1Socket.user._id}, Socket: ${p1Socket.id})`);
      console.log(`Player 2: ${p2Socket.user.username} (ID: ${p2Socket.user._id}, Socket: ${p2Socket.id})`);
      
      const roomId = uuidv4();

      // Create ONE shared session for the match via SDK API
      let gameSessionId = null;
      try {
        const gameId = process.env.GAME_ID || 1;
        console.log(`Creating shared session via SDK API for match...`, gameId);
        gameSessionId = await createSessionViaSDK(gameId);
        console.log(`✅ Shared session created for match: ${gameSessionId}`);
      } catch (err) {
        console.error('❌ Failed to create session via SDK API:', err.message);
        p1Socket.emit('error', { message: 'Failed to create game session. Please try again.' });
        p2Socket.emit('error', { message: 'Failed to create game session. Please try again.' });
        return;
      }

      console.log(`Matching ${p1Socket.user.username} vs ${p2Socket.user.username} in room ${roomId}, Shared Session: ${gameSessionId}`);

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

        // Store session ID for later use (staking/winner reporting handled by SDK/frontend)
        if (gameSessionId) {
          console.log(`Match session ID: ${gameSessionId} for room ${roomId}`);
        }

        // Emit to each socket individually with roomId and sessionId
        p1Socket.emit('match-found', { roomId, players: clientPlayers, sessionId: gameSessionId });
        p2Socket.emit('match-found', { roomId, players: clientPlayers, sessionId: gameSessionId });
        
        console.log(`Match found, sent to both players for room ${roomId}`);
        
        // Start the game after a small delay to ensure clients have navigated
        // Send to each player individually with their playerIndex
        setTimeout(() => {
          console.log(`Starting game in room ${roomId}`);
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
          console.log(`Sent game-start individually to both players with correct indices`);
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
    console.log(`${socket.user.username} (${socket.id}) cancelled match search`);
    const beforeLength = matchingQueue.length;
    matchingQueue = matchingQueue.filter((s) => s.id !== socket.id);
    const afterLength = matchingQueue.length;
    
    if (beforeLength !== afterLength) {
      console.log(`Removed ${socket.user.username} from queue. Queue size: ${beforeLength} -> ${afterLength}`);
      socket.emit('match-search-cancelled');
    } else {
      console.log(`${socket.user.username} was not in queue`);
    }
  });

  // 5. Handle Player Move
  socket.on('make-move', ({ roomId, move }) => {
    const game = games[roomId];
    if (!game) {
      console.log(`Move attempted in non-existent room: ${roomId}`);
      return;
    }

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex === -1) {
      console.log(`Player ${socket.user.username} not found in room ${roomId}`);
      return;
    }

    if (game.moves[playerIndex] !== null) {
      console.log(`Player ${socket.user.username} already made a move`);
      return;
    }

    game.moves[playerIndex] = move;
    console.log(`${socket.user.username} made move: ${move} in room ${roomId}`);
    socket.emit('move-confirmed');

    if (game.moves[0] && game.moves[1]) {
      endRound(roomId);
    }
  });

  // 6. Handle Disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.user.username} (${socket.id})`);
    
    // Remove from queue by socket ID
    const beforeQueueLength = matchingQueue.length;
    matchingQueue = matchingQueue.filter((s) => s.id !== socket.id);
    const afterQueueLength = matchingQueue.length;
    
    if (beforeQueueLength !== afterQueueLength) {
      console.log(`Removed socket ${socket.id} from queue. Queue size: ${beforeQueueLength} -> ${afterQueueLength}`);
    }
    
    // Also check if this user has other connections in queue (shouldn't happen, but just in case)
    const userStillInQueue = matchingQueue.some(s => s.user._id.toString() === socket.user._id.toString());
    if (userStillInQueue) {
      console.warn(`User ${socket.user.username} still has another connection in queue`);
    }

    for (const roomId in games) {
      const game = games[roomId];
      const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);

      if (playerIndex !== -1) {
        console.log(`Player ${socket.user.username} left game ${roomId}`);
        
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


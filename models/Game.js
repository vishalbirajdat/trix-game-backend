// server/models/Game.js
const mongoose = require('mongoose');

const RoundSchema = new mongoose.Schema({
  roundNumber: {
    type: Number,
    required: true,
  },
  moves: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      move: {
        type: String,
        enum: ['rock', 'paper', 'scissors', null], // null = timeout
      },
    },
  ],
  winner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null, // null for a draw
  },
});

const GameSchema = new mongoose.Schema(
  {
    players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    rounds: [RoundSchema],
    winner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'completed'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Game', GameSchema);


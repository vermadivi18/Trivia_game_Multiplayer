const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let questions = [];
try {
    const questionsData = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
    questions = JSON.parse(questionsData);
    console.log('Questions loaded from questions.json');
} catch (error) {
    console.error('Error loading questions.json:', error);
    questions = [
        { text: 'What is 2 + 2?', answer: '4' },
    ];
}

const rooms = {};

function createRoom(roomId) {
    rooms[roomId] = {
        players: {},
        currentQuestionIndex: -1,
        currentQuestion: null,
        correctAnswerer: null,
        questionStartTime: null,
        timerInterval: null,
        usedQuestions: []
    };
}

function joinRoom(socket, roomId, username) {
    if (!rooms[roomId]) {
        createRoom(roomId);
    }
    const room = rooms[roomId];
    if (Object.values(room.players).some(p => p.username.toLowerCase() === username.toLowerCase())) {
        socket.emit('usernameTaken');
        return false;
    }
    socket.join(roomId);
    room.players[socket.id] = { username, score: 0, lives: 3, answeredCorrectlyThisRound: false, socketId: socket.id };
    socket.roomId = roomId;
    return true;
}

function startGame(roomId) {
    const room = rooms[roomId];
    if (!room || Object.keys(room.players).filter(p => !p.isEliminated).length < 2) {
        io.to(roomId).emit('message', 'Waiting for more players...');
        return false; // Indicate game didn't start
    }
    room.currentQuestionIndex = -1;
    room.correctAnswerer = null;
    nextQuestion(roomId);
    return true; // Indicate game started
}

function nextQuestion(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // Filter out questions that have already been used in this room
    const unusedQuestions = questions.filter(q => !room.usedQuestions.includes(q.text));

    if (unusedQuestions.length === 0) {
        endGame(roomId); // No more questions
        return;
    }

    // Select a random question
    const randomIndex = Math.floor(Math.random() * unusedQuestions.length);
    const selectedQuestion = unusedQuestions[randomIndex];

    room.currentQuestion = selectedQuestion;
    room.usedQuestions.push(selectedQuestion.text);
    room.correctAnswerer = null;
    room.questionStartTime = Date.now();

    // Reset player flags
    Object.values(room.players).forEach(player => {
        player.answeredCorrectlyThisRound = false;
    });

    // Send question
    io.to(roomId).emit('newQuestion', { question: selectedQuestion.text, timeLimit: 30 });

    // Start the timer
    startQuestionTimer(roomId);
}


function startQuestionTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    clearInterval(room.timerInterval);
    room.timerInterval = setInterval(() => {
        const timeLeft = 30 - Math.floor((Date.now() - room.questionStartTime) / 1000);
        io.to(roomId).emit('timerUpdate', timeLeft);

        if (timeLeft <= 0) {
            clearInterval(room.timerInterval);
            handleNoAnswer(roomId);
        }
    }, 1000);
}

function handleAnswer(socketId, roomId, answer) {
    const room = rooms[roomId];
    if (!room || room.correctAnswerer || !room.players[socketId] || room.players[socketId].answeredCorrectlyThisRound || room.players[socketId].isEliminated) {
        return;
    }
    const player = room.players[socketId];

    if (answer.trim().toLowerCase() === room.currentQuestion.answer.toLowerCase()) {
        player.score++;
        player.answeredCorrectlyThisRound = true;
        room.correctAnswerer = socketId;
        io.to(socketId).emit('correctAnswer', room.currentQuestion.answer); // Send only to the correct player
        clearInterval(room.timerInterval); // Stop timer on correct answer
        updateLeaderboard(roomId);
        setTimeout(() => nextQuestionAnnouncement(roomId), 1000);
    } else {
        player.lives--;
        io.to(socketId).emit('incorrectAnswer');
        if (player.lives <= 0) {
            player.isEliminated = true; // Mark as eliminated
            io.to(socketId).emit('youAreEliminated'); // Inform the eliminated player
            const username = player.username;
            io.to(roomId).emit('playerEliminated', username);
            updateLeaderboard(roomId);
            //delete room.players[socketId]; // Remove eliminated player data
            /*if (Object.keys(room.players).filter(p => !p.isEliminated).length <= 1) {
                setTimeout(() => endGame(roomId), 1000); // End game if only 0 or 1 alive left
            }*/
            const alivePlayers = Object.values(room.players).filter(p => !p.isEliminated);
            if (alivePlayers.length <= 1) {
                setTimeout(() => endGame(roomId), 1000);
            }

        } else {
            updateLeaderboard(roomId);
            io.to(socketId).emit('allowRetry');
        }
    }
}

function handleNoAnswer(roomId) {
    const room = rooms[roomId];
    if (!room || room.correctAnswerer) return;
    io.to(roomId).emit('message', 'Time\'s up!');
    Object.keys(room.players).forEach(socketId => {
        if (!room.players[socketId].answeredCorrectlyThisRound && room.players[socketId].lives > 0 && !room.players[socketId].isEliminated) {
            room.players[socketId].lives--;
            io.to(socketId).emit('timeOut');
            if (room.players[socketId].lives <= 0) {
                room.players[socketId].isEliminated = true; // Mark as eliminated
                io.to(socketId).emit('youAreEliminated'); // Inform the eliminated player
                const username = room.players[socketId].username;
                io.to(roomId).emit('playerEliminated', username);
                updateLeaderboard(roomId);
                //delete room.players[socketId]; // Remove eliminated player data
                /*if (Object.keys(room.players).filter(p => !p.isEliminated).length <= 1) {
                    setTimeout(() => endGame(roomId), 1000); // End game if only 0 or 1 alive left
                }*/
                const alivePlayers = Object.values(room.players).filter(p => !p.isEliminated);
                if (alivePlayers.length <= 1) {
                    setTimeout(() => endGame(roomId), 1000);
                }
            }
            else {
                setTimeout(() => nextQuestionAnnouncement(roomId), 1000);
            }
        }
    });
    updateLeaderboard(roomId);
    // checkGameEnd(roomId); // No need to call here anymore in this specific scenario
}
function nextQuestionAnnouncement(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit('nextQuestionAnnouncement', 3);
    setTimeout(() => nextQuestion(roomId), 2000);
}

function updateLeaderboard(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const leaderboard = Object.values(room.players)
        .sort((a, b) => b.score - a.score)
        .map(player => ({
            username: player.username,
            score: player.score,
            isCorrect: player.socketId === room.correctAnswerer,
            socketId: player.socketId,
            isEliminated: player.isEliminated || false,
            lives: player.lives // Keep lives for game over display
        }));
    io.to(roomId).emit('leaderboardUpdate', leaderboard);
}

function checkGameEnd(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.currentQuestionIndex === questions.length - 1) {
        setTimeout(() => endGame(roomId), 1000);
    }
}

function endGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const players = Object.values(room.players);
    const activePlayers = players.filter(p => !p.isEliminated);

    let winner = null;
    let reason = "";
    let simultaneousElimination = false; // Flag for simultaneous elimination (currently not actively tracked server-side)
    let lastEliminatedUsernames = []; // Array of usernames eliminated in the final simultaneous event

    // Scenario 1: Single survivor
    if (activePlayers.length === 1) {
        winner = activePlayers[0];
        reason = "Only one player remaining";
    }
    // Scenario 2: No survivors (could be due to simultaneous elimination or sequential)
    else if (activePlayers.length === 0) {
        // In a real simultaneous elimination scenario, you'd likely have a way to identify these players.
        // For now, we'll just check if all players are eliminated.
        if (players.every(p => p.isEliminated)) {
            // Check for score tie among *all* players
            const maxScore = Math.max(...players.map(p => p.score));
            const topScorers = players.filter(p => p.score === maxScore);
            if (topScorers.length > 1) {
                reason = "All players eliminated with the same top score";
            } else if (topScorers.length === 1 && players.length > 0) {
                winner = topScorers[0];
                reason = "All players eliminated, winner by highest score";
            } else {
                reason = "No players to determine a winner";
            }
            simultaneousElimination = false; // Adjust this based on your server-side tracking
        } else if (players.length > 0) {
            // If not a simultaneous elimination, the highest scorer among all (even eliminated) wins
            players.sort((a, b) => b.score - a.score);
            winner = players[0];
            reason = "All survivors eliminated, winner by highest final score";
        } else {
            reason = "No players participated";
        }
    }
    
    // Scenario 3: Multiple survivors (game ended by other means, e.g., all questions answered)
    else if (activePlayers.length > 1) {
        activePlayers.sort((a, b) => b.score - a.score);
        const topScore = activePlayers[0].score;
        const topScorers = activePlayers.filter(p => p.score === topScore);
        if (topScorers.length === 1) {
            winner = topScorers[0];
            reason = "Game ended with multiple survivors, winner by highest score";
        } else {
            reason = "Game ended with multiple survivors tied for the highest score";
        }
    } else {
        reason = "No winner could be determined";
    }

    const finalLeaderboard = players.map(p => ({
        username: p.username,
        score: p.score,
        finalLives: p.lives,
        isEliminated: p.isEliminated || false
    }));

    io.in(roomId).emit("gameOver", {
        winner: winner ? winner.username : null,
        finalLeaderboard: finalLeaderboard,
        reason: reason,
        simultaneousElimination: simultaneousElimination, // Send this flag
        lastEliminatedUsernames: lastEliminatedUsernames // Send the list of last eliminated users
    });

    console.log(`Game ended in room ${roomId}. Reason: ${reason}. Winner: ${winner ? winner.username : 'None'}`);
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('joinGame', ({ username, room }) => {
        if (!username || !room) return;
        const joined = joinRoom(socket, room, username);
        if (joined) {
            io.to(socket.roomId).emit('playerJoined', username);
            updateLeaderboard(socket.roomId);
            const currentRoom = rooms[socket.roomId];
            if (currentRoom && currentRoom.currentQuestionIndex === -1 && Object.keys(currentRoom.players).filter(p => !p.isEliminated).length >= 2) {
                if (startGame(socket.roomId)) {
                    // Game started
                }
            } else if (currentRoom && currentRoom.currentQuestion) {
                socket.emit('newQuestion', { question: currentRoom.currentQuestion.text, timeLimit: 30 });
                const timeLeft = 30 - Math.floor((Date.now() - currentRoom.questionStartTime) / 1000);
                socket.emit('timerUpdate', timeLeft > 0 ? timeLeft : 0);
                updateLeaderboard(socket.roomId);
            } else if (currentRoom && currentRoom.currentQuestionIndex === -1 && Object.keys(currentRoom.players).length < 2) {
                socket.emit('message', 'Waiting for more players...');
            }
            socket.emit('joinGameSuccess', { username, room });
            console.log(`Player ${username} joined room ${room}`);
        }
    });

    socket.on('answerQuestion', (answer) => {
        if (socket.roomId) {
            handleAnswer(socket.id, socket.roomId, answer);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (socket.roomId && rooms[socket.roomId] && rooms[socket.roomId].players[socket.id]) {
            const username = rooms[socket.roomId].players[socket.id].username;
            const isEliminated = rooms[socket.roomId].players[socket.id].isEliminated;
            delete rooms[socket.roomId].players[socket.id];
            io.to(socket.roomId).emit('playerLeft', username);
            updateLeaderboard(socket.roomId);
            if (!isEliminated) {
                checkGameEnd(socket.roomId);
            }
            if (Object.keys(rooms[socket.roomId]?.players || {}).length === 0) {
                delete rooms[socket.roomId];
            }
        }
    });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});

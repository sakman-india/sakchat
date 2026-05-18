const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { maxHttpBufferSize: 1e8 });
const fs = require('fs'); 
const path = require('path');
const multer = require('multer');

app.use(express.json({limit: '50mb'})); 
app.use(express.static('public'));

const mediaDir = path.join(__dirname, 'public', 'media');
if (!fs.existsSync(mediaDir)) { fs.mkdirSync(mediaDir, { recursive: true }); }
if (!fs.existsSync(path.join(mediaDir, '.nomedia'))) { fs.writeFileSync(path.join(mediaDir, '.nomedia'), ''); } 

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, mediaDir) },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, 'file_' + Date.now() + ext);
    }
});
const upload = multer({ storage: storage });

const dbFile = 'database.json';
let chatHistory = [];
let profiles = { 'Master': { name: 'Master', dp: null }, 'Guest': { name: 'Guest', dp: null } };
let userStatus = { 'Master': { online: false, lastSeen: null }, 'Guest': { online: false, lastSeen: null } };
let users = {};
let loginBg = { type: null, data: null }; 

if (fs.existsSync(dbFile)) {
    try {
        const data = JSON.parse(fs.readFileSync(dbFile));
        chatHistory = data.chatHistory || [];

        // DB ekebare halka korar jonne extra cleaning
        let isDbBloated = false;
        chatHistory.forEach(m => {
            if (m.image && m.image.length > 1000) { m.image = null; m.text = "📷 [Old File Cleared]"; isDbBloated = true; }
            if (m.audio && m.audio.length > 1000) { m.audio = null; m.text = "🎤 [Old Audio Cleared]"; isDbBloated = true; }
            if (m.fileData && m.fileData.length > 1000) { m.fileData = null; m.text = "📄 [Old File Cleared]"; isDbBloated = true; }
        });

        profiles = data.profiles || profiles;
        loginBg = data.loginBg || { type: null, data: null };
        if (isDbBloated) saveData();
    } catch(e) {}
}

function saveData() { fs.writeFileSync(dbFile, JSON.stringify({ chatHistory, profiles, loginBg })); }

function deletePhysicalFile(msg) {
    const fileUrls = [msg.image, msg.audio, msg.fileData];
    fileUrls.forEach(url => {
        if (url && typeof url === 'string' && url.startsWith('/media/')) {
            const fileName = url.split('/media/')[1];
            const filePath = path.join(mediaDir, fileName);
            if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch (e) {} }
        }
    });
}

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.json({ success: false });
    res.json({ success: true, url: '/media/' + req.file.filename });
});

app.get('/getLoginBg', (req, res) => { res.json(loginBg); });

// Ebar theke Login korar sathesathei chatHistory chole jabe (0.1s lagbe)
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === 'sak77') res.json({ success: true, role: 'Master', profiles, userStatus, chatHistory });
    else if (password === 'as55') res.json({ success: true, role: 'Guest', profiles, userStatus, chatHistory });
    else res.json({ success: false });
});

io.on('connection', (socket) => {
    socket.emit('profileUpdate', profiles); 
    socket.emit('statusUpdate', userStatus);

    socket.on('requestHistory', () => { socket.emit('history', chatHistory); });
    socket.on('setOnline', (role) => { socket.role = role; users[role] = socket.id; userStatus[role].online = true; io.emit('statusUpdate', userStatus); });
    socket.on('disconnect', () => { if (socket.role) { userStatus[socket.role].online = false; userStatus[socket.role].lastSeen = new Date(); io.emit('statusUpdate', userStatus); } });
    socket.on('sendMessage', (msg) => { chatHistory.push(msg); saveData(); io.emit('receiveMessage', msg); });
    socket.on('triggerSync', () => { io.emit('history', chatHistory); }); // Direct history pathabe

    socket.on('deleteMessage', (data) => {
        const msg = chatHistory.find(m => m.id === data.id);
        if (msg) {
            if (data.type === 'everyone' && msg.role === data.role) { 
                deletePhysicalFile(msg); 
                msg.isDeleted = true; msg.text = '🚫 This message was deleted'; 
                msg.image = null; msg.audio = null; msg.fileData = null; msg.location = null; msg.isSticker = false; 
            } 
            else if (data.type === 'me') { 
                if (!msg.deletedFor) msg.deletedFor = []; 
                msg.deletedFor.push(data.role); 
                if (msg.deletedFor.includes('Master') && msg.deletedFor.includes('Guest')) { deletePhysicalFile(msg); }
            }
            saveData(); io.emit('history', chatHistory); 
        }
    });

    socket.on('clearChat', (role) => { 
        chatHistory.forEach(msg => { 
            if (!msg.deletedFor) msg.deletedFor = []; 
            if (!msg.deletedFor.includes(role)) msg.deletedFor.push(role); 
            if (msg.deletedFor.includes('Master') && msg.deletedFor.includes('Guest')) { deletePhysicalFile(msg); }
        }); 
        chatHistory = chatHistory.filter(msg => !(msg.deletedFor && msg.deletedFor.includes('Master') && msg.deletedFor.includes('Guest')));
        saveData(); io.emit('history', chatHistory); 
    });

    socket.on('markAsRead', (role) => { let changed = false; chatHistory.forEach(m => { if (m.role !== role && m.status !== 'read') { m.status = 'read'; changed = true; } }); if (changed) { saveData(); io.emit('messagesRead'); } });
    socket.on('typing', (role) => { socket.broadcast.emit('userTyping', role); });
    socket.on('stopTyping', (role) => { socket.broadcast.emit('userStoppedTyping', role); });
    socket.on('updateName', (data) => { profiles[data.role].name = data.name; saveData(); io.emit('profileUpdate', profiles); });
    socket.on('updateDP', (data) => { profiles[data.role].dp = data.dpData; saveData(); io.emit('profileUpdate', profiles); });
    socket.on('updateLoginBg', (payload) => { if(socket.role === 'Master') { loginBg = payload; saveData(); io.emit('loginBgUpdated', loginBg); } });

    socket.on('webrtc_offer', (data) => { if(users[data.to]) io.to(users[data.to]).emit('webrtc_offer', data); });
    socket.on('webrtc_answer', (data) => { if(users[data.to]) io.to(users[data.to]).emit('webrtc_answer', data); });
    socket.on('webrtc_ice', (data) => { if(users[data.to]) io.to(users[data.to]).emit('webrtc_ice', data); });
    socket.on('endCall', (data) => { if(users[data.to]) io.to(users[data.to]).emit('callEnded', data); });
});

server.listen(process.env.PORT || 3000, '127.0.0.1', () => { console.log('Server is LIVE (Instant Login + Sync Mode)'); });


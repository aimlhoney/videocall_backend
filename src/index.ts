import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { generateRoomCode } from './utils';

const app = express();
const httpServer = createServer(app);

const ALLOWED_ORIGINS = '*';

const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const prisma = new PrismaClient();

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  })
);

app.options(
  '*',
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  })
);

app.use(express.json());

/**
 * REST: Create room
 */
app.post('/api/rooms', async (req, res) => {
  try {
    const { name, hostId, hostName } = req.body;
    const code = generateRoomCode();

    const room = await prisma.room.create({
      data: {
        name,
        code,
        hostId,
        participants: {
          create: [
            {
              userId: hostId,
              name: hostName,
              isHost: true,
              cameraOn: true,
              micOn: true,
            },
          ],
        },
      },
      include: {
        participants: true,
      },
    });

    res.json({ roomId: room.id, code });
  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

/**
 * REST: Get room info
 */
app.get('/api/rooms/:code', async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { code: req.params.code },
      include: { participants: true },
    });

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    res.json(room);
  } catch (error) {
    console.error('Get room error:', error);
    res.status(500).json({ error: 'Failed to get room' });
  }
});

/**
 * Socket.io realtime handlers
 */
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  /**
   * Join room
   */
  socket.on(
    'join-room',
    async ({ roomCode, userId, name }: { roomCode: string; userId: string; name: string }) => {
      try {
        if (!roomCode || !userId || !name) {
          socket.emit('room-error', 'Missing room code, user id, or name');
          return;
        }

        const room = await prisma.room.findUnique({
          where: { code: roomCode },
          include: { participants: true },
        });

        if (!room || room.status === 'ENDED') {
          socket.emit('room-error', 'Room not found or ended');
          return;
        }

        socket.data.roomCode = roomCode;
        socket.data.userId = userId;
        socket.data.name = name;

        socket.join(roomCode);

        const existing = room.participants.find((p) => p.userId === userId);

        if (!existing) {
          await prisma.participant.create({
            data: {
              roomId: room.id,
              userId,
              name,
              cameraOn: true,
              micOn: true,
              // socketId is optional; add to schema if you want it
              // socketId: socket.id,
            },
          });
        } else {
          await prisma.participant.updateMany({
            where: {
              roomId: room.id,
              userId,
            },
            data: {
              // socketId: socket.id,
            },
          });
        }

        const updatedRoom = await prisma.room.findUnique({
          where: { code: roomCode },
          include: { participants: true },
        });

        io.to(roomCode).emit('room-update', {
          participants:
            updatedRoom?.participants.map((p) => ({
              id: p.id,
              userId: p.userId,
              name: p.name,
              isHost: p.isHost,
              cameraOn: p.cameraOn,
              micOn: p.micOn,
            })) || [],
        });
      } catch (error) {
        console.error('join-room error:', error);
        socket.emit('room-error', 'Failed to join room');
      }
    }
  );

  /**
   * Toggle media (camera/mic)
   */
  socket.on(
    'toggle-media',
    async ({
      roomCode,
      userId,
      cameraOn,
      micOn,
    }: {
      roomCode: string;
      userId: string;
      cameraOn: boolean;
      micOn: boolean;
    }) => {
      try {
        const room = await prisma.room.findUnique({
          where: { code: roomCode },
        });

        if (!room) return;

        await prisma.participant.updateMany({
          where: {
            roomId: room.id,
            userId,
          },
          data: { cameraOn, micOn },
        });

        io.to(roomCode).emit('participant-update', { userId, cameraOn, micOn });
      } catch (error) {
        console.error('toggle-media error:', error);
      }
    }
  );

  /**
   * Start / end meeting
   */
  socket.on('start-meeting', async ({ roomCode }: { roomCode: string }) => {
    try {
      const room = await prisma.room.findUnique({
        where: { code: roomCode },
      });

      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      await prisma.room.update({
        where: { id: room.id },
        data: { status: 'ACTIVE' },
      });

      io.to(roomCode).emit('meeting-started');
      console.log(`Meeting started in room ${roomCode}`);
    } catch (error) {
      console.error('start-meeting error:', error);
    }
  });

  socket.on('end-meeting', async ({ roomCode }: { roomCode: string }) => {
    try {
      const room = await prisma.room.findUnique({
        where: { code: roomCode },
      });

      if (!room) return;

      await prisma.room.update({
        where: { id: room.id },
        data: { status: 'ENDED' },
      });

      io.to(roomCode).emit('meeting-ended');
    } catch (error) {
      console.error('end-meeting error:', error);
    }
  });

  /**
   * WebRTC signaling for P2P (2 participants)
   */

  // A peer is ready and wants to establish WebRTC
  socket.on('webrtc-ready', (roomCode: string) => {
    socket.to(roomCode).emit('webrtc-ready');
  });

  // Offer from caller
  socket.on(
    'webrtc-offer',
    (payload: { roomCode: string; offer: any }) => {
      socket.to(payload.roomCode).emit('webrtc-offer', payload.offer);
    }
  );

  // Answer from callee
  socket.on(
    'webrtc-answer',
    (payload: { roomCode: string; answer: any }) => {
      socket.to(payload.roomCode).emit('webrtc-answer', payload.answer);
    }
  );

  // ICE candidates
  socket.on(
    'webrtc-ice-candidate',
    (payload: { roomCode: string; candidate: any }) => {
      socket.to(payload.roomCode).emit('webrtc-ice-candidate', payload.candidate);
    }
  );

  /**
   * Disconnect cleanup
   */
  socket.on('disconnect', async () => {
    try {
      const roomCode = socket.data.roomCode as string | undefined;
      const userId = socket.data.userId as string | undefined;

      console.log('User disconnected:', socket.id, roomCode, userId);

      if (!roomCode || !userId) return;

      const room = await prisma.room.findUnique({
        where: { code: roomCode },
        include: { participants: true },
      });

      if (!room) return;

      await prisma.participant.deleteMany({
        where: {
          roomId: room.id,
          userId,
        },
      });

      const updatedRoom = await prisma.room.findUnique({
        where: { code: roomCode },
        include: { participants: true },
      });

      io.to(roomCode).emit('room-update', {
        participants:
          updatedRoom?.participants.map((p) => ({
            id: p.id,
            userId: p.userId,
            name: p.name,
            isHost: p.isHost,
            cameraOn: p.cameraOn,
            micOn: p.micOn,
          })) || [],
      });
    } catch (error) {
      console.error('disconnect cleanup error:', error);
    }
  });
});

const PORT = 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`API server running on 0.0.0.0:${PORT}`);
});
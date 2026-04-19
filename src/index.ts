import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL!,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.options('*', cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

// ── Helper: get today's date string ──
const today = () => new Date().toISOString().split('T')[0];

// ── Track daily visit ──
app.post('/api/stats/visit', async (req, res) => {
  try {
    await prisma.dailyStat.upsert({
      where: { date: today() },
      update: { visitors: { increment: 1 } },
      create: { date: today(), visitors: 1, rooms: 0, participants: 0 },
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Visit error:', error);
    res.status(500).json({ error: 'Failed to record visit' });
  }
});

// ── Stats summary + 7-day trend ──
app.get('/api/stats', async (req, res) => {
  try {
    const [totalRooms, totalParticipants, allDailyStats, activeRooms] = await Promise.all([
      prisma.room.count(),
      prisma.participant.count(),
      prisma.dailyStat.findMany({ orderBy: { date: 'asc' } }),
      prisma.room.count({ where: { status: 'ACTIVE' } }),
    ]);

    const totalVisitors = allDailyStats.reduce((sum, d) => sum + d.visitors, 0);

    // Build last 7 days trend — fill missing days with 0
    const now = new Date();
    const trend = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      const dateStr = d.toISOString().split('T')[0];
      const found = allDailyStats.find((s) => s.date === dateStr);
      return {
        date: dateStr.slice(5), // "04-19"
        rooms: found?.rooms ?? 0,
        participants: found?.participants ?? 0,
        visitors: found?.visitors ?? 0,
      };
    });

    res.json({ totalRooms, totalParticipants, totalVisitors, activeRooms, trend });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── Create room ──
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
      include: { participants: true },
    });

    // Track daily room creation — non-blocking
    prisma.dailyStat.upsert({
      where: { date: today() },
      update: { rooms: { increment: 1 } },
      create: { date: today(), rooms: 1, visitors: 0, participants: 0 },
    }).catch((e) => console.error('dailyStat room error:', e));

    res.json({ roomId: room.id, code });
  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// ── Get room info ──
app.get('/api/rooms/:code', async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { code: req.params.code },
      include: { participants: true },
    });

    if (!room) return res.status(404).json({ error: 'Room not found' });

    res.json(room);
  } catch (error) {
    console.error('Get room error:', error);
    res.status(500).json({ error: 'Failed to get room' });
  }
});

// ── Socket.io ──
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

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
            },
          });

          // Track daily participant — non-blocking
          prisma.dailyStat.upsert({
            where: { date: today() },
            update: { participants: { increment: 1 } },
            create: { date: today(), participants: 1, rooms: 0, visitors: 0 },
          }).catch((e) => console.error('dailyStat participant error:', e));

        } else {
          await prisma.participant.updateMany({
            where: { roomId: room.id, userId },
            data: {},
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
        const room = await prisma.room.findUnique({ where: { code: roomCode } });
        if (!room) return;

        await prisma.participant.updateMany({
          where: { roomId: room.id, userId },
          data: { cameraOn, micOn },
        });

        io.to(roomCode).emit('participant-update', { userId, cameraOn, micOn });
      } catch (error) {
        console.error('toggle-media error:', error);
      }
    }
  );

  socket.on('start-meeting', async ({ roomCode }: { roomCode: string }) => {
    try {
      const room = await prisma.room.findUnique({ where: { code: roomCode } });
      if (!room) { socket.emit('error', 'Room not found'); return; }

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
      const room = await prisma.room.findUnique({ where: { code: roomCode } });
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

  socket.on('webrtc-ready', (roomCode: string) => {
    socket.to(roomCode).emit('webrtc-ready');
  });

  socket.on('webrtc-offer', (payload: { roomCode: string; offer: any }) => {
    socket.to(payload.roomCode).emit('webrtc-offer', payload.offer);
  });

  socket.on('webrtc-answer', (payload: { roomCode: string; answer: any }) => {
    socket.to(payload.roomCode).emit('webrtc-answer', payload.answer);
  });

  socket.on('webrtc-ice-candidate', (payload: { roomCode: string; candidate: any }) => {
    socket.to(payload.roomCode).emit('webrtc-ice-candidate', payload.candidate);
  });

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
        where: { roomId: room.id, userId },
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
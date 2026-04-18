"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRoomCode = generateRoomCode;
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

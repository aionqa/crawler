#!/bin/bash

echo "Starting AI Crawler System..."

# Start backend server
echo "Starting backend server..."
cd back && npm run dev &
BACKEND_PID=$!

# Wait a moment for backend to start
sleep 3

# Start frontend
echo "Starting frontend..."
cd ui && npm run dev &
FRONTEND_PID=$!

# Wait a moment for frontend to start
sleep 3

echo "Services started!"
echo "Backend PID: $BACKEND_PID"
echo "Frontend PID: $FRONTEND_PID"
echo ""
echo "To stop all services, run: kill $BACKEND_PID $FRONTEND_PID"
echo ""
echo "Backend should be running on: http://localhost:4000"
echo "Frontend should be running on: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for user to stop
wait

#!/bin/bash

# Setup Graylog user for backend access
GRAYLOG_URL="http://localhost:9000"
ADMIN_USER="admin"
ADMIN_PASS="admin"
BACKEND_USER="aionqa-backend"
BACKEND_PASS="aionqa-backend-2024"

echo "Setting up Graylog user for backend access..."

# Get admin session
echo "Authenticating as admin..."
ADMIN_SESSION=$(curl -s "$GRAYLOG_URL/api/system/sessions" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Requested-By: aionqa-backend" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" | jq -r '.session_id')

if [ "$ADMIN_SESSION" = "null" ] || [ -z "$ADMIN_SESSION" ]; then
  echo "Failed to authenticate as admin"
  exit 1
fi

echo "Admin session: $ADMIN_SESSION"

# Create backend user
echo "Creating backend user..."
USER_CREATE_RESPONSE=$(curl -s "$GRAYLOG_URL/api/users" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Requested-By: aionqa-backend" \
  -H "Authorization: Session $ADMIN_SESSION" \
  -d "{
    \"username\": \"$BACKEND_USER\",
    \"email\": \"backend@aionqa.local\",
    \"full_name\": \"AionQA Backend User\",
    \"password\": \"$BACKEND_PASS\",
    \"permissions\": [
      \"users:list\",
      \"users:edit\",
      \"users:tokenlist\",
      \"users:tokencreate\",
      \"users:tokenremove\",
      \"streams:read\",
      \"streams:create\",
      \"streams:edit\",
      \"streams:delete\",
      \"indices:read\",
      \"indices:create\",
      \"indices:edit\",
      \"indices:delete\",
      \"system:read\",
      \"system:edit\",
      \"inputs:read\",
      \"inputs:create\",
      \"inputs:edit\",
      \"inputs:delete\",
      \"outputs:read\",
      \"outputs:create\",
      \"outputs:edit\",
      \"outputs:delete\",
      \"lookuptables:read\",
      \"lookuptables:create\",
      \"lookuptables:edit\",
      \"lookuptables:delete\",
      \"roles:read\",
      \"roles:create\",
      \"roles:edit\",
      \"roles:delete\",
      \"sessions:list\",
      \"sessions:edit\",
      \"sessions:delete\"
    ]
  }")

echo "User creation response: $USER_CREATE_RESPONSE"

# Test the new user
echo "Testing backend user authentication..."
BACKEND_SESSION=$(curl -s "$GRAYLOG_URL/api/system/sessions" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Requested-By: aionqa-backend" \
  -d "{\"username\":\"$BACKEND_USER\",\"password\":\"$BACKEND_PASS\"}" | jq -r '.session_id')

if [ "$BACKEND_SESSION" = "null" ] || [ -z "$BACKEND_SESSION" ]; then
  echo "Failed to authenticate as backend user"
  exit 1
fi

echo "Backend user session: $BACKEND_SESSION"

# Test search API with backend user
echo "Testing search API with backend user..."
SEARCH_RESPONSE=$(curl -s "$GRAYLOG_URL/api/search/universal/relative" \
  -H "Authorization: Session $BACKEND_SESSION" \
  -H "Accept: application/json" \
  -H "X-Requested-By: aionqa-backend" \
  -G \
  -d "query=*" \
  -d "range=300" \
  -d "limit=1")

echo "Search test response: $SEARCH_RESPONSE"

echo "✅ Graylog user setup complete!"
echo "Backend user: $BACKEND_USER"
echo "Backend password: $BACKEND_PASS"
echo ""
echo "Update your backend configuration to use these credentials."

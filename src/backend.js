import axios from 'axios';

// Get backend URL from environment or use default
const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';

/**
 * Upload logs to backend
 * @param {string} endpoint - Backend endpoint URL
 * @param {Array} logs - Array of log entries
 */
export async function uploadLogs(endpoint, logs) {
  try {
    console.log(`[BACKEND] 📤 Uploading ${logs.length} log entries to ${endpoint}`);
    
    const response = await axios.post(endpoint, {
      type: 'logs',
      data: logs,
      timestamp: new Date().toISOString()
    }, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.status === 200) {
      console.log(`[BACKEND] ✅ Logs uploaded successfully`);
    } else {
      console.log(`[BACKEND] ⚠️ Unexpected response status: ${response.status}`);
    }
  } catch (error) {
    console.error(`[BACKEND] ❌ Failed to upload logs:`, error.message);
    throw error;
  }
}

/**
 * Upload screenshot to backend
 * @param {string} endpoint - Backend endpoint URL
 * @param {Buffer} screenshotBuffer - Screenshot image buffer
 * @param {Object} metadata - Screenshot metadata
 */
export async function uploadScreenshot(endpoint, screenshotBuffer, metadata = {}) {
  try {
    console.log(`[BACKEND] 📤 Uploading screenshot to ${endpoint}`);
    
    const formData = new FormData();
    const blob = new Blob([screenshotBuffer], { type: 'image/png' });
    formData.append('file', blob, metadata.filename || `screenshot-${Date.now()}.png`);
    formData.append('type', 'screenshot');
    formData.append('metadata', JSON.stringify(metadata));

    const response = await axios.post(endpoint, formData, {
      timeout: 30000,
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    });

    if (response.status === 200) {
      console.log(`[BACKEND] ✅ Screenshot uploaded successfully`);
      return response.data;
    } else {
      console.log(`[BACKEND] ⚠️ Unexpected response status: ${response.status}`);
      return null;
    }
  } catch (error) {
    console.error(`[BACKEND] ❌ Failed to upload screenshot:`, error.message);
    throw error;
  }
}

/**
 * Upload video to backend
 * @param {string} endpoint - Backend endpoint URL
 * @param {Buffer} videoBuffer - Video file buffer
 * @param {Object} metadata - Video metadata
 */
export async function uploadVideo(endpoint, videoBuffer, metadata = {}) {
  try {
    console.log(`[BACKEND] 📤 Uploading video to ${endpoint}`);
    
    const formData = new FormData();
    const blob = new Blob([videoBuffer], { type: 'video/webm' });
    formData.append('file', blob, metadata.filename || `video-${Date.now()}.webm`);
    formData.append('type', 'video');
    formData.append('metadata', JSON.stringify(metadata));

    const response = await axios.post(endpoint, formData, {
      timeout: 60000, // Longer timeout for video uploads
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    });

    if (response.status === 200) {
      console.log(`[BACKEND] ✅ Video uploaded successfully`);
      return response.data;
    } else {
      console.log(`[BACKEND] ⚠️ Unexpected response status: ${response.status}`);
      return null;
    }
  } catch (error) {
    console.error(`[BACKEND] ❌ Failed to upload video:`, error.message);
    throw error;
  }
}

/**
 * Stream frame to backend for live video
 * @param {string} endpoint - Backend endpoint URL
 * @param {Buffer} frameBuffer - Frame image buffer
 * @param {Object} metadata - Frame metadata
 */
export async function streamFrame(endpoint, frameBuffer, metadata = {}) {
  try {
    const frameData = {
      type: 'frame',
      imageData: frameBuffer.toString('base64'),
      metadata: {
        timestamp: new Date().toISOString(),
        ...metadata
      }
    };

    const response = await axios.post(endpoint, frameData, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.status === 200) {
      // Don't log every frame to avoid spam
      return response.data;
    } else {
      console.log(`[BACKEND] ⚠️ Unexpected response status for frame: ${response.status}`);
      return null;
    }
  } catch (error) {
    // Don't log frame streaming errors to avoid spam
    // console.error(`[BACKEND] ❌ Failed to stream frame:`, error.message);
    throw error;
  }
}

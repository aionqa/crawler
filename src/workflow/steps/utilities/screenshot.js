/**
 * Execute Screenshot Step
 * Captures a screenshot of the current page
 */

import axios from 'axios';

export async function executeScreenshotStep(page, step, workflowState, jobId, pageId, workflowAnalyzer) {
  console.log(`📸 Taking screenshot (${step.name})`);
  const config = step.config || {};
  const fullPage = config.fullPage !== false;
  const upload = config.upload !== false;
  const format = (config.format || config.type || 'png').toLowerCase();
  const quality = typeof config.quality === 'number' ? config.quality : 90;

  const screenshotOptions = {
    fullPage,
    type: format === 'jpeg' || format === 'jpg' ? 'jpeg' : 'png'
  };

  if (screenshotOptions.type === 'jpeg' && typeof quality === 'number') {
    screenshotOptions.quality = quality;
  }

  console.log('Screenshot options resolved:', screenshotOptions);

  const screenshot = await page.screenshot(screenshotOptions);

  workflowState.screenshotBase64 = screenshot.toString('base64');
  console.log(`✅ Screenshot taken (${screenshot.length} bytes)`);

  let uploaded = false;
  let publicUrl = null;
  let fileId = null;

  if (upload) {
    try {
      console.log(`📸 Requesting presigned URL for screenshot upload...`);

      const mimeType = screenshotOptions.type === 'jpeg' ? 'image/jpeg' : 'image/png';

      const presignedResponse = await axios.post(`${workflowAnalyzer.backendUrl}/api/upload/presigned-url`, {
        type: 'screenshot',
        jobId: jobId,
        contentType: mimeType
      }, {
        timeout: 10000,
        headers: workflowAnalyzer.getAuthHeaders()
      });

      const { url: presignedUrl, key, publicUrl: returnedUrl } = presignedResponse.data;
      workflowState.screenshotFileId = key;
      workflowState.screenshotUrl = returnedUrl;
      fileId = key;
      publicUrl = returnedUrl;

      await axios.put(presignedUrl, screenshot, {
        headers: { 'Content-Type': mimeType },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30000
      });

      uploaded = true;
      console.log(`✅ Screenshot uploaded to MinIO: ${returnedUrl}`);

      if (pageId) {
        await axios.post(`${workflowAnalyzer.backendUrl}/api/pages/${pageId}/screenshot`, {
          fileId: workflowState.screenshotFileId,
          jobId: jobId
        }, {
          timeout: 10000,
          headers: workflowAnalyzer.getAuthHeaders()
        });

        console.log(`✅ Page ${pageId} updated with screenshot`);
      }
    } catch (error) {
      console.error(`❌ Failed to upload screenshot: ${error.message}`);
    }
  }

  // Store result - storeStepResult will structure it according to schema
  const result = {
    screenshot_url: publicUrl || null,
    screenshot_file_id: fileId || null,
    screenshot_base64: uploaded ? null : screenshot.toString('base64'),
    size_bytes: screenshot.length,
    uploaded: uploaded
  };
  
  workflowAnalyzer.storeStepResult(step, result, workflowState);

  // Create screenshot attachment for display in job history
  const screenshotAttachments = [];
  if (uploaded && publicUrl) {
    // If uploaded, create attachment with reference to the uploaded file
    screenshotAttachments.push({
      type: 'screenshot',
      filename: `screenshot_${fileId || Date.now()}.png`,
      screenshot_id: fileId,
      screenshot_url: publicUrl,
      mimeType: 'image/png',
      size: screenshot.length,
      timestamp: new Date().toISOString()
    });
  } else if (screenshot) {
    // If not uploaded, include base64 screenshot data
    screenshotAttachments.push({
      type: 'screenshot',
      filename: `screenshot_${Date.now()}.png`,
      content: screenshot.toString('base64'),
      mimeType: 'image/png',
      size: screenshot.length,
      timestamp: new Date().toISOString()
    });
  }

  // Prepare metadata with all screenshot URL fields for UI detection
  // Construct screenshot URL - prefer publicUrl, fallback to backend /files endpoint
  let screenshotUrl = null;
  if (publicUrl) {
    screenshotUrl = publicUrl;
  } else if (fileId) {
    // fileId is the full object name (e.g., "screenshots/jobId/timestamp.png")
    // The /files/:objectName endpoint can handle this, but we need to URL encode it
    screenshotUrl = `${workflowAnalyzer.backendUrl}/files/${encodeURIComponent(fileId)}`;
  }
  
  const screenshotMetadata = {
    uploaded,
    fileId,
    fullPage,
    quality,
    size_bytes: screenshot.length,
    // Add all screenshot ID fields for UI detection
    screenshotId: fileId,
    screenshot_id: fileId,
    screenshotKey: fileId,
    screenshot_file_id: fileId,
    // Add all screenshot URL fields for UI detection
    screenshot_url: screenshotUrl,
    screenshotPath: screenshotUrl,
    screenshotUrl: screenshotUrl,
    isScreenshot: true // Flag to indicate this is a screenshot log
  };

  await workflowAnalyzer.logStepOutcome(
    step,
    jobId,
    uploaded
      ? `📸 [SCREENSHOT] Uploaded screenshot (${screenshot.length} bytes)`
      : `📸 [SCREENSHOT] Captured screenshot locally (${screenshot.length} bytes)`,
    screenshotMetadata,
    'info',
    screenshotAttachments
  );
}





















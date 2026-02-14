import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { postTweet, postTweetWithMedia, type XPostResult } from '../../infra/x/postPublisher.js';
import { uploadTweetImage } from '../../infra/x/mediaUpload.js';
import { generateImageFromPrompt } from '../../infra/xai/imageGenerator.js';
import { writeXNotificationFromLore } from './xNotificationWriter.js';

export type XLorePublishResult = XPostResult & {
  text?: string;
  mediaId?: string;
  error?: string;
};

export async function publishLoreToX(markdown: string, batchId: string): Promise<XLorePublishResult> {
  // Always publish the post if we can produce xNotification.
  // If image generation/upload fails, fall back to text-only tweet (no wasted batch).
  // NOTE: This function is kept for compatibility but should not be used in the batch pipeline,
  // because xNotification now requires explicit account IDs.
  const text = await writeXNotificationFromLore(markdown, batchId, []);
  return await publishLoreToXWithText(markdown, batchId, text);
}

export async function publishLoreToXWithText(
  markdown: string,
  batchId: string,
  text: string,
  imagePrompt?: string
): Promise<XLorePublishResult> {
  logger.info('x_notification_text', { batchId, chars: text.length, text });

  if (!config.xEnableImages) {
    logger.info('x_campaign_posting_text_only', { batchId, chars: text.length, reason: 'images_disabled' });
    const res = await postTweet(text);
    logger.info('x_campaign_posted', { batchId, tweetId: res.tweetId, url: res.url });
    return { ...res, text };
  }

  try {
    logger.info('x_campaign_generating_image', { batchId });
    if (!imagePrompt?.trim()) {
      throw new Error('x_campaign_image_prompt_missing');
    }
    const img = await generateImageFromPrompt(imagePrompt);

    logger.info('x_campaign_uploading_image', { batchId, bytes: img.bytes.length });
    const uploaded = await uploadTweetImage(img.bytes, img.mimeType);

    logger.info('x_campaign_posting', { batchId, chars: text.length, mediaIdLast6: uploaded.mediaIdString.slice(-6) });
    const res = await postTweetWithMedia(text, [uploaded.mediaIdString]);
    logger.info('x_campaign_posted', { batchId, tweetId: res.tweetId, url: res.url });
    return { ...res, text, mediaId: uploaded.mediaIdString };
  } catch (err) {
    const error = String(err);
    logger.warn('x_campaign_media_failed_fallback_text', { batchId, error });

    // Fallback: publish text-only tweet.
    logger.info('x_campaign_posting_text_only', { batchId, chars: text.length });
    const res = await postTweet(text);
    logger.info('x_campaign_posted', { batchId, tweetId: res.tweetId, url: res.url });
    return { ...res, text, error };
  }
}


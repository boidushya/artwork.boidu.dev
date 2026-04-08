import { log, Tag } from './logger';

interface StreamInfo {
  bandwidth: number;
  url: string;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export async function resolveVideoUrl(m3u8Url: string): Promise<string | null> {
  try {
    log.debug(Tag.M3U8, '→ master playlist');
    const masterStart = Date.now();
    const masterResponse = await fetch(m3u8Url, { headers: { 'User-Agent': UA } });
    log.debug(Tag.M3U8, '← master', { status: masterResponse.status, ms: Date.now() - masterStart });

    if (!masterResponse.ok) {
      log.error(Tag.M3U8, 'master playlist fetch failed', { status: masterResponse.status });
      return null;
    }

    const masterContent = await masterResponse.text();
    const baseUrl = getBaseUrl(m3u8Url);

    const streams = parseStreamVariants(masterContent, baseUrl);

    if (streams.length === 0) {
      log.debug(Tag.M3U8, 'no stream variants — treating as media playlist directly');
      const segment = extractFirstSegment(masterContent, baseUrl);
      if (segment) log.info(Tag.M3U8, 'resolved direct segment');
      else log.warn(Tag.M3U8, 'no segment extracted');
      return segment;
    }

    streams.sort((a, b) => b.bandwidth - a.bandwidth);
    const bestStream = streams[0];
    log.debug(Tag.M3U8, 'selected best stream', {
      bandwidth: bestStream.bandwidth,
      variants: streams.length,
    });

    const mediaStart = Date.now();
    log.debug(Tag.M3U8, '→ media playlist');
    const mediaResponse = await fetch(bestStream.url, { headers: { 'User-Agent': UA } });
    log.debug(Tag.M3U8, '← media', { status: mediaResponse.status, ms: Date.now() - mediaStart });

    if (!mediaResponse.ok) {
      log.error(Tag.M3U8, 'media playlist fetch failed', { status: mediaResponse.status });
      return null;
    }

    const mediaContent = await mediaResponse.text();
    const mediaBaseUrl = getBaseUrl(bestStream.url);
    const segment = extractFirstSegment(mediaContent, mediaBaseUrl);

    if (segment) {
      log.info(Tag.M3U8, 'resolved video url', { bandwidth: bestStream.bandwidth });
    } else {
      log.warn(Tag.M3U8, 'no segment extracted from media playlist');
    }
    return segment;
  } catch (error) {
    log.error(Tag.M3U8, 'resolve failed', error);
    return null;
  }
}

function parseStreamVariants(content: string, baseUrl: string): StreamInfo[] {
  const streams: StreamInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      // Parse bandwidth
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
      if (!bandwidthMatch) continue;

      const bandwidth = parseInt(bandwidthMatch[1], 10);

      // Next non-empty, non-comment line should be the URL
      for (let j = i + 1; j < lines.length; j++) {
        const urlLine = lines[j].trim();
        if (urlLine && !urlLine.startsWith('#')) {
          const url = resolveUrl(urlLine, baseUrl);
          streams.push({ bandwidth, url });
          break;
        }
      }
    }
  }

  return streams;
}

function extractFirstSegment(content: string, baseUrl: string): string | null {
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments (except we're looking for segment files)
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // This should be a segment URL (usually .ts, .mp4, or .m4s)
    if (trimmed.endsWith('.ts') || trimmed.endsWith('.mp4') || trimmed.endsWith('.m4s') || trimmed.includes('.')) {
      return resolveUrl(trimmed, baseUrl);
    }
  }

  return null;
}

function getBaseUrl(url: string): string {
  const lastSlash = url.lastIndexOf('/');
  return lastSlash !== -1 ? url.substring(0, lastSlash + 1) : url;
}

function resolveUrl(path: string, baseUrl: string): string {
  // If it's already an absolute URL, return as-is
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  // Handle protocol-relative URLs
  if (path.startsWith('//')) {
    return 'https:' + path;
  }

  // Handle root-relative URLs
  if (path.startsWith('/')) {
    const urlObj = new URL(baseUrl);
    return `${urlObj.protocol}//${urlObj.host}${path}`;
  }

  // Relative URL - append to base
  return baseUrl + path;
}

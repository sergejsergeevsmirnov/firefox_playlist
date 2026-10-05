// Injected into YouTube's MAIN world to mint a content-bound PoToken.
// This mirrors bgutil-ytdlp-pot-provider (used by yt-dlp / YTDLnis).
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import type { WebPoSignalOutput } from 'bgutils-js/shared-types';
import { buildURL, getHeaders } from 'bgutils-js/utils';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

export interface PotChallenge {
  program: string;
  globalName: string;
}

async function generatePot(videoId: string, challenge: PotChallenge): Promise<string> {
  const botGuardClient = await BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: globalThis as unknown as Record<string, unknown>,
  });
  const webPoSignalOutput: WebPoSignalOutput = [];
  const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });
  const payload = [REQUEST_KEY, botguardResponse];
  const response = await fetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`GenerateIT failed: HTTP ${response.status}`);
  const json = (await response.json()) as [string, number, number, string];
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = json;
  const webPoMinter = await WebPoMinter.create(
    { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
    webPoSignalOutput,
  );
  return webPoMinter.mintAsWebsafeString(videoId);
}

(globalThis as unknown as Record<string, unknown>).__ytGenPot = generatePot;

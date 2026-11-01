import { AzureSpeechProvider, FakeSpeechProvider, VoiceGateway } from '@dinext/voice';
import { startLiveRuntime } from './live.ts';
import { startMockServer } from './server.ts';

const port = Number(process.env.MOCK_PORT ?? 8787);
// DI_SCRIPTED=1 keeps every turn on scripted scenarios, for front-end work without the warehouse.
// --offline keeps the warehouse and agents but uses the deterministic planners, at no API cost.
const offline = process.argv.includes('--offline');
const live = process.env.DI_SCRIPTED === '1' ? null : await startLiveRuntime({ offline }).catch((err) => (console.warn(`Tenant warehouse unavailable (${(err as Error).message}); using scripted scenarios.`), null));

// Voice goes through Azure AI Speech when its key and region are set (spec 7.2).
const speechKey = process.env.DI_AZURE_SPEECH_KEY;
const speechRegion = process.env.DI_AZURE_SPEECH_REGION;
// --fake-voice (developer only): the recogniser "hears" these phrases in turn and speech is silent,
// so the voice UI can be exercised without a speech service. No audio is interpreted.
const fakeVoice = process.argv.includes('--fake-voice')
  ? new FakeSpeechProvider(['show loan growth by branch for q three versus q two', 'refer suzanne jackson for a heloc she prefers email', 'confirm', 'brief me', 'pull up member ending four five two one'])
  : null;
const voice = new VoiceGateway({
  provider: fakeVoice ?? (speechKey && speechRegion ? new AzureSpeechProvider({ key: speechKey, region: speechRegion, voice: process.env.DI_AZURE_SPEECH_VOICE }) : null),
  language: process.env.DI_SPEECH_LANGUAGE ?? 'en-US',
  unavailableReason: 'Voice needs Azure AI Speech: set DI_AZURE_SPEECH_KEY and DI_AZURE_SPEECH_REGION in app/.env.',
});

// In a deployed container the server also serves the built shell, behind an optional demo code.
startMockServer({ port, live, voice, staticDir: process.env.DI_STATIC_DIR, accessCode: process.env.DI_DEMO_ACCESS_CODE || undefined, perBrowser: true });
const mode = !live ? 'scripted scenarios (run `npm run db:up && npm run db:seed` for live agents)' : live.mode === 'live' ? 'live agents on Claude' : offline ? 'offline planner (--offline, no API calls)' : 'offline planner (set DI_ANTHROPIC_API_KEY in app/.env for Claude)';
console.log(`DI Next Experience server on http://localhost:${port} (WS /v1/stream): ${mode}; voice: ${voice.providerName ?? 'off (no Azure Speech key)'}${process.env.DI_STATIC_DIR ? '; serving the shell' : ''}${process.env.DI_DEMO_ACCESS_CODE ? '; demo access code on' : ''}`);

export type { SpeechProvider, RecognitionHandlers, RecognitionSession, SynthesisHandlers } from './provider.ts';
export { AzureSpeechProvider, type AzureSpeechOptions } from './azure.ts';
export { FakeSpeechProvider } from './fake.ts';
export { normaliseTranscript, classifyConfirmation, type Normalised } from './normalise.ts';
export { speakable, sentences, approvalReadBack, PHRASES, DATA_DATE } from './speakable.ts';
export { VoiceGateway, type VoiceStatus } from './gateway.ts';

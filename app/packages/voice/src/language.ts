// Browser-safe part of the voice package: language rules only, no Node or speech SDK imports.
export { normaliseTranscript, classifyConfirmation, type Normalised } from './normalise.ts';
export { speakable, sentences, approvalReadBack, PHRASES, DATA_DATE } from './speakable.ts';

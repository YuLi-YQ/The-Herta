const SPEAKER_DELIM = /^([^：:\n]{1,20})\s*[：:]\s*(.+)$/;
const URL_LIKE = /^https?:\/\//i;

export interface SpeakerLine {
  speaker: string;
  text: string;
}

export function parseSpeakerLine(raw: string): SpeakerLine | null {
  const line = raw.trim();
  if (line.length === 0) return null;
  if (URL_LIKE.test(line)) return null;
  const m = SPEAKER_DELIM.exec(line);
  if (m === null) return null;
  const speakerRaw = m[1];
  const textRaw = m[2];
  if (speakerRaw === undefined || textRaw === undefined) return null;
  const speaker = speakerRaw.trim();
  const text = textRaw.trim();
  if (speaker.length === 0 || text.length === 0) return null;
  return { speaker, text };
}

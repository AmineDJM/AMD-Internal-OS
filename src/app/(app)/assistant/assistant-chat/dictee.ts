"use client";

/**
 * LA CONVERSATION — la DICTÉE : on parle, Whisper transcrit, le texte arrive dans la zone de
 * saisie (éditable). Un crochet appelé à la même place que le code qu'il remplace : l'ordre
 * des crochets de `AssistantChat` est inchangé.
 */
import * as React from "react";

export function useDictee(
  setInput: React.Dispatch<React.SetStateAction<string>>,
  taRef: React.RefObject<HTMLTextAreaElement | null>,
) {
  // ── Dictée vocale : on parle, Whisper transcrit, le texte arrive dans la zone de saisie
  //    (ÉDITABLE) — l'utilisateur relit/corrige avant d'envoyer. L'audio n'est pas conservé.
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const [voiceMsg, setVoiceMsg] = React.useState<string | null>(null);
  const mr = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);

  const startRec = async () => {
    setVoiceMsg(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setVoiceMsg("Le micro nécessite une connexion sécurisée (HTTPS). Vous pouvez aussi écrire votre message.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      rec.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); await transcribe(new Blob(chunks.current, { type: rec.mimeType || "audio/webm" })); };
      rec.start(); mr.current = rec; setRecording(true);
    } catch {
      setVoiceMsg("Micro inaccessible — autorisez-le dans le navigateur, ou écrivez votre message.");
    }
  };
  const stopRec = () => { mr.current?.stop(); setRecording(false); };

  const transcribe = async (blob: Blob) => {
    setTranscribing(true); setVoiceMsg(null);
    try {
      const f = new FormData(); f.set("file", blob, "audio.webm");
      const res = await fetch("/api/assistant/transcribe", { method: "POST", body: f });
      const data = await res.json();
      if (data.transcript) {
        setInput((prev) => (prev.trim() ? `${prev.trim()} ${data.transcript}` : data.transcript));
        taRef.current?.focus();
      } else setVoiceMsg(data.error ?? "Transcription indisponible — vous pouvez écrire à la main.");
    } catch {
      setVoiceMsg("Envoi de l'audio impossible.");
    } finally {
      setTranscribing(false);
    }
  };
  return { recording, transcribing, voiceMsg, startRec, stopRec };
}

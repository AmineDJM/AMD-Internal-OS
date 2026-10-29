/**
 * LES MÉDIAS, côté plateforme (mandat 4 §30) — la porte par laquelle Adam LIT une image, un scan,
 * une photo : l'OCR réel de la maison (`regulatory/intelligence/ocr`, Tesseract local + secours
 * vision Luna sur les pages faibles) et l'appel vision Luna (`openai-luna`). Le pont peut connaître
 * ces modules ; `lib/assistant*` n'y ajoute pas d'import direct.
 */
export { ocrDocument, canOcr, type OcrResult, type OcrPage } from "@/lib/regulatory/intelligence/ocr/ocr-engine";
export { callLuna, lunaConfigured, lunaModel, type LunaCallInput, type LunaImage, type LunaResult } from "@/lib/openai-luna";
// L'audio et la vidéo (mandat 5 §38) : la parole en segments horodatés et sa mise en forme — pour Adam, par le pont.
export { estMedia, estVideo, transcrireAvecSegments, type ResultatStt } from "@/lib/media/stt";
export { formatHorodatage, texteHorodate, type Segment } from "@/lib/media/transcription";

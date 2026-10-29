/**
 * LA CONVERSATION — ce qu'elle emprunte à l'ERP (le bouton du kit, les actions serveur de
 * l'assistant), en UN seul point. Le fichier d'un seul tenant franchissait la frontière Adam ↔ ERP
 * une fois par cible (`platform/boundary-scan.ts`) ; découpé, chaque morceau la franchirait à son
 * tour. Les morceaux importent donc d'ici : une cible, un franchissement, comme avant.
 */
export { Button } from "@/components/ui/button";
export {
  assistantChat, assistantDirectIntent, executeAssistantAction, executeAssistantBundle, cancelAssistantAction, listAssistantFiles,
  myAssistantThreads, myAssistantThread, deleteMyAssistantThread, forgetMyAssistantMemory,
} from "@/lib/actions/assistant-actions";

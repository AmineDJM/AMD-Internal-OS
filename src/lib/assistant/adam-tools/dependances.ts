/**
 * LES DÉPENDANCES ERP de les outils d'Adam — la seule porte par laquelle ce dossier franchit la frontière
 * Adam ↔ ERP (et celle entre domaines) : une fois par module, comme le faisait le fichier d'origine
 * avant son découpage. Les cliquets `src/platform/boundary.test.ts` et `domains.test.ts` comptent
 * chaque import par fichier ; les morceaux importent d'ici plutôt que de répéter ces imports.
 */
export type { CurrentUser } from "@/lib/session";
export { getActiveGoogleConnection, getGoogleStatus } from "@/lib/google/connection";
export { getThread } from "@/lib/google/gmail/messages";
export {
  activeMissions, MISSION_STATUS_LABEL, createMission, missionSnapshot, setMissionExtracted,
  nudgeCandidates,
} from "@/lib/comms/missions";
export { prisma } from "@/lib/prisma";
export { listEvents, freeBusy, findFreeSlots, ALGIERS_TZ } from "@/lib/google/calendar/provider";
export { searchFiles, downloadFile, uploadFile as uploadToGoogleDrive } from "@/lib/google/drive/provider";
export { wrapUntrusted, wrapAttachmentText } from "@/lib/comms/untrusted";
export { getBlob } from "@/lib/drive-storage";
export { resolveDriveAccess, canViewDrive } from "@/lib/drive";
export {
  createDoc, appendToDoc, readDocText, createSheetFromTable, createPresentation, addSlide, searchContacts,
} from "@/lib/google/workspace/provider";
export { adamConnection } from "@/lib/google/gmail/reconcile";
export { addLabels, archiveMessage, ensureLabel, markRead, trashMessage } from "@/lib/google/gmail/labels";
export { createOutboundIntent, pendingApprovals } from "@/lib/comms/outbound";
export { getCommunicationPolicy, POLICY_LABEL } from "@/lib/comms/policy";
export { shouldReplyTo, checkRateLimits } from "@/lib/comms/loop-safety";

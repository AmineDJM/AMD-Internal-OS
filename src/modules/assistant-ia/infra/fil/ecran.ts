import type { CurrentUser } from "@/lib/session";
import { idsDriveCites } from "../../domaine/lecture/depot";
import { piecesCitees } from "../operations/pieces";
import { propositionsParIds, type PropositionNote } from "../notes/propositions";
import { souvenirsParIds, type MemoireRetenue } from "../memoire";
import { orchestrationDuFil } from "../orchestration/ecrit";
import type { lireFil } from "./service";

/**
 * CE QUE L'ÉCRAN DE LA PERSONNE REÇOIT DE SON FIL — la route `/api/assistant-ia/fil` et l'ESSAI de son agent par le Super
 * Admin (« Essayer l'agent de… ») passent par cette même fonction : l'essai montre ce que son écran aurait montré, pièces
 * renvoyées (droits revérifiés au nom de la personne), notes proposées et souvenirs retenus dans leur état présent compris.
 */
export async function filPourEcran(user: CurrentUser, fil: Awaited<ReturnType<typeof lireFil>>) {
  // LES PIÈCES RENVOYÉES PAR L'ASSISTANT (décision 0015) : les fichiers du Drive cités par une réponse
  // terminée ou par le résultat d'une action exécutée — droits revérifiés, ouvrables dans l'aperçu.
  const rendues = new Map<string, { id: string; nom: string }[]>();
  for (const t of fil.tours) {
    if (t.role !== "assistant" || t.etat === "EN_COURS") continue;
    // C1 : le résultat de CHAQUE carte exécutée du tour (plusieurs cartes possibles).
    const liens = t.intents.map((c) => (c as { resultLink?: string }).resultLink).filter((l): l is string => !!l);
    const ids = idsDriveCites(t.contenu, ...liens);
    if (ids.length) rendues.set(t.id, await piecesCitees(user, ids));
  }
  // « MES NOTES » (décision 0026) : les modifications proposées par un tour, dans leur état présent (la carte).
  const idsNotes = fil.tours.flatMap((t) => (Array.isArray(t.notesProposees) ? (t.notesProposees as unknown[]).filter((x): x is string => typeof x === "string") : []));
  const notes = new Map((await propositionsParIds(user.id, idsNotes)).map((p) => [p.id, p]));
  const notesDu = (v: unknown): PropositionNote[] | null => {
    const ps = Array.isArray(v) ? v.flatMap((id) => (typeof id === "string" && notes.has(id) ? [notes.get(id)!] : [])) : [];
    return ps.length ? ps : null;
  };
  // M1 (décision 0045) : les souvenirs retenus d'office par un tour, dans leur état présent (annulés depuis, ou non).
  const idsSouvenirs = fil.tours.flatMap((t) => (Array.isArray(t.memoiresRetenues) ? (t.memoiresRetenues as { id?: unknown }[]).map((m) => m?.id).filter((x): x is string => typeof x === "string") : []));
  const souvenirs = await souvenirsParIds(user.id, idsSouvenirs);
  const retenusDu = (v: unknown): MemoireRetenue[] | null => {
    const ms = Array.isArray(v) ? (v as MemoireRetenue[]).filter((m) => m && typeof m.id === "string") : [];
    return ms.length ? ms.map((m) => {
      const e = souvenirs.get(m.id);
      return { id: m.id, sorte: e?.sorte ?? m.sorte, contenu: e?.contenu ?? m.contenu, geste: m.geste === "remplace" ? "remplace" : "ajoute", annule: !e, depasse: !!e && !e.actif };
    }) : null;
  };
  // O1 (décision 0046) : la question de l'agenda qui attend, les réponses tenues, l'avancement du travail long.
  const orchestration = await orchestrationDuFil(user.id, fil.conversation.id);
  return {
    vueExacte: false,
    enCours: fil.enCours,
    orchestration,
    reponseVocale: fil.reponseVocale,
    conversation: fil.conversation,
    tours: fil.tours.map((t) => ({
      id: t.id, role: t.role, contenu: t.contenu, etat: t.etat, pieces: t.pieces, blocs: t.blocs, intent: t.intent,
      // C1 (décision 0068) : TOUTES les cartes de la réponse, relues dans la table des intentions.
      intents: t.intents,
      memoireProposee: t.memoireProposee, outils: t.outils, etapes: t.etapes, createdAt: t.createdAt.toISOString(),
      vocal: t.vocal, lecture: t.lecture, audio: t.audio, piecesRendues: rendues.get(t.id) ?? null, notesProposees: notesDu(t.notesProposees),
      // K3 (décision 0033) : les sous-missions du tour (la carte les lit en temps réel par le flux du tableau de bord).
      travaux: Array.isArray(t.travaux) ? (t.travaux as unknown[]).filter((x): x is string => typeof x === "string") : null,
      synthese: !!t.syntheseDe,
      memoiresRetenues: retenusDu(t.memoiresRetenues),
    })),
  };
}

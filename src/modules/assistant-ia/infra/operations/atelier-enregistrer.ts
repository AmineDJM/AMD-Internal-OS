import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { fold } from "@/platform/ia/outils/arguments";
import { ongletDesigne } from "@/platform/ia/artifact/store";
import { persistActionIntents } from "@/platform/ia/intentions/action-intents";
import { documentSensible, droitsSurDocument, enregistrerAtelier, PREFIXE_ATELIER } from "@/platform/ia/artifact/atelier/service";
import { champs, texte, type ChargeOperationIA, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ENREGISTRER UN DOCUMENT DE L'ATELIER (J3) — la carte de confirmation.
 *
 * Enregistrer = une NOUVELLE version Drive (`FileVersion`), jamais un écrasement ; la Bibliothèque la
 * reçoit (port du Live Office). Deux chemins mènent à cette carte :
 *   • l'assistant la propose (« enregistre le contrat ») — toute écriture du modèle est une carte ;
 *   • le bouton « Enregistrer » de l'Atelier, quand le document est rattaché à un OBJET MÉTIER (pièce
 *     juridique, courrier, espace partagé) : le clic ne suffit pas, la carte dit pourquoi.
 * Sur un document ordinaire, le bouton enregistre directement (le clic EST l'intention, §78).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'onglet désigné par sa référence, son nœud — ou son NOM (le modèle dit « le contrat de prestation Atlas »). */
async function onglet(userId: string, ref: string) {
  const direct = await ongletDesigne(userId, PREFIXE_ATELIER, ref);
  if (direct) return direct;
  const q = fold(ref.replace(/\.[a-z0-9]{2,5}$/i, ""));
  if (!q) return null;
  const ouverts = await prisma.artifactSession.findMany({ where: { userId, blockId: { startsWith: PREFIXE_ATELIER }, state: { not: "CLOSED" } }, select: { id: true, name: true }, orderBy: { updatedAt: "desc" }, take: 20 });
  const hits = ouverts.filter((o) => fold(o.name).includes(q));
  return hits.length === 1 ? ongletDesigne(userId, PREFIXE_ATELIER, hits[0]!.id) : null;
}

/** L'UNIQUE document modifié et non enregistré de la personne dans l'Atelier — `null` s'il y en a zéro ou plusieurs. */
async function seulDocumentModifie(userId: string): Promise<string | null> {
  const s = await prisma.artifactSession.findMany({ where: { userId, blockId: { startsWith: PREFIXE_ATELIER }, state: { not: "CLOSED" }, dirty: true }, select: { id: true }, take: 2 });
  return s.length === 1 ? s[0]!.id : null;
}

async function proposer(e: Record<string, unknown>, user: CurrentUser): Promise<PropositionOperation> {
  // « Enregistre » sans dire lequel (banc T1, DOC-22) : l'UNIQUE document modifié et non enregistré de la personne — sinon on demande.
  const ref = texte(e, "document") || (await seulDocumentModifie(user.id)) || "";
  if (!ref) return { manque: ["le document à enregistrer"] };
  const s = await onglet(user.id, ref);
  if (!s) return { erreur: "Ce document n'est pas ouvert dans l'Atelier." };
  if (!s.dirty) return { erreur: `« ${s.name} » n'a aucune modification à enregistrer.` };
  const droits = await droitsSurDocument(user.id, s.nodeId);
  if (!droits.modifier) return { erreur: "Vous n'avez pas le droit de modifier ce document dans le Drive." };
  const sensible = await documentSensible(s.nodeId);
  const depart = s.savedVersion ?? s.baseVersion;
  return {
    carte: {
      title: `Enregistrer une nouvelle version — ${s.name}`,
      fields: champs([
        ["Document", s.name],
        ["Modifications", `${s._count.operations} (non refusées)`],
        ["Version", `${depart} → nouvelle version ${depart + 1} (la ${depart} reste ouvrable)`],
      ]),
      warnings: sensible ? [`Document sensible : ${sensible}. Relisez les modifications avant de confirmer.`] : [],
      ...(sensible ? { level: "SENSITIVE" as const } : {}),
      libelleBouton: "Enregistrer la nouvelle version",
    },
    args: { sessionId: s.id, nom: s.name },
  };
}

export const ENREGISTRER_ATELIER: OperationIA = {
  nom: "enregistrer_document",
  module: "DRIVE",
  libelle: "Enregistrement préparé",
  description:
    "PRÉPARE l'enregistrement d'un document modifié dans l'Atelier : une NOUVELLE version dans le Drive (l'original reste ouvrable). "
    + "À n'appeler que si la personne le demande ; d'habitude, elle relit et appuie elle-même sur « Enregistrer ».",
  schema: { type: "object", properties: { document: { type: "string", description: "La référence de l'Atelier (rendue par ouvrir_dans_l_atelier)." } } },
  ouverte: (u) => Boolean(u.id),
  proposer,
  async executer(a, user) {
    if (!a.sessionId) return { ok: false, error: "Document introuvable." };
    const r = await enregistrerAtelier(user, a.sessionId);
    return r.ok
      ? { ok: true, message: `« ${a.nom ?? "Document"} » enregistré — version ${r.version}.`, link: r.nodeId ? `/drive/${r.nodeId}` : undefined }
      : { ok: false, error: r.motif ?? "L'enregistrement a échoué." };
  },
};

/** La carte, créée depuis le BOUTON de l'Atelier (document sensible). Rend l'intention à confirmer. */
export async function carteEnregistrement(user: CurrentUser, sessionId: string) {
  const p = await proposer({ document: sessionId }, user);
  if ("manque" in p) return { ok: false as const, erreur: p.manque.join(", ") };
  if ("erreur" in p) return { ok: false as const, erreur: p.erreur };
  const charge: ChargeOperationIA = { kind: "assistant_ia_op", op: ENREGISTRER_ATELIER.nom, args: p.args };
  const [intentId] = await persistActionIntents(user.id, [{
    kind: "assistant_ia_op", module: "DRIVE", title: p.carte.title, fields: p.carte.fields,
    ...(p.carte.level ? { level: p.carte.level } : {}), payload: charge,
  }], "text");
  if (!intentId) return { ok: false as const, erreur: "La carte n'a pas pu être préparée." };
  return {
    ok: true as const,
    intent: { id: intentId, kind: "assistant_ia_op", title: p.carte.title, fields: p.carte.fields, warnings: p.carte.warnings, libelleBouton: p.carte.libelleBouton, status: "PROPOSED" as const },
  };
}

export { documentSensible };

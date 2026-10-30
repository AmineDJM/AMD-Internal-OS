import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
// La porte du moteur des travaux (`../travaux`), chargée à l'appel : elle importe elle-même le registre des opérations.
const travaux = () => import("../travaux");
import { champs, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEMANDES REÇUES (J8, décision 0023) — le côté de la personne SOLLICITÉE par le travail d'un collègue.
 *
 *   mes_demandes_recues         ce qu'on lui demande : la question, les pièces attendues, les pièces partagées,
 *                               qui et pour quand — jamais le carnet ni le plan du travail de l'autre ;
 *   preparer_reponse_demande    sa réponse (texte + pièces de SON Drive), en CARTE : rien ne part sans son clic.
 *
 * Son assistant l'aide avec SES droits (ses lectures, son Drive) ; il ne parle jamais à l'assistant de l'autre.
 * La question est écrite par quelqu'un d'autre : sa sortie est un contenu NON FIABLE (`contenu-non-fiable.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const jour = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "Africa/Algiers" });
const idsDe = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/) : [])
  .map((x) => String(x).trim()).filter((x) => /^[a-z0-9]{10,40}$/i.test(x)).slice(0, 10);

export function lectureDemandesRecues(user: CurrentUser): PowerTool {
  return {
    def: {
      name: "mes_demandes_recues",
      description: "Les demandes que les TRAVAUX de collègues t'ont adressées (« Karim te demande le devis signé avant le 12 ») : identifiant, question, "
        + "pièces attendues, pièces qu'il t'a partagées (identifiants Drive), échéance. Pour aider l'utilisateur à y répondre avec `preparer_reponse_demande`.",
      input_schema: { type: "object", properties: {} },
    } as PowerTool["def"],
    allowed: (u) => u.id === user.id,
    label: "Demandes reçues consultées",
    run: async () => {
      const r = (await (await travaux()).listerDemandesRecues(user.id)).filter((d) => d.statut === "OUVERTE");
      return JSON.stringify({
        demandes: r.map((d) => ({
          id: d.id, de: d.de, question: d.question, piecesAttendues: d.piecesAttendues,
          piecesPartagees: d.piecesPartagees.map((p) => ({ id: p.nodeId, nom: p.nom })),
          echeance: jour(d.echeance), enRetard: d.enRetard,
        })),
        ...(r.length === 0 ? { note: "Aucune demande en attente de réponse." } : {}),
      });
    },
  };
}

export const REPONSE_DEMANDE: OperationIA = {
  nom: "preparer_reponse_demande",
  module: "ASSISTANT_IA",
  libelle: "Réponse à une demande préparée",
  description:
    "PRÉPARE la réponse de l'utilisateur à une DEMANDE reçue d'un collègue (`mes_demandes_recues`) : `demande` (son identifiant), `reponse` (le texte, "
    + "rédigé avec lui, sans rien inventer), `pieces` (identifiants Drive de SES pièces à joindre — partagées en lecture avec le demandeur). Une carte s'affiche : "
    + "rien ne part avant sa confirmation. Ne réponds jamais à sa place sans qu'il l'ait validé.",
  schema: {
    type: "object",
    properties: {
      demande: { type: "string", description: "L'identifiant de la demande (mes_demandes_recues)." },
      reponse: { type: "string" },
      pieces: { type: "array", items: { type: "string" }, description: "Identifiants Drive des pièces à joindre (ses fichiers)." },
    },
    required: ["demande"],
  },
  ouverte: (u) => Boolean(u.id),

  async proposer(e, user): Promise<PropositionOperation> {
    const id = texte(e, "demande");
    const reponse = texte(e, "reponse");
    const pieces = idsDe(e.pieces);
    if (!id) return { manque: ["la demande à laquelle répondre (son identifiant, via mes_demandes_recues)"] };
    const t = await travaux();
    const d = await t.lireDemandeRecue(id, user.id);
    if (!d) return { erreur: "Cette demande n'existe pas, ou elle ne vous est pas adressée." };
    if (d.statut !== "OUVERTE") return { erreur: "Cette demande n'attend plus de réponse." };
    if (!reponse && pieces.length === 0) return { manque: ["ce que vous répondez (ou les pièces à joindre)"] };
    const vues = await t.PIECES_TRAVAUX.visibles(user.id, pieces);
    if (vues.length !== pieces.length) return { erreur: "Une pièce à joindre n'existe pas, ou vous n'y avez pas accès dans votre Drive." };
    return {
      carte: {
        title: `Répondre à ${d.de}`,
        fields: champs([
          ["Demande", d.question.slice(0, 300)],
          ["Votre réponse", reponse || "(pièces seulement)"],
          ["Pièces jointes", vues.length ? vues.map((p) => p.nom).join(", ") : null],
          ["Échéance", jour(d.echeance)],
        ]),
        warnings: vues.length ? [`Les pièces jointes seront partagées EN LECTURE avec ${d.de}.`] : [],
        libelleBouton: "Envoyer la réponse",
      },
      args: { demande: id, reponse: reponse || null, pieces: vues.map((p) => p.nodeId).join(",") || null },
    };
  },

  async executer(a, user) {
    const t = await travaux();
    const r = await t.repondreDemande(a.demande ?? "", user.id, { texte: a.reponse ?? "", pieces: idsDe(a.pieces ?? "") }, t.PIECES_TRAVAUX);
    return r.ok ? { ok: true, message: r.message, link: "/assistant" } : { ok: false, error: r.erreur };
  },
};

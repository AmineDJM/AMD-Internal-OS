import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { annulerAttentes, ouvrirAttente } from "./reception";

/**
 * « ATTENDS, JE VAIS T'ENVOYER LA LETTRE » — l'outil `attendre_pieces` (lot K6, décision 0036).
 *
 * Le modèle l'appelle quand la personne ANNONCE une pièce (par WhatsApp ou par mail), ou quand il la lui DEMANDE. Il ouvre
 * une attente courte (48 h), liée à cette conversation et à la fiche visée — résolue sous les droits de la personne. Rien
 * n'est écrit dans l'ERP : à l'arrivée, la pièce va au Drive de la personne et le rangement passe par une carte.
 * La voix délègue au fil : un « je t'envoie la lettre » dit dans un appel arrive ici de la même façon.
 */
export const OUTIL_ATTENDRE_PIECES = "attendre_pieces";

export function outilAttendrePieces(user: CurrentUser, conversation: string | null, origine: "ECRIT" | "VOIX" = "ECRIT"): PowerTool {
  return {
    def: {
      name: OUTIL_ATTENDRE_PIECES,
      description:
        "Note qu'une PIÈCE va arriver par WhatsApp ou par mail (« je t'envoie la lettre », « je te transfère le devis »), ou que tu la "
        + "demandes à la personne. Décris-la en quelques mots et nomme la fiche visée (une demande Ad & Pro par sa référence ou son nom, "
        + "ou une autre fiche par type + identifiant) : à son arrivée, la pièce entrera dans cette conversation avec une carte de rangement. "
        + "`annuler: \"oui\"` retire les attentes ouvertes.",
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Ce qui est attendu, court : « lettre de demande du Dr Mansouri »." },
          canaux: { type: "string", description: "whatsapp, mail, ou les deux." },
          demande: { type: "string", description: "Demande Ad & Pro visée : référence (SP-…) ou nom." },
          natureDemande: { type: "string", description: "sponsoring, prise en charge, événement…" },
          typeFiche: { type: "string", description: "Hors Ad & Pro : type de la fiche (TASK, DOSSIER…)." },
          idFiche: { type: "string", description: "Hors Ad & Pro : identifiant de la fiche." },
          categorie: { type: "string", description: "Lettre de demande, Devis, Facture…" },
          annuler: { type: "string" },
        },
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Pièce attendue notée",
    run: async (entree) => {
      const t = (k: string) => (typeof entree[k] === "string" ? (entree[k] as string) : "");
      if (/^(oui|true|1)/i.test(t("annuler"))) {
        const n = await annulerAttentes(user.id);
        return JSON.stringify({ statut: "OK", annulees: n, consigne: "Dis-le en une phrase." });
      }
      const r = await ouvrirAttente(user, {
        description: t("description"), canaux: t("canaux"), demande: t("demande"), natureDemande: t("natureDemande"),
        typeFiche: t("typeFiche"), idFiche: t("idFiche"), categorie: t("categorie"), origine, conversation,
      });
      if ("manque" in r) return JSON.stringify({ statut: "INCOMPLET", manque: r.manque, consigne: "Pose UNE question courte pour le préciser." });
      if ("erreur" in r) return JSON.stringify({ statut: "REFUS", raison: r.erreur });
      return JSON.stringify({
        statut: "EN_ATTENTE",
        attendu: r.description,
        fiche: r.cibleLibelle,
        canaux: r.canaux.length ? r.canaux : ["WHATSAPP", "MAIL"],
        expire: r.expireLe.toISOString(),
        consigne: "Dis en une phrase que tu attends la pièce (et pour quelle fiche). À son arrivée, elle apparaîtra ici avec une carte de rangement : n'annonce rien de plus.",
      });
    },
  };
}

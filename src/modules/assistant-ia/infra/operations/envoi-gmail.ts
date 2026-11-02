import type { CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { boiteGmailAdam, enregistrerExecuteurGmail, envoyerGmail, freinGmail } from "@/lib/google/gmail/envoi";

// La boîte d'Adam lue par `mes_boites_mail` — par cette porte (une seule arête vers le domaine Google).
export { boiteGmailAdam };
import { texte, type OperationIA } from "../../domaine/operations/types";

/**
 * ENVOYER UN MAIL PAR LA BOÎTE GMAIL D'ADAM (lot P1, décision 0047) — la carte « Envoyer », puis la fenêtre d'annulation.
 * Mêmes portes que les outils Gmail d'Adam : la Direction et le Super Admin (`EXEC`), les freins anti-boucle
 * (`checkRateLimits`, sur les envois de la dernière heure). `envoyer_mail` choisit la boîte et le dit.
 */
const ADRESSE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const adresses = (v: string): string[] => v.split(/[,;\s]+/).map((x) => x.trim().replace(/^<|>$/g, "")).filter((x) => ADRESSE.test(x)).slice(0, 20);

export const ENVOI_GMAIL: OperationIA = {
  nom: "envoyer_gmail",
  module: "ASSISTANT_IA",
  libelle: "Mail Gmail préparé",
  description: "Prépare l'ENVOI d'un mail par la boîte Gmail d'Adam (carte « Envoyer », annulable pendant la fenêtre d'annulation). Préfère `envoyer_mail`, qui choisit la boîte.",
  schema: {
    type: "object",
    properties: {
      a: { type: "string", description: "Destinataire(s), adresses e-mail séparées par des virgules." },
      cc: { type: "string" },
      objet: { type: "string" },
      corps: { type: "string", description: "Le texte du mail, complet." },
    },
    required: ["a", "objet", "corps"],
  },
  // Les portes des outils Gmail d'Adam (`adam-tools/commun.ts EXEC`) : la Direction et le Super Admin.
  ouverte: (u: CurrentUser) => peutUtiliserAssistantIA(u) && (u.role === "SUPER_ADMIN" || u.role === "DIRECTION"),

  async proposer(entree) {
    const boite = await boiteGmailAdam();
    if (!boite) return { erreur: "La boîte Gmail d'Adam n'est pas reliée (Administration › Intégrations › Google)." };
    if (!boite.envoi) return { erreur: `La boîte Gmail d'Adam (${boite.address}) ne peut pas envoyer : ${boite.raison}.` };
    const a = adresses(texte(entree, "a"));
    const cc = adresses(texte(entree, "cc"));
    const objet = texte(entree, "objet").slice(0, 300);
    const corps = texte(entree, "corps").slice(0, 20_000);
    const manque = [...(a.length ? [] : ["l'adresse e-mail du destinataire"]), ...(objet ? [] : ["l'objet"]), ...(corps ? [] : ["le texte du mail"])];
    if (manque.length) return { manque };
    // Les freins anti-boucle d'Adam : pas deux fois le même destinataire en rafale.
    const frein = await freinGmail(a);
    if (frein) return { erreur: `Je ne prépare pas ce mail : ${frein}` };
    return {
      carte: {
        title: `Envoyer par le Gmail d'Adam (${boite.address})`,
        fields: [
          { label: "De", value: `${boite.address} (Gmail d'Adam)` },
          { label: "À", value: a.join(", ") },
          ...(cc.length ? [{ label: "Cc", value: cc.join(", ") }] : []),
          { label: "Objet", value: objet },
          { label: "Message", value: corps.length > 600 ? `${corps.slice(0, 600)}…` : corps },
        ],
        warnings: ["Fenêtre d'annulation : le mail attend le délai réglé (2 min par défaut) avant de partir — « Annuler l'envoi » dedans, rien ne part ; parti, un rectificatif peut suivre."],
        libelleBouton: "Envoyer",
      },
      args: { a: a.join(","), cc: cc.join(",") || null, objet, corps },
    };
  },

  async executer(args, user) {
    enregistrerExecuteurGmail();
    const message = { to: adresses(args.a ?? ""), cc: adresses(args.cc ?? ""), subject: args.objet ?? "(sans objet)", text: args.corps ?? "" };
    try {
      const r = await envoyerGmail(message);
      await recordAudit({ actorId: user.id, action: "CREATE", module: "Chief of Staff", summary: `Mail Gmail (Adam, ${r.address}) ${r.differe ? "programmé (fenêtre d'annulation)" : "envoyé"} à ${message.to.length} destinataire·s` });
      if (r.neutralise) return { ok: true, message: "Simulation : rien n'est parti." };
      return { ok: true, message: r.differe ? `Mail programmé par Gmail : il part à ${r.differe.executeLe.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" })} — « Annuler l'envoi » jusque-là.` : "Mail envoyé par le Gmail d'Adam." };
    } catch (e) {
      return { ok: false, error: `Envoi Gmail impossible : ${e instanceof Error ? e.message : String(e)}.` };
    }
  },
};

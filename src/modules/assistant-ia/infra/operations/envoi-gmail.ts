import type { CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { boiteGmailAdam, confirmerMailAdam, enregistrerExecuteurGmail, freinGmail, preparerMailAdam } from "@/lib/google/gmail/envoi";
import { texte, type OperationIA } from "../../domaine/operations/types";

// La boîte d'Adam lue par `mes_boites_mail`, et l'exécuteur armé là où l'on annule — par cette seule porte vers Google.
export { boiteGmailAdam, enregistrerExecuteurGmail };

/**
 * ENVOYER UN MAIL PAR LA BOÎTE GMAIL D'ADAM (lot P1, décision 0047) — la carte « Envoyer » (ou « Enregistrer le
 * brouillon »), puis la machine à états d'Adam (`lib/google/gmail/envoi.ts`) : intention préparée à la carte, approuvée
 * au nom de la personne qui confirme, envoyée à l'échéance de la fenêtre d'annulation. Mêmes droits que les outils Gmail
 * d'Adam (`EXEC` : Direction, Super Admin) et mêmes freins anti-boucle.
 */
const ADRESSE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const adresses = (v: string): string[] => v.split(/[,;\s]+/).map((x) => x.trim().replace(/^<|>$/g, "")).filter((x) => ADRESSE.test(x)).slice(0, 20);

export const ENVOI_GMAIL: OperationIA = {
  nom: "envoyer_gmail",
  module: "ASSISTANT_IA",
  libelle: "Mail d'Adam préparé",
  description: "Prépare l'ENVOI (ou le brouillon) d'un mail par la boîte Gmail d'Adam (carte à confirmer, annulable pendant la fenêtre d'annulation). Préfère `envoyer_mail`.",
  schema: {
    type: "object",
    properties: {
      a: { type: "string", description: "Destinataire(s), adresses e-mail séparées par des virgules." },
      cc: { type: "string" },
      objet: { type: "string" },
      corps: { type: "string", description: "Le texte du mail, complet." },
      brouillon: { type: "boolean", description: "Un brouillon (à l'écran d'Adam) au lieu d'un envoi — seulement sur demande." },
    },
    required: ["a", "objet", "corps"],
  },
  // Les portes des outils Gmail d'Adam (`adam-tools/commun.ts EXEC`) : la Direction et le Super Admin.
  ouverte: (u: CurrentUser) => peutUtiliserAssistantIA(u) && (u.role === "SUPER_ADMIN" || u.role === "DIRECTION"),

  async proposer(entree, user) {
    const boite = await boiteGmailAdam();
    if (!boite) return { erreur: "La boîte Gmail d'Adam n'est pas reliée (Chief of Staff › Réglages › « Connecter Google »)." };
    if (!boite.envoi) return { erreur: `La boîte Gmail d'Adam (${boite.address}) ne peut pas envoyer : ${boite.raison}.` };
    const a = adresses(texte(entree, "a"));
    const cc = adresses(texte(entree, "cc"));
    const objet = texte(entree, "objet").slice(0, 300);
    const corps = texte(entree, "corps").slice(0, 20_000);
    const brouillon = entree.brouillon === true;
    const manque = [...(a.length ? [] : ["l'adresse e-mail du destinataire"]), ...(objet ? [] : ["l'objet"]), ...(corps ? [] : ["le texte du mail"])];
    if (manque.length) return { manque };
    const frein = brouillon ? null : await freinGmail(a);
    if (frein) return { erreur: `Je ne prépare pas ce mail : ${frein}` };
    // L'INTENTION D'ADAM naît à la carte (préparée, jamais approuvée ici) : la même machine que son écran.
    const p = await preparerMailAdam({ to: a, cc, subject: objet, text: corps }, { id: user.id, name: user.name ?? user.email ?? user.id });
    return {
      carte: {
        title: brouillon ? `Brouillon dans le Gmail d'Adam (${p.address})` : `Envoyer par le Gmail d'Adam (${p.address})`,
        fields: [
          { label: "De", value: `${p.address} (Gmail d'Adam)` },
          { label: "À", value: a.join(", ") },
          ...(cc.length ? [{ label: "Cc", value: cc.join(", ") }] : []),
          { label: "Objet", value: objet },
          { label: "Message", value: corps.length > 600 ? `${corps.slice(0, 600)}…` : corps },
        ],
        warnings: brouillon
          ? ["Le brouillon attend à l'écran d'Adam (Chief of Staff) ; rien ne part."]
          : ["Fenêtre d'annulation : le mail attend le délai réglé (2 min par défaut) avant de partir — « Annuler l'envoi » dedans, rien ne part ; parti, un rectificatif peut suivre."],
        libelleBouton: brouillon ? "Enregistrer le brouillon" : "Envoyer",
      },
      args: { outboundId: p.outboundId, brouillon: brouillon ? "1" : null, destinataires: String(a.length) },
    };
  },

  async executer(args, user) {
    enregistrerExecuteurGmail();
    try {
      const r = await confirmerMailAdam(args.outboundId ?? "", user.id, { brouillon: args.brouillon === "1" });
      await recordAudit({
        actorId: user.id, action: "CREATE", module: "Chief of Staff",
        summary: `Mail d'Adam ${r.brouillon ? "laissé en brouillon" : r.differe ? "approuvé (fenêtre d'annulation)" : "envoyé"} — confirmé par la personne, ${args.destinataires ?? "?"} destinataire·s`,
      });
      if (r.neutralise) return { ok: true, message: "Simulation : rien n'est parti." };
      if (r.brouillon) return { ok: true, message: "Brouillon enregistré à l'écran d'Adam : rien n'est parti.", link: "/chief-of-staff" };
      return { ok: true, message: r.differe ? `Mail programmé par le Gmail d'Adam : il part à ${r.differe.executeLe.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" })} — « Annuler l'envoi » jusque-là.` : "Mail envoyé par le Gmail d'Adam." };
    } catch (e) {
      return { ok: false, error: `Envoi par le Gmail d'Adam impossible : ${e instanceof Error ? e.message : String(e)}.` };
    }
  },
};

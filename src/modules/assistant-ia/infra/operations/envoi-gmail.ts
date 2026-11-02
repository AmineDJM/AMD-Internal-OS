import type { CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { boiteGmailAdam, confirmerMailAdam, enregistrerExecuteurGmail, freinGmail, preparerMailAdam } from "@/lib/google/gmail/envoi";
import { texte, type OperationIA } from "../../domaine/operations/types";
import { lireContenuMail, rendreMailHtml, rendreMailTexte, type ContenuMail } from "../../domaine/mails/gabarit";
import { charteDuMail, resoudreDestinataire, signatureDe, type Destinataire } from "../mails/redaction";

// La boîte d'Adam lue par `mes_boites_mail`, et l'exécuteur armé là où l'on annule — par cette seule porte vers Google.
export { boiteGmailAdam, enregistrerExecuteurGmail };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DES MAILS PAR LA BOÎTE GMAIL D'ADAM (lot P1, décision 0047) — UNE carte pour un ou plusieurs mails (« envoie un mail à
 * Redouane et à Nesrine avec leur planning » → deux mails personnalisés, une confirmation).
 *
 *   • PEU DE QUESTIONS : les destinataires se résolvent par l'annuaire (`redaction.ts`) ; une question seulement si un nom
 *     est ambigu ou introuvable. Objet, ton, signature : choisis — la personne corrige sur la carte.
 *   • BEAUX MAILS : le modèle rend un CONTENU STRUCTURÉ ; le gabarit (`domaine/mails/gabarit.ts`) le met en page aux
 *     couleurs de la société d'envoi, avec la signature et la version texte. L'aperçu de la carte est ce rendu.
 *   • La MACHINE d'Adam : une intention d'envoi préparée par mail (`preparerMailAdam`), approuvée au nom de qui confirme,
 *     différée dans la fenêtre d'annulation. Droits des outils Gmail d'Adam (Direction, Super Admin) ; freins anti-boucle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const MAILS_MAX = 5;

const SCHEMA_CONTENU = {
  type: "object",
  description: "Le contenu STRUCTURÉ (jamais du HTML) : le gabarit le met en page. **gras** permis pour une échéance.",
  properties: {
    salutation: { type: "string", description: "« Bonjour Redouane, » (tutoiement entre collègues, vouvoiement pour l'extérieur)." },
    paragraphes: { type: "array", items: { type: "string" }, description: "Paragraphes courts (2 à 3 phrases)." },
    liste: { type: "array", items: { type: "string" }, description: "Points à puces (facultatif)." },
    tableau: { type: "object", properties: { colonnes: { type: "array", items: { type: "string" } }, lignes: { type: "array", items: { type: "array", items: { type: "string" } } } }, description: "Un tableau (dates, tâches) — facultatif." },
    apres: { type: "array", items: { type: "string" }, description: "Paragraphes après la liste ou le tableau (facultatif)." },
    cloture: { type: "string", description: "« Bonne semaine, », « Bien cordialement, »." },
  },
  required: ["salutation", "paragraphes", "cloture"],
};

export const SCHEMA_MAILS = {
  type: "array",
  description: "Un mail par destinataire quand le contenu est personnel (son planning) ; un seul mail à plusieurs sinon.",
  items: {
    type: "object",
    properties: {
      a: { type: "string", description: "Destinataire(s) : NOMS (résolus par l'annuaire) ou adresses, séparés par des virgules." },
      cc: { type: "string" },
      objet: { type: "string", description: "Un objet clair et précis, choisi par toi." },
      contenu: SCHEMA_CONTENU,
    },
    required: ["a", "objet", "contenu"],
  },
};

interface MailPrepare { destinataires: Destinataire[]; cc: Destinataire[]; objet: string; contenu: ContenuMail }

/** Résoudre et lire chaque mail : au plus UNE question (la première ambiguïté ou le premier nom introuvable). */
export async function preparerMails(brut: unknown, corpsSimple?: { a: string; objet: string; corps: string; cc?: string }): Promise<{ ok: true; mails: MailPrepare[] } | { manque: string[]; precision?: string }> {
  const liste = Array.isArray(brut) ? brut.slice(0, MAILS_MAX) : corpsSimple ? [{ a: corpsSimple.a, cc: corpsSimple.cc, objet: corpsSimple.objet, contenu: { salutation: "Bonjour,", paragraphes: corpsSimple.corps.split(/\n{2,}/), cloture: "Bien cordialement," } }] : [];
  if (!liste.length) return { manque: ["le destinataire et le contenu du mail"] };
  const mails: MailPrepare[] = [];
  for (const m of liste) {
    const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
    const resoudre = async (champ: string): Promise<Destinataire[] | { manque: string[]; precision?: string }> => {
      const out: Destinataire[] = [];
      for (const qui of texte(o, champ).split(/\s*[,;]\s*|\s+et\s+/).filter(Boolean).slice(0, 20)) {
        const r = await resoudreDestinataire(qui);
        if (r.ok) out.push(r.destinataire);
        else if ("ambigu" in r) return { manque: [`laquelle de ces personnes pour « ${qui} » : ${r.ambigu.join(" ; ")}`], precision: "Plusieurs personnes portent ce nom dans l'annuaire." };
        else return { manque: [`l'adresse e-mail de « ${r.inconnu} » (personne de ce nom dans l'annuaire)`] };
      }
      return out;
    };
    const a = await resoudre("a");
    if (!Array.isArray(a)) return a;
    if (!a.length) return { manque: ["le destinataire du mail"] };
    const cc = await resoudre("cc");
    if (!Array.isArray(cc)) return cc;
    const lu = lireContenuMail(o.contenu);
    if (!lu.ok) return { manque: lu.manque };
    const objet = texte(o, "objet").slice(0, 200);
    if (!objet) return { manque: ["l'objet du mail"] };
    mails.push({ destinataires: a, cc, objet, contenu: lu.contenu });
  }
  return { ok: true, mails };
}

export const ENVOI_GMAIL: OperationIA = {
  nom: "envoyer_gmail",
  module: "ASSISTANT_IA",
  libelle: "Mail d'Adam préparé",
  description: "Prépare l'ENVOI (ou le brouillon) de mails par la boîte Gmail d'Adam — une carte pour tous. Préfère `envoyer_mail`.",
  schema: {
    type: "object",
    properties: {
      mails: SCHEMA_MAILS,
      societe: { type: "string", description: "La société d'envoi (charte), si la demande la nomme." },
      brouillon: { type: "boolean", description: "Des brouillons (à l'écran d'Adam) au lieu d'envois — seulement sur demande." },
      a: { type: "string" }, objet: { type: "string" }, corps: { type: "string" }, cc: { type: "string" },
    },
  },
  // Les portes des outils Gmail d'Adam (`adam-tools/commun.ts EXEC`) : la Direction et le Super Admin.
  ouverte: (u: CurrentUser) => peutUtiliserAssistantIA(u) && (u.role === "SUPER_ADMIN" || u.role === "DIRECTION"),

  async proposer(entree, user) {
    const boite = await boiteGmailAdam();
    if (!boite) return { erreur: "La boîte Gmail d'Adam n'est pas reliée (Chief of Staff › Réglages › « Connecter Google »)." };
    if (!boite.envoi) return { erreur: `La boîte Gmail d'Adam (${boite.address}) ne peut pas envoyer : ${boite.raison}.` };
    const brouillon = entree.brouillon === true;
    const prep = await preparerMails(entree.mails, texte(entree, "corps") ? { a: texte(entree, "a"), objet: texte(entree, "objet"), corps: texte(entree, "corps"), cc: texte(entree, "cc") } : undefined);
    if (!("ok" in prep)) return prep;
    const tous = prep.mails.flatMap((m) => m.destinataires.map((d) => d.email));
    const frein = brouillon ? null : await freinGmail(tous);
    if (frein) return { erreur: `Je ne prépare pas ces mails : ${frein}` };
    const signature = await signatureDe(user);
    const charte = await charteDuMail(user, texte(entree, "societe") || null, signature);
    const ids: string[] = [];
    const apercus: { titre: string; html: string }[] = [];
    for (const m of prep.mails) {
      const html = rendreMailHtml(m.contenu, signature, charte, m.objet);
      const p = await preparerMailAdam({ to: m.destinataires.map((d) => d.email), cc: m.cc.map((d) => d.email), subject: m.objet, text: rendreMailTexte(m.contenu, signature, charte), html }, { id: user.id, name: user.name ?? user.email ?? user.id });
      ids.push(p.outboundId);
      apercus.push({ titre: `À ${m.destinataires.map((d) => d.nom ?? d.email).join(", ")} — « ${m.objet} »`, html });
    }
    const n = prep.mails.length;
    return {
      carte: {
        title: `${brouillon ? (n > 1 ? `${n} brouillons` : "Brouillon") : n > 1 ? `Envoyer ${n} mails` : "Envoyer"} par le Gmail d'Adam (${boite.address})`,
        fields: [
          { label: "De", value: `${boite.address} (Gmail d'Adam) — signé ${signature.nom}, ${charte.societe}` },
          ...prep.mails.map((m, i) => ({ label: n > 1 ? `Mail ${i + 1}` : "À", value: `${m.destinataires.map((d) => (d.nom ? `${d.nom} <${d.email}>` : d.email)).join(", ")} — « ${m.objet} »` })),
        ],
        warnings: brouillon
          ? ["Les brouillons attendent à l'écran d'Adam (Chief of Staff) ; rien ne part."]
          : ["Fenêtre d'annulation : chaque mail attend le délai réglé (2 min par défaut) avant de partir — « Annuler l'envoi » dedans, rien ne part ; parti, un rectificatif peut suivre."],
        libelleBouton: brouillon ? "Enregistrer le brouillon" : n > 1 ? `Envoyer les ${n} mails` : "Envoyer",
        apercus,
      },
      args: { outboundIds: JSON.stringify(ids), brouillon: brouillon ? "1" : null, destinataires: String(tous.length) },
    };
  },

  async executer(args, user) {
    enregistrerExecuteurGmail();
    const ids = (() => { try { return (JSON.parse(args.outboundIds ?? "[]") as unknown[]).map(String).slice(0, MAILS_MAX); } catch { return []; } })();
    if (!ids.length) return { ok: false, error: "Aucun mail à envoyer." };
    try {
      const rs = [];
      for (const id of ids) rs.push(await confirmerMailAdam(id, user.id, { brouillon: args.brouillon === "1" }));
      await recordAudit({
        actorId: user.id, action: "CREATE", module: "Chief of Staff",
        summary: `${ids.length} mail(s) d'Adam ${args.brouillon === "1" ? "laissé(s) en brouillon" : "approuvé(s) (fenêtre d'annulation)"} — confirmé(s) par la personne, ${args.destinataires ?? "?"} destinataire·s`,
      });
      if (rs.every((r) => r.neutralise)) return { ok: true, message: "Simulation : rien n'est parti." };
      if (rs.every((r) => r.brouillon)) return { ok: true, message: `${ids.length > 1 ? `${ids.length} brouillons enregistrés` : "Brouillon enregistré"} à l'écran d'Adam : rien n'est parti.`, link: "/chief-of-staff" };
      const d = rs.map((r) => r.differe).filter((x): x is NonNullable<typeof x> => !!x)[0];
      return { ok: true, message: d ? `${ids.length > 1 ? `${ids.length} mails programmés` : "Mail programmé"} par le Gmail d'Adam : départ à ${d.executeLe.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" })} — « Annuler l'envoi » jusque-là.` : "Envoyé par le Gmail d'Adam." };
    } catch (e) {
      return { ok: false, error: `Envoi par le Gmail d'Adam impossible : ${e instanceof Error ? e.message : String(e)}.` };
    }
  },
};
